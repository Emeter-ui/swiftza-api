const { ObjectId } = require('mongodb');
const { collection } = require('../services/mongo');
const { AppError } = require('../models/errors');

// The legacy frontend parses timestamps as Firestore Timestamps:
//   new Date(date.seconds * 1000 + date.nanoseconds / 1000000)
// A native Date would serialise to an ISO string, so date.seconds would be
// undefined and every ledger row would render "Invalid Date". This shim is
// removed in the phase 3 contract rework.
function toWireTimestamp(date) {
  const ms = date.getTime();
  return {
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms - Math.floor(ms / 1000) * 1000) * 1e6,
  };
}

function serialize(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return toWireTimestamp(value);
  if (value instanceof ObjectId) return value.toHexString();
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = serialize(inner);
    return out;
  }
  return value;
}

// Every read goes through here, so no route can forget the mapping.
function serializeDoc(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { ...serialize(rest), docid: _id instanceof ObjectId ? _id.toHexString() : String(_id) };
}

// Firestore accepted any string as a document id; ObjectId throws on a
// malformed one. A malformed id is returned as-is (the raw string) rather
// than thrown, so the ensuing findOne simply misses instead of surfacing a
// 500 -- null is returned only for a null/undefined input, which is what lets
// byId short-circuit to its own not-found result without querying at all.
function toId(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof ObjectId) return value;
  const text = String(value);
  return ObjectId.isValid(text) ? new ObjectId(text) : text;
}

function sortSpec(sort) {
  if (sort === 'asc') return { CreatedAt: 1 };
  if (sort === 'desc') return { CreatedAt: -1 };
  return null;
}

async function findWhere(name, filter = {}, sort = '') {
  let cursor = collection(name).find(filter);
  const spec = sortSpec(sort);
  if (spec) cursor = cursor.sort(spec);
  return (await cursor.toArray()).map(serializeDoc);
}

async function all(name, sort = '') {
  return findWhere(name, {}, sort);
}

async function byId(name, id) {
  const _id = toId(id);
  if (_id === null) return null;
  return serializeDoc(await collection(name).findOne({ _id }));
}

async function findBy(name, field, value) {
  return serializeDoc(await collection(name).findOne({ [field]: value }));
}

// CreatedAt is stamped here so it matches Firestore's serverTimestamp()
// behaviour: set by the server on write, never supplied by the client.
async function insert(name, doc) {
  const result = await collection(name).insertOne({ ...doc, CreatedAt: new Date() });
  return String(result.insertedId);
}

async function insertMany(name, docs) {
  if (!docs.length) return;
  await collection(name).insertMany(docs.map((d) => ({ ...d, CreatedAt: new Date() })));
}

async function update(name, id, patch) {
  const _id = toId(id);
  if (_id === null) return;
  const result = await collection(name).updateOne({ _id }, { $set: patch });
  // Firestore's updateDoc rejects with NOT_FOUND when the document does not
  // exist; updateOne silently no-ops instead. Throwing here restores that
  // parity rather than reporting success for a write that changed nothing.
  if (result.matchedCount === 0) {
    throw new AppError('NOT_FOUND', 'Document not found', 404, { id });
  }
}

// Collections whose _id is a caller-supplied string (a Firebase uid, a settings
// key) must never route through toId(): it converts any 24-char hex string to an
// ObjectId, which would then never match the stored string _id and would surface
// as a false "not found". These collections always know their id is a string.
async function byStringId(name, id) {
  return serializeDoc(await collection(name).findOne({ _id: String(id) }));
}

async function updateStringId(name, id, patch) {
  const result = await collection(name).updateOne({ _id: String(id) }, { $set: patch });
  // See update() above: mirrors Firestore's updateDoc NOT_FOUND rejection
  // instead of silently reporting success for a no-op write.
  if (result.matchedCount === 0) {
    throw new AppError('NOT_FOUND', 'Document not found', 404, { id });
  }
}

// Admin lists are the first bounded reads in the project. limit is clamped
// server-side so a caller cannot ask for the whole collection and reintroduce
// the problem pagination exists to solve.
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

async function remove(name, id) {
  const _id = toId(id);
  if (_id === null) return false;
  const result = await collection(name).deleteOne({ _id });
  return result.deletedCount === 1;
}

async function count(name, filter = {}) {
  return collection(name).countDocuments(filter);
}

// Cursor-based rather than offset: an offset page can skip or repeat a row when
// a document is inserted or removed mid-walk. The cursor is the last _id seen,
// paired with a descending sort, so the range is stable.
async function page(name, filter = {}, { limit, cursor, sort = { _id: -1 } } = {}) {
  const parsed = Number(limit);
  const size = Math.min(Math.max(Number.isFinite(parsed) ? parsed : DEFAULT_PAGE, 1), MAX_PAGE);

  const query = { ...filter };
  if (cursor) {
    const after = toId(cursor);
    if (after !== null) query._id = { $lt: after };
  }

  const rows = await collection(name)
    .find(query)
    .sort(sort)
    .limit(size + 1)
    .toArray();

  const hasMore = rows.length > size;
  const items = (hasMore ? rows.slice(0, size) : rows).map(serializeDoc);

  return { items, nextCursor: hasMore ? items[items.length - 1].docid : null };
}

module.exports = {
  serializeDoc, toWireTimestamp, toId, sortSpec,
  all, byId, findBy, findWhere, insert, insertMany, update,
  byStringId, updateStringId,
  remove, count, page, DEFAULT_PAGE, MAX_PAGE,
};
