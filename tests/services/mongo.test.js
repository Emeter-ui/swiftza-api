import { describe, it, expect, afterAll } from 'vitest';
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongo = require('../../src/services/mongo');

describe('services/mongo', () => {
  let replset;

  afterAll(async () => {
    await mongo.close();
    if (replset) await replset.stop();
  });

  it('throws when getDb is called before connect', () => {
    expect(() => mongo.getDb()).toThrow('MongoDB is not connected');
  });

  it('throws when getClient is called before connect', () => {
    expect(() => mongo.getClient()).toThrow('MongoDB is not connected');
  });

  it('connects and creates every declared index', async () => {
    replset = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    await mongo.connect(replset.getUri(), 'indextest');
    await mongo.ensureIndexes();

    const names = await mongo.collection('WALLETTRANSACTIONS').indexInformation();
    expect(Object.keys(names)).toContain('uid_1_CreatedAt_-1');
    // I6: the requery queue runs find({status:'requery'}) with nothing to
    // serve it, so it scans the whole ledger for the handful of held rows.
    expect(Object.keys(names)).toContain('status_1_CreatedAt_-1');
  });

  it('supports multi-document transactions', async () => {
    const session = mongo.getClient().startSession();
    try {
      await session.withTransaction(async () => {
        await mongo.collection('probe').insertOne({ _id: 'a', n: 1 }, { session });
        await mongo.collection('probe').insertOne({ _id: 'b', n: 2 }, { session });
      });
    } finally {
      await session.endSession();
    }
    expect(await mongo.collection('probe').countDocuments()).toBe(2);
  });

  it('assertTransactionsAvailable resolves against a replica set', async () => {
    await expect(mongo.assertTransactionsAvailable()).resolves.toBeUndefined();
  });
});
