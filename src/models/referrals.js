const crypto = require('crypto');
const { collection, inTransaction, isDuplicateKey } = require('../services/mongo');
const settingsRepo = require('../repositories/settings');
const { notify } = require('./notifications');
const { AppError, validationFailed } = require('./errors');
const logger = require('../services/logger');

// Invite friends, earn a reward.
//
// Every customer has a short code. A new account that signs up with it is
// linked to the referrer (USERS.referredBy). When that new customer's first
// successful purchase of at least `minQualifyingAmount` settles, the referrer
// is credited `referrerReward` (and the new customer `refereeReward`, if set)
// -- once, inside one transaction, idempotent on the wallet row ids.
//
// Guards against farming rewards with throwaway accounts: no self-referral
// (same account or same phone), a minimum qualifying purchase, and a monthly
// cap per referrer. Everything is adjustable by an admin.

const USERS = 'USERS';
const WALLET = 'WALLETTRANSACTIONS';
const SETTINGS_ID = 'referrals';
const MODE = 'referral-credit';

const DEFAULTS = Object.freeze({
  enabled: true,
  referrerReward: 500,
  refereeReward: 0,
  minQualifyingAmount: 500,
  maxRewardsPerMonth: 20,
});

// No 0/O or 1/I, so a code read aloud or copied by hand still works.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PATTERN = /^[A-Z0-9]{4,12}$/;
const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG')}`;
const firstName = (u) => String(u?.fullname || u?.username || 'A friend').trim().split(/\s+/)[0];

async function loadSettings() {
  const stored = await settingsRepo.get(SETTINGS_ID).catch(() => null);
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (stored && stored[k] !== undefined) out[k] = stored[k];
  return out;
}

function validateSettings(patch) {
  const next = {};
  const problems = [];
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
  const num = (k, min, max) => {
    if (patch[k] === undefined) return;
    const v = Number(patch[k]);
    if (!Number.isInteger(v) || v < min || v > max) problems.push({ field: k, message: `Must be a whole number between ${min} and ${max}` });
    else next[k] = v;
  };
  num('referrerReward', 0, 50000);
  num('refereeReward', 0, 50000);
  num('minQualifyingAmount', 0, 1000000);
  num('maxRewardsPerMonth', 0, 1000);
  if (problems.length) throw validationFailed(problems[0].message, { problems });
  return next;
}

async function saveSettings(patch) {
  await settingsRepo.set(SETTINGS_ID, validateSettings(patch || {}));
  return loadSettings();
}

