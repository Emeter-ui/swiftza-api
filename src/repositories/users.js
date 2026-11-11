const { collection } = require('../services/mongo');
const base = require('./base');

const USERS = 'USERS';

// _id is the Firebase uid, so the identity provider and the database agree on
// the key without a lookup table.
async function findByUid(uid) {
  return base.byStringId(USERS, uid);
}

// Case-insensitive so "Vicky" and "vicky" resolve to the same account.
// Anchored to reject partial matches. The input is escaped so a "." in a
// username can't smuggle in a regex wildcard.
async function findByUsername(username) {
  if (!username) return null;
  const escaped = String(username).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return base.serializeDoc(
    await collection(USERS).findOne({ username: { $regex: `^${escaped}$`, $options: 'i' } })
  );
}

async function create(uid, doc) {
  await collection(USERS).insertOne({ ...doc, _id: String(uid), CreatedAt: new Date() });
}

async function update(uid, patch) {
  await base.updateStringId(USERS, uid, patch);
}

// Replaces getAllDoc('USERS').find(...), which downloaded every account to
// locate one document. Backed by the {account, setUpProcess} index.
async function findInstalledAdmin() {
  return base.serializeDoc(
    await collection(USERS).findOne({ account: 'ADMIN', setUpProcess: true })
  );
}

async function listAll(sort = '') {
  return base.all(USERS, sort);
}

module.exports = { findByUid, findByUsername, create, update, findInstalledAdmin, listAll };
