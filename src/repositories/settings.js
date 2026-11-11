const { collection } = require('../services/mongo');
const base = require('./base');

const SETTINGS = 'SETTINGS';

const get = (id) => base.byStringId(SETTINGS, id);

// Unreferenced for now: nothing in src/ writes SETTINGS/providers yet. This is
// the deliberate seam for the admin provider-settings endpoint of a later
// phase -- not dead code, do not delete.
async function set(id, patch) {
  await collection(SETTINGS).updateOne(
    { _id: String(id) },
    { $set: patch },
    { upsert: true }
  );
}

module.exports = { get, set };
