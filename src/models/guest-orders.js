const crypto = require('crypto');
const { collection } = require('../services/mongo');
const users = require('../repositories/users');
const { finance } = require('./finance');
const buy = require('./buy');
const fees = require('./fees');
const feeRepo = require('../repositories/fees');
const aiSettings = require('../repositories/ai-settings');
const { paystackReference } = require('./reference');
const { request, OK } = require('./http');
const { paystack } = require('../config/env');
const { AppError, validationFailed } = require('./errors');
const logger = require('../services/logger');

// Guest quick buy: someone without an account pays for one bill by card.
//
// Each order gets its own temporary account (a USERS row with account
// 'GUEST' that can never sign in). Paystack's money is credited to that
// temporary wallet as exactly the bill price, and the purchase then runs
// through models/buy.js like any other, so charging, settling, reversing and
// holding behave identically. If the bill fails, the money (back in the
// temporary wallet) is taken out of it and refunded to the card through
// Paystack. Nothing is ever left for the guest to spend later.
//
// The browser's verify call and Paystack's webhook can both arrive; whichever
// is first claims the order (awaiting_payment -> processing) and the other
// sees it already handled.

const ORDERS = 'GUESTORDERS';
const PREFIX = 'SWZG-';
const SERVICES = ['airtime', 'data', 'cable', 'electricity', 'exam'];
const STATUS = Object.freeze({
  AWAITING: 'awaiting_payment',
  PROCESSING: 'processing',
  DELIVERED: 'delivered',
  HELD: 'held', // provider never confirmed: in the requery queue
  REFUNDED: 'refunded',
  REFUND_FAILED: 'refund_failed', // the bill failed and Paystack refused the refund; staff retry
});
// The only fields each service reads, so nothing else is stored or passed on.
const FIELDS = {
  data: ['network', 'planId', 'phone'],
  airtime: ['network', 'amount', 'phone'],
  cable: ['provider', 'planId', 'smartcard'],
  electricity: ['disco', 'meterType', 'meter', 'amount', 'phone'],
  exam: ['examId', 'quantity'],
};
const NUMERIC = new Set(['amount', 'quantity']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const isGuestReference = (ref) => String(ref || '').startsWith(PREFIX);
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG')}`;

function pickDetails(service, body) {
  const out = {};
  for (const f of FIELDS[service]) {
    const v = body?.[f];
    if (v === undefined || v === null || v === '') continue;
    out[f] = NUMERIC.has(f) ? Number(v) : String(v).trim().slice(0, 60);
  }
  return out;
}

function checkGuest(guest) {
  const name = String(guest?.name ?? '').trim().replace(/\s+/g, ' ');
  const email = String(guest?.email ?? '').trim().toLowerCase();
  if (name.length < 2 || name.length > 60) throw validationFailed('Enter your name');
  if (!EMAIL.test(email) || email.length > 120) throw validationFailed('Enter a valid email address for your receipt');
  const guestId = /^[A-Za-z0-9_-]{8,64}$/.test(String(guest?.guestId || '')) ? String(guest.guestId) : null;
  return { name, email, guestId };
}

async function settingsOrThrow() {
  const s = await aiSettings.load();
  if (!s.guestQuickBuyEnabled) {
    throw new AppError('GUEST_BUY_OFF', 'Quick buy is not available right now. Create a free account to pay bills.', 403);
  }
  return s;
}

// The card fee, from the same rules as wallet top-ups, always added on top:
// the bill must be delivered in full.
async function cardFeeKobo(price) {
  const config = await feeRepo.load().catch(() => null);
  if (!config) return 0;
  try {
    return Math.round(Number(fees.quote(config, { amount: price, method: 'card' }).totalFee || 0) * 100);
  } catch (err) {
    // Outside the top-up limits no rule applies; the order itself is still valid.
    logger.warn({ price, err: err.message }, 'guest order: no card fee rule for this amount');
    return 0;
  }
}

async function priced(service, body) {
  if (!SERVICES.includes(service)) throw validationFailed('Choose what to buy');
  const details = pickDetails(service, body);
  const p = await buy.price(service, details);
  const feeKobo = await cardFeeKobo(p.price);
  return { details, ...p, feeKobo, chargeKobo: p.price * 100 + feeKobo };
}

/** What a guest would pay, without creating anything. */
async function quote({ service, details }) {
  const s = await settingsOrThrow();
  const q = await priced(service, details);
  if (q.price > s.guestMaxOrder) {
    throw new AppError('GUEST_LIMIT', `Guest orders are limited to ${naira(s.guestMaxOrder)}. Create a free account for bigger payments.`, 422);
  }
  return { label: q.label, price: q.price, fee: q.feeKobo / 100, charge: q.chargeKobo / 100 };
}

async function create({ guest, service, details, ip = null }) {
  const s = await settingsOrThrow();
  const who = checkGuest(guest);
  const q = await priced(service, details);
  if (q.price > s.guestMaxOrder) {
    throw new AppError('GUEST_LIMIT', `Guest orders are limited to ${naira(s.guestMaxOrder)}. Create a free account for bigger payments.`, 422);
  }
  // Paid orders only: an abandoned checkout does not use up the allowance.
  const since = new Date(Date.now() - DAY_MS);
  const [spent] = await collection(ORDERS).aggregate([
    { $match: { 'guest.email': who.email, createdAt: { $gte: since }, status: { $nin: [STATUS.AWAITING, STATUS.REFUNDED] } } },
    { $group: { _id: null, total: { $sum: '$price' } } },
  ]).toArray();
  if ((spent?.total || 0) + q.price > s.guestDailyLimitPerEmail) {
    throw new AppError('GUEST_LIMIT', `Guest payments are limited to ${naira(s.guestDailyLimitPerEmail)} a day. Create a free account to keep going.`, 422);
  }

  const reference = `${PREFIX}${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const token = crypto.randomBytes(18).toString('base64url');
  const now = new Date();
  await collection(ORDERS).insertOne({
    _id: reference,
    status: STATUS.AWAITING,
    service,
    details: q.details,
    label: q.label,
    recipient: q.recipient,
    price: q.price,
    feeKobo: q.feeKobo,
    chargeKobo: q.chargeKobo,
    guest: who,
    // The temporary wallet this order (and only this order) uses.
    tempUid: `guest_${crypto.randomBytes(10).toString('hex')}`,
    tokenHash: hash(token),
    ip,
    createdAt: now,
    updatedAt: now,
  });
  return { reference, token, chargeKobo: q.chargeKobo, charge: q.chargeKobo / 100, price: q.price, fee: q.feeKobo / 100, email: who.email, label: q.label };
}

async function find(reference) {
  return isGuestReference(reference) ? collection(ORDERS).findOne({ _id: String(reference) }) : null;
}

function tokenMatches(order, token) {
  if (!order || typeof token !== 'string' || !token) return false;
  const a = Buffer.from(hash(token), 'hex');
  const b = Buffer.from(order.tokenHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// What the guest's private link shows. No temporary account id, no IP.
function publicView(order) {
  return {
    reference: order._id,
    status: order.status,
    service: order.service,
    label: order.label,
    recipient: order.recipient,
    price: order.price,
    fee: order.feeKobo / 100,
    charge: order.chargeKobo / 100,
    message: order.message || null,
    token: order.token || null,
    pins: order.pins || [],
    refunded: order.refundedKobo ? order.refundedKobo / 100 : null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

async function update(reference, patch) {
  await collection(ORDERS).updateOne({ _id: reference }, { $set: { ...patch, updatedAt: new Date() } });
}

async function ensureTempUser(order) {
  if (await users.findByUid(order.tempUid)) return;
  await users.create(order.tempUid, {
    fullname: order.guest.name,
    email: null, // Never an email: this account must not look like a real customer's.
    guestEmail: order.guest.email,
    guestOrder: order._id,
    account: 'GUEST',
    balance: 0,
    bonusBalance: 0,
  });
}

// Empties the temporary wallet (so the money cannot be both refunded and
// spent), then asks Paystack to return what the guest paid.
async function refund(order, { reason }) {
  const transref = `grf_${order._id}`;
  const balance = await finance.getBalance(order.tempUid).catch(() => 0);
  if (balance > 0) {
    try {
      await finance.reserveFunds({ uid: order.tempUid, amount: balance, transref, channel: 'GuestRefund', createdAt: new Date().toISOString() });
      await finance.settle({ transref });
    } catch (err) {
      if (err.code !== 'DUPLICATE_TRANSACTION') throw err; // already taken out by an earlier attempt
    }
  }
  const amountKobo = Number(order.paidKobo) || order.chargeKobo;
  const res = await request(`${paystack.baseUrl}/refund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${paystack.secretKey()}` },
    body: { transaction: order._id, amount: amountKobo },
  });
  if (res.outcome === OK && res.body?.status !== false) {
    await update(order._id, { status: STATUS.REFUNDED, refundedKobo: amountKobo, refundReason: reason, refundedAt: new Date() });
  } else {
    logger.error({ reference: order._id, reason: res.reason, body: res.body }, 'guest order refund failed');
    await update(order._id, {
      status: STATUS.REFUND_FAILED,
      refundReason: reason,
      refundError: String(res.body?.message || res.reason || 'refund failed').slice(0, 300),
    });
  }
  return find(order._id);
}

/**
 * Runs a paid order. `data` is Paystack's transaction object, from the
 * signed webhook or from the verify API. Safe to call more than once.
 */
async function fulfil(reference, data, source) {
  const paidKobo = Math.round(Number(data?.amount));
  const claimed = await collection(ORDERS).findOneAndUpdate(
    { _id: String(reference), status: STATUS.AWAITING },
    { $set: { status: STATUS.PROCESSING, paidKobo, paidAt: data?.paidAt ?? data?.paid_at ?? new Date(), paidChannel: data?.channel ?? null, claimedBy: source, updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!claimed) return find(reference); // Already handled, or not ours.
  const order = claimed;

  if (!Number.isFinite(paidKobo) || paidKobo < order.chargeKobo || (data?.currency && data.currency !== 'NGN')) {
    logger.warn({ reference, paidKobo, expected: order.chargeKobo }, 'guest order underpaid');
    await update(reference, { message: 'The amount paid did not match the order.' });
    return refund(order, { reason: 'underpaid' });
  }

  try {
    await ensureTempUser(order);
    await finance.creditWallet({
      uid: order.tempUid,
      amount: order.price,
      transref: paystackReference(reference),
      meta: { channel: 'GuestOrder', source, paystackReference: reference, guestOrder: reference, grossPaid: paidKobo / 100, totalFee: (paidKobo / 100) - order.price, email: order.guest.email },
    });
  } catch (err) {
    // Nothing was bought; give the money back.
    logger.error({ reference, err: err.message }, 'guest order credit failed');
    await update(reference, { message: 'We could not start your order.' });
    return refund(order, { reason: `credit-failed: ${err.message}` });
  }

  let result;
  try {
    result = await buy.BUYERS[order.service](order.tempUid, order.details);
  } catch (err) {
    // Refused before or during the purchase (a plan switched off, a provider
    // down). execute() has already put the money back in the temp wallet.
    result = { status: 'error', msg: err.message };
  }

  if (result.status === 'success') {
    await update(reference, { status: STATUS.DELIVERED, purchaseRef: result.reference, message: result.msg || null, token: result.token || null, pins: result.pins || [] });
  } else if (result.status === 'pending') {
    await update(reference, { status: STATUS.HELD, purchaseRef: result.reference, message: 'The provider has not confirmed this yet. We will deliver it or refund your card.' });
  } else {
    await update(reference, { purchaseRef: result.reference || null, message: String(result.msg || 'The provider could not complete this order.').replace(/ Your wallet has been refunded\.?$/, '') });
    return refund(await find(reference), { reason: 'purchase-failed' });
  }
  return find(reference);
}

/** The guest's browser, after Paystack's popup says it was paid. */
async function verify(reference, token) {
  const order = await find(reference);
  if (!tokenMatches(order, token)) throw new AppError('NOT_FOUND', 'Order not found', 404);
  if (order.status !== STATUS.AWAITING) return publicView(order);

  const res = await request(`${paystack.baseUrl}/transaction/verify/${encodeURIComponent(order._id)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${paystack.secretKey()}` },
  });
  if (res.outcome !== OK) throw new AppError('PROVIDER_UNAVAILABLE', "We couldn't reach Paystack. We'll keep checking; try again in a moment.", 503);
  const data = res.body?.data;
  if (!data || data.status !== 'success' || String(data.reference) !== order._id) return publicView(order);
  return publicView(await fulfil(order._id, data, 'verify'));
}

async function status(reference, token) {
  const order = await find(reference);
  if (!tokenMatches(order, token)) throw new AppError('NOT_FOUND', 'Order not found', 404);
  return publicView(order);
}

// Called after staff resolve a held purchase in the requery queue.
async function afterRequery(purchaseRef, resolved) {
  const order = await collection(ORDERS).findOne({ purchaseRef: String(purchaseRef), status: STATUS.HELD });
  if (!order) return null;
  if (resolved === 'success') {
    await update(order._id, { status: STATUS.DELIVERED, message: 'Confirmed by the provider.' });
    return find(order._id);
  }
  return refund(order, { reason: 'requery-reversed' });
}

/** Staff retry for a refund Paystack refused. */
async function retryRefund(reference) {
  const order = await find(reference);
  if (!order) throw new AppError('NOT_FOUND', 'Order not found', 404);
  if (order.status !== STATUS.REFUND_FAILED) throw validationFailed(`Only a failed refund can be retried (this order is ${order.status})`);
  return refund(order, { reason: order.refundReason || 'retry' });
}

module.exports = {
  quote, create, verify, status, fulfil, afterRequery, retryRefund, publicView, find,
  isGuestReference, STATUS, ORDERS, PREFIX, SERVICES,
};
