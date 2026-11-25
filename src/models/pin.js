const crypto = require('crypto');
const { promisify } = require('util');
const { collection, isDuplicateKey } = require('../services/mongo');
const { notify } = require('./notifications');
const { AppError, validationFailed } = require('./errors');

const scrypt = promisify(crypto.scrypt);

// Kept out of USERS on purpose: /userData returns that document, and signup and
// /store/update write caller-supplied fields to it.
const PINS = 'USERPINS';
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

const hashPin = async (pin, salt) => (await scrypt(pin, Buffer.from(salt, 'hex'), 32)).toString('hex');

function assertFormat(pin) {
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    throw validationFailed('Enter a 4-digit transaction PIN');
  }
}

async function credentials(pin) {
  assertFormat(pin);
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: await hashPin(pin, salt), fails: 0, lockedUntil: null, updatedAt: new Date() };
}

const hasPin = async (uid) =>
  Boolean(await collection(PINS).findOne({ _id: String(uid) }, { projection: { _id: 1 } }));

async function create(uid, pin) {
  const doc = await credentials(pin);
  try {
    await collection(PINS).insertOne({ _id: String(uid), ...doc });
  } catch (err) {
    if (isDuplicateKey(err)) throw new AppError('PIN_EXISTS', 'You already have a transaction PIN', 409);
    throw err;
  }
}

async function replace(uid, pin) {
  await collection(PINS).updateOne({ _id: String(uid) }, { $set: await credentials(pin) }, { upsert: true });
}

// The attempt is counted atomically BEFORE the hash is compared, so parallel
// guesses cannot slip past the limit.
async function verify(uid, pin) {
  const _id = String(uid);
  if (!(await hasPin(_id))) throw new AppError('PIN_NOT_SET', 'Create a transaction PIN first', 403);
  assertFormat(pin);

  const now = new Date();
  const fails = {
    $add: [{ $cond: [{ $and: [{ $ne: ['$lockedUntil', null] }, { $lte: ['$lockedUntil', now] }] }, 0, '$fails'] }, 1],
  };
  const doc = await collection(PINS).findOneAndUpdate(
    { _id, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
    [
      { $set: { fails } },
      { $set: { lockedUntil: { $cond: [{ $gte: ['$fails', MAX_ATTEMPTS] }, new Date(now.getTime() + LOCK_MS), null] } } },
    ],
    { returnDocument: 'after' }
  );
  if (!doc) throw new AppError('PIN_LOCKED', 'Too many wrong PINs. Try again in 15 minutes or reset your PIN.', 423);

  const given = Buffer.from(await hashPin(pin, doc.salt), 'hex');
  if (!crypto.timingSafeEqual(given, Buffer.from(doc.hash, 'hex'))) {
    const left = MAX_ATTEMPTS - doc.fails;
    if (left <= 0) await notify(_id, { title: 'PIN locked', body: 'Too many wrong PINs were entered. Payments are locked for 15 minutes.' });
    throw new AppError(
      'INVALID_PIN',
      left > 0 ? `Incorrect PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Incorrect PIN. Locked for 15 minutes.',
      403
    );
  }
  // Scoped to the verified hash so a concurrent PIN change is not disturbed.
  await collection(PINS).updateOne({ _id, hash: doc.hash }, { $set: { fails: 0, lockedUntil: null } });
}

module.exports = { hasPin, create, replace, verify, assertFormat, MAX_ATTEMPTS };
