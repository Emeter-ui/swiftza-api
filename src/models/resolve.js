const catalogRepo = require('../repositories/catalog');
const { validationFailed } = require('./errors');

// The new contract is name-based where the old one was id-based: samzeenuxt
// sends network: "MTN", provider: "DStv", disco: "Ikeja Electric", while the
// provider adapters need numeric ids. Matching is case-insensitive and trimmed
// because buy-data.vue's hardcoded list ("MTN", "9mobile") does not match the
// stored casing ("Mtn", "9MOBILE").
const key = (value) => String(value ?? '').trim().toLowerCase();

async function resolveByName(collection, nameField, idField, value, label) {
  const wanted = key(value);
  if (!wanted) throw validationFailed(`${label} is required`);

  const rows = await catalogRepo.list(collection);
  const match = rows.find((row) => key(row[nameField]) === wanted);

  if (!match) throw validationFailed(`Unknown ${label}`, { [label]: value });
  if (match.active === false) {
    throw validationFailed(`This ${label} is currently unavailable`);
  }
  // No provider-id check here: a row may carry only one provider's id, and
  // prepare() (via providers/ids.js) refuses a row missing the routed
  // provider's column before any funds are reserved.

  return { providerId: match[idField], doc: match };
}

const resolveNetwork = (name) => resolveByName('NETWORKS', 'name', 'id', name, 'network');
const resolveCable = (name) => resolveByName('CABLES', 'CableName', 'CableID', name, 'cable provider');
const resolveDisco = (name) => resolveByName('ELECTRICITY', 'Disconame', 'DiscoID', name, 'disco');

// The legacy samzeedatas contract is id-based, not name-based: it already
// sends an internal numeric id (network_id, cableID, DiscoID) with no display
// name to look up. This re-attaches the catalog doc for that id so
// serviceIdFor can read whichever provider column the active provider needs.
async function resolveById(collection, idField, value, label) {
  if (value === undefined || value === null || value === '') {
    throw validationFailed(`${label} is required`);
  }
  // Mirrors models/catalog.js's queryOne: MongoDB interprets a plain object as
  // query operators, so anything but a scalar must be rejected before it can
  // resolve an arbitrary row.
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
    throw validationFailed(`${label} is invalid`);
  }

  const doc = await catalogRepo.findOne(collection, idField, value);
  if (!doc) throw validationFailed(`Unknown ${label}`, { [label]: value });
  if (doc.active === false) {
    throw validationFailed(`This ${label} is currently unavailable`);
  }

  return { doc };
}

const resolveNetworkById = (id) => resolveById('NETWORKS', 'id', id, 'network');
const resolveCableById = (id) => resolveById('CABLES', 'CableID', id, 'cable provider');
const resolveDiscoById = (id) => resolveById('ELECTRICITY', 'DiscoID', id, 'disco');

module.exports = {
  resolveNetwork, resolveCable, resolveDisco,
  resolveNetworkById, resolveCableById, resolveDiscoById,
};
