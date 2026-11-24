const { collection } = require('../services/mongo');
const { AppError } = require('../models/errors');
const fees = require('../models/fees');

const SETTINGS = 'SETTINGS';
const DOC_ID = 'funding-fees';
const INTENTS = 'FUNDINGINTENTS';

// One document holds the limits and every rule. A single document is what
// makes clash detection meaningful: the whole rule set is validated and
// written together, so two admins cannot each save a rule that is fine alone
// but overlaps the other's.
async function load() {
  const doc = await collection(SETTINGS).findOne({ _id: DOC_ID });
  return {
    settings: { ...fees.DEFAULT_SETTINGS, ...(doc?.settings || {}) },
    rules: Array.isArray(doc?.rules) ? doc.rules : [],
    version: doc?.version || 0,
    updatedAt: doc?.updatedAt || null,
    updatedBy: doc?.updatedBy || null,
  };
}

// Optimistic concurrency on `version`: a save built on a stale read is refused
// rather than silently discarding the other admin's change.
async function save({ settings, rules }, { expectedVersion, adminUid }) {
  const current = await load();
  if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== current.version) {
    throw new AppError(
      'FEE_CONFIG_STALE',
      'Someone else changed the fee setup while you were editing. Reload and apply your change again.',
      409,
      { currentVersion: current.version }
    );
  }
  const next = current.version + 1;
  const result = await collection(SETTINGS).updateOne(
    { _id: DOC_ID, ...(current.version ? { version: current.version } : { version: { $exists: false } }) },
    { $set: { settings, rules, version: next, updatedAt: new Date(), updatedBy: adminUid || null } },
    { upsert: true }
  ).catch((err) => {
    if (err && err.code === 11000) return { matchedCount: 0, upsertedCount: 0 };
    throw err;
  });
  if (!result.matchedCount && !result.upsertedCount) {
    throw new AppError('FEE_CONFIG_STALE', 'The fee setup changed while saving. Reload and try again.', 409);
  }
  return load();
}

async function createIntent(doc) {
  await collection(INTENTS).insertOne({ ...doc, status: 'pending', CreatedAt: new Date() });
}

const findIntent = (reference) => collection(INTENTS).findOne({ _id: String(reference) });

async function markIntent(reference, patch) {
  await collection(INTENTS).updateOne({ _id: String(reference) }, { $set: { ...patch, updatedAt: new Date() } });
}

module.exports = { load, save, createIntent, findIntent, markIntent, DOC_ID, INTENTS };
