const { MongoClient } = require('mongodb');

// Declared here rather than in a migration tool because createIndexes is
// idempotent — re-running it on every boot costs nothing and guarantees a
// fresh environment is correctly indexed without a separate deploy step.
const INDEXES = {
  USERS: [{ key: { account: 1, setUpProcess: 1 } }],
  TRANSACTIONS: [
    { key: { uid: 1, CreatedAt: -1 } },
    { key: { CreatedAt: -1 } },
  ],
  WALLETTRANSACTIONS: [
    { key: { uid: 1, CreatedAt: -1 } },
    { key: { userId: 1, CreatedAt: -1 } },
    { key: { CreatedAt: -1 } },
    // The requery queue (routes/admin/requery.js) runs find({status:
    // 'requery'}) with no index to serve it, so it scans the whole ledger to
    // find the handful of held rows -- and gets slowest exactly when an
    // outage has filled the ledger. ATCORDERS already has {status: 1}; this
    // was simply missed. Compound with CreatedAt so the same index also
    // serves a future age sort.
    { key: { status: 1, CreatedAt: -1 } },
  ],
  ATCORDERS: [
    { key: { uid: 1, CreatedAt: -1 } },
    { key: { status: 1 } },
    { key: { CreatedAt: -1 } },
  ],
  // AUDITLOG rows are written inside adjustBalance's transaction. Listing it
  // here pre-creates the collection outside any transaction, so the first
  // adjustment on a fresh database does not perform implicit collection
  // creation inside a `readConcern: 'snapshot'` transaction — that matters
  // more than the read performance these indexes also happen to give.
  AUDITLOG: [
    { key: { targetUid: 1, CreatedAt: -1 } },
    { key: { CreatedAt: -1 } },
  ],
  DATAPACKS: [{ key: { dataId: 1 } }],
  CABLESPLAN: [{ key: { CableplanID: 1 } }],
  EPIN: [{ key: { examName: 1 } }],
  ATC: [{ key: { network: 1 } }],
};

let client = null;
let db = null;

async function connect(uri, dbName) {
  if (db) return db;
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  return db;
}

// Throws rather than lazily connecting: a route that reaches the database
// before boot finished is a bug, and a silent reconnect would hide it.
function getDb() {
  if (!db) throw new Error('MongoDB is not connected. Call connect() first.');
  return db;
}

function getClient() {
  if (!client) throw new Error('MongoDB is not connected. Call connect() first.');
  return client;
}

function collection(name) {
  return getDb().collection(name);
}

async function ensureIndexes() {
  const database = getDb();
  for (const [name, specs] of Object.entries(INDEXES)) {
    await database.collection(name).createIndexes(specs);
  }
}

async function close() {
  if (client) await client.close();
  client = null;
  db = null;
}

// The wallet layer is built on session.withTransaction(), which requires a
// replica set. Without this probe a standalone mongod boots clean and then
// fails every purchase and every wallet credit at the first request.
async function assertTransactionsAvailable() {
  const session = getClient().startSession();
  try {
    await session.withTransaction(async () => {
      await getDb().collection('__txn_probe').findOne({ _id: 'probe' }, { session });
    });
  } catch (err) {
    throw new Error(
      'MongoDB transactions are unavailable — the wallet layer requires a replica set. ' +
      `Point MONGODB_URI at a replica set or Atlas cluster. Underlying error: ${err.message}`
    );
  } finally {
    await session.endSession();
  }
}

// withTransaction retries the callback on a TransientTransactionError. The
// result is assigned into a closed-over variable, rather than returned
// through withTransaction directly, for explicitness -- each retry re-runs
// the callback from scratch, so the last attempt to complete is the one
// whose assignment wins. Every callback below is also guarded by a status
// check, which is what makes re-running one safe.
//
// readConcern and writeConcern are stated explicitly rather than inherited
// from the MONGODB_URI: a connection string that defaults to w=1 (or a
// non-majority read) would otherwise be a silent durability hole on the
// credit and deduct paths -- a wallet layer cannot afford data that is not
// majority-committed and can be rolled back on failover.
async function inTransaction(work) {
  const session = getClient().startSession();
  let result;
  try {
    await session.withTransaction(
      async () => {
        result = await work(session);
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }
    );
  } finally {
    await session.endSession();
  }
  return result;
}

const isDuplicateKey = (err) => err && err.code === 11000;

module.exports = {
  connect,
  getDb,
  getClient,
  collection,
  ensureIndexes,
  assertTransactionsAvailable,
  inTransaction,
  isDuplicateKey,
  close,
  INDEXES,
};
