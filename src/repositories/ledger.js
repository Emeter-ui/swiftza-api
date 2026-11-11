const base = require('./base');

const listAll = (name, sort = '') => base.all(name, sort);

// WALLETTRANSACTIONS rows record the owner under either `uid` or `userId`
// depending on which code path wrote them, so both are matched. Pushing this
// filter into the query (rather than filtering in memory as store.js used to)
// is what the owner-field indexes exist for.
function listByOwner(name, uid, ownerFields) {
  const owner = String(uid ?? '');
  // An empty owner would build {field: null}, which matches every document
  // MISSING that field — i.e. the whole ledger. Fail closed instead.
  if (!owner) throw new Error('listByOwner requires a non-empty owner id');
  const filter = { $or: ownerFields.map((field) => ({ [field]: owner })) };
  return base.findWhere(name, filter, 'desc');
}

module.exports = { listAll, listByOwner };
