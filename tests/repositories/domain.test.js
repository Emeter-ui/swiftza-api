import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const users = require('../../src/repositories/users');
const catalog = require('../../src/repositories/catalog');
const ledger = require('../../src/repositories/ledger');
const settings = require('../../src/repositories/settings');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

describe('domain repositories', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(clearTestMongo);

  it('creates a user keyed by Firebase uid and reads it back', async () => {
    await users.create('firebase-uid-1', { email: 'a@b.c', account: 'USER', balance: 0 });
    const user = await users.findByUid('firebase-uid-1');
    expect(user.email).toBe('a@b.c');
    // _id is the uid, so docid is the uid.
    expect(user.docid).toBe('firebase-uid-1');
  });

  it('returns null for an unknown uid', async () => {
    expect(await users.findByUid('nope')).toBeNull();
  });

  it('finds only the installed admin', async () => {
    await users.create('u1', { account: 'USER', setUpProcess: true });
    await users.create('u2', { account: 'ADMIN', setUpProcess: false });
    await users.create('u3', { account: 'ADMIN', setUpProcess: true });

    const admin = await users.findInstalledAdmin();
    expect(admin.docid).toBe('u3');
  });

  it('returns null when no admin is installed', async () => {
    await users.create('u1', { account: 'USER', setUpProcess: true });
    expect(await users.findInstalledAdmin()).toBeNull();
  });

  it('updates a user by uid', async () => {
    await users.create('u1', { balance: 0 });
    await users.update('u1', { balance: 250 });
    expect((await users.findByUid('u1')).balance).toBe(250);
  });

  it('finds a user whose uid is 24-char hex (must not be coerced to ObjectId)', async () => {
    const hexUid = 'abcdef012345678901234567';
    await users.create(hexUid, { email: 'hex@x.com', account: 'USER', balance: 0 });
    const found = await users.findByUid(hexUid);
    expect(found).not.toBeNull();
    expect(found.email).toBe('hex@x.com');
    expect(found.docid).toBe(hexUid);
  });

  it('seeds a catalog collection and finds by lookup key', async () => {
    await catalog.insertMany('DATAPACKS', [
      { dataId: 1, Network: 'MTN', Amount: '₦4200.0', active: true },
      { dataId: 2, Network: 'GLO', Amount: '₦1000.0', active: true },
    ]);
    expect((await catalog.findOne('DATAPACKS', 'dataId', 2)).Network).toBe('GLO');
    expect(await catalog.list('DATAPACKS')).toHaveLength(2);
  });

  it('preserves the Amount display string exactly', async () => {
    await catalog.insertMany('DATAPACKS', [{ dataId: 1, Amount: '₦4200.0' }]);
    expect((await catalog.findOne('DATAPACKS', 'dataId', 1)).Amount).toBe('₦4200.0');
  });

  it('finds a catalog document by its generated docid', async () => {
    const docid = await catalog.insert('NETWORKS', { name: 'Mtn', id: 1 });
    expect((await catalog.findById('NETWORKS', docid)).name).toBe('Mtn');
  });

  it('returns null from findById for a malformed docid', async () => {
    expect(await catalog.findById('NETWORKS', 'garbage')).toBeNull();
  });

  it('filters a ledger by owner across both owner fields', async () => {
    const { collection } = require('../../src/services/mongo');
    await collection('WALLETTRANSACTIONS').insertMany([
      { _id: 't1', uid: 'me', amount: 100, CreatedAt: new Date() },
      { _id: 't2', userId: 'me', amount: 200, CreatedAt: new Date() },
      { _id: 't3', uid: 'someone-else', amount: 300, CreatedAt: new Date() },
    ]);

    const mine = await ledger.listByOwner('WALLETTRANSACTIONS', 'me', ['uid', 'userId']);
    expect(mine.map((r) => r.docid).sort()).toEqual(['t1', 't2']);
  });

  it('reads and writes the provider settings document', async () => {
    expect(await settings.get('providers')).toBeNull();
    await settings.set('providers', { active: 'vtpass' });
    expect((await settings.get('providers')).active).toBe('vtpass');
    await settings.set('providers', { active: 'husmodata' });
    expect((await settings.get('providers')).active).toBe('husmodata');
  });
});
