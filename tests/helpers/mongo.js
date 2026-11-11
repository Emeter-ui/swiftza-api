const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongo = require('../../src/services/mongo');

let replset = null;

// A replica set (not MongoMemoryServer) because session.withTransaction is
// unavailable on a standalone mongod, and the wallet layer is built on it.
async function startTestMongo() {
  replset = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await mongo.connect(replset.getUri(), 'samzee_test');
  await mongo.ensureIndexes();
}

async function stopTestMongo() {
  await mongo.close();
  if (replset) await replset.stop();
  replset = null;
}

async function clearTestMongo() {
  const collections = await mongo.getDb().collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

module.exports = { startTestMongo, stopTestMongo, clearTestMongo };