const normalizeCode = (code) => String(code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

function newCode() {
  const bytes = crypto.randomBytes(7);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** The customer's code, created the first time it is asked for. */
async function codeFor(uid) {
  const id = String(uid);
  for (let attempt = 0; attempt < 5; attempt++) {
    const user = await collection(USERS).findOne({ _id: id }, { projection: { referralCode: 1 } });
    if (!user) throw new AppError('USER_NOT_FOUND', 'User account not found', 404);
    if (user.referralCode) return user.referralCode;
    try {
      // Only set if still unset, so two first requests agree on one code.
      await collection(USERS).updateOne({ _id: id, referralCode: { $exists: false } }, { $set: { referralCode: newCode() } });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err; // another account has that code; try another
    }
  }
  throw new AppError('INTERNAL_ERROR', 'Could not create a referral code. Please try again.', 500);
}

/**
 * Checks a code typed at signup, before the account exists. Returns the
 * referrer, null for no code, or throws for a bad one so the customer can fix
 * it. `quiet` (Google sign-up) ignores a bad code instead of failing.
 */
async function resolveForSignup(rawCode, { phone = null, quiet = false } = {}) {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  const settings = await loadSettings();
  if (!settings.enabled) return null;
  const fail = (msg) => { if (quiet) return null; throw new AppError('INVALID_REFERRAL', msg, 422); };
  if (!CODE_PATTERN.test(code)) return fail("That referral code isn't valid. Check it, or leave it empty.");
  const referrer = await collection(USERS).findOne({ referralCode: code, account: 'USER' }, { projection: { fullname: 1, phone: 1 } });
  if (!referrer) return fail("That referral code isn't valid. Check it, or leave it empty.");
  const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);
  if (phone && referrer.phone && digits(phone) === digits(referrer.phone)) return fail("You can't use your own referral code.");
  return { uid: String(referrer._id), code };
}

/** After the new account is saved: tell the referrer a friend joined. */
async function announceJoin(referrer, newUser) {
  if (!referrer) return;
  const settings = await loadSettings();
  await notify(referrer.uid, {
    type: 'referral',
    title: `${firstName(newUser)} just joined Swiftza`,
    body: `Using your referral link 🎉 Your ${naira(settings.referrerReward)} reward unlocks after their first payment.`,
  });
}

function rewardRow(user, { amount, transref, role, refereeUid }) {
  const prevBal = Number(user.balance) || 0;
  return {
    prevBal,
    newBal: prevBal + amount,
    row: {
      _id: transref, uid: String(user._id), email: user.email ?? null, channel: 'Referral', amount, transref,
      prevBal, newBal: prevBal + amount, status: 'success', validate: true, mode: MODE, role, refereeUid, CreatedAt: new Date(),
    },
  };
}

/**
 * Called after any purchase settles. Pays the referral reward the first
 * time a referred customer's purchase qualifies. Never throws: a reward
 * problem must not affect the purchase that triggered it.
 */
async function onPurchaseSuccess(uid, amount) {
  try {
    const settings = await loadSettings();
    if (!settings.enabled || Number(amount) < settings.minQualifyingAmount) return null;
    const user = await collection(USERS).findOne({ _id: String(uid) }, { projection: { referredBy: 1, referralRewardedAt: 1 } });
    if (!user?.referredBy || user.referralRewardedAt) return null;
    const referrerUid = String(user.referredBy);

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recent = await collection(WALLET).countDocuments({ uid: referrerUid, mode: MODE, role: 'referrer', CreatedAt: { $gte: since } });
    if (recent >= settings.maxRewardsPerMonth) {
      await collection(USERS).updateOne({ _id: String(uid), referralRewardedAt: { $exists: false } }, { $set: { referralRewardedAt: new Date(), referralSkipped: 'monthly-cap' } });
      return null;
    }

    const paid = await inTransaction(async (session) => {
      // The claim is the guard: only one settle, ever, pays this referral.
      const claim = await collection(USERS).updateOne(
        { _id: String(uid), referredBy: { $exists: true }, referralRewardedAt: { $exists: false } },
        { $set: { referralRewardedAt: new Date() } },
        { session }
      );
      if (!claim.modifiedCount) return null;
      const out = {};
      const credit = async (who, value, role) => {
        if (!(value > 0)) return;
        const account = await collection(USERS).findOne({ _id: who }, { session });
        if (!account) return;
        const { newBal, row } = rewardRow(account, { amount: value, transref: `rwd_${uid}_${role}`, role, refereeUid: String(uid) });
        await collection(USERS).updateOne({ _id: who }, { $set: { balance: newBal } }, { session });
        await collection(WALLET).insertOne(row, { session });
        out[role] = value;
      };
      await credit(referrerUid, settings.referrerReward, 'referrer');
      await credit(String(uid), settings.refereeReward, 'referee');
      return out;
    });
    if (!paid) return null;

    if (paid.referrer) {
      const friend = await collection(USERS).findOne({ _id: String(uid) }, { projection: { fullname: 1, username: 1 } });
      await notify(referrerUid, { type: 'reward', title: 'Reward added!', body: `+${naira(paid.referrer)} for inviting ${firstName(friend)}. It's in your wallet.` });
    }
    if (paid.referee) await notify(String(uid), { type: 'reward', title: 'Welcome reward added!', body: `+${naira(paid.referee)} for joining with a friend's link.` });
    return paid;
  } catch (err) {
    if (!isDuplicateKey(err)) logger.error({ uid: String(uid), err: err.message }, 'referral reward failed');
    return null;
  }
}

/** What the Invite friends screen shows. */
async function summary(uid) {
  const id = String(uid);
  const settings = await loadSettings();
  if (!settings.enabled) return { enabled: false };
  const [code, friends, rewards] = await Promise.all([
    codeFor(id),
    collection(USERS).find({ referredBy: id }, { projection: { fullname: 1, username: 1, CreatedAt: 1, referralRewardedAt: 1, referralSkipped: 1 } }).sort({ CreatedAt: -1 }).limit(50).toArray(),
    collection(WALLET).find({ uid: id, mode: MODE }).sort({ CreatedAt: -1 }).limit(200).toArray(),
  ]);
  const referred = await collection(USERS).countDocuments({ referredBy: id });
  const earned = rewards.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  return {
    enabled: true,
    code,
    referrerReward: settings.referrerReward,
    refereeReward: settings.refereeReward,
    minQualifyingAmount: settings.minQualifyingAmount,
    referred,
    rewarded: rewards.filter((r) => r.role === 'referrer').length,
    earned,
    latestReward: rewards[0] ? { amount: rewards[0].amount, at: rewards[0].CreatedAt, role: rewards[0].role } : null,
    // First names only: a referrer sees who joined, nothing more.
    friends: friends.map((f) => ({
      name: firstName(f),
      joinedAt: f.CreatedAt || null,
      status: f.referralRewardedAt ? (f.referralSkipped ? 'not-eligible' : 'rewarded') : 'waiting',
    })),
  };
}

module.exports = {
  loadSettings, saveSettings, codeFor, resolveForSignup, announceJoin, onPurchaseSuccess, summary,
  normalizeCode, DEFAULTS, MODE,
};
