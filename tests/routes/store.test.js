import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const catalogRepo = require('../../src/repositories/catalog');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const token = (uid, account) => jwt.sign({ uid, account }, process.env.JWT_SECRET, { subject: uid });
const asUser = () => `Bearer ${token('user-1', 'USER')}`;
const asAdmin = () => `Bearer ${token('admin-1', 'ADMIN')}`;

describe('POST /store', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('user-1', { email: 'u@x.com', account: 'USER', balance: 100 });
    await users.create('admin-1', { email: 'a@x.com', account: 'ADMIN', balance: 0, setUpProcess: true, paystackpublickey: 'pk_test', paystacksecretkey: 'sk_test', apiurl: 'https://api.x', supportmail: 's@x.com', appname: 'Samzee' });
    await catalogRepo.insertMany('DATAPACKS', [{ dataId: 1, Network: 'MTN', Amount: '₦280.0', active: true }]);
    await collection('TRANSACTIONS').insertMany([
      { _id: 't-mine', uid: 'user-1', amount: 100, CreatedAt: new Date() },
      { _id: 't-theirs', uid: 'someone-else', amount: 200, CreatedAt: new Date() },
    ]);
  });

  it('serves the catalog publicly with a docid on every row', async () => {
    const res = await request(app).post('/store').send({ collection: 'DATAPACKS' });

    expect(res.status).toBe(200);
    expect(res.body[0].docid).toEqual(expect.any(String));
    expect(res.body[0]._id).toBeUndefined();
    expect(res.body[0].Amount).toBe('₦280.0');
  });

  it('serialises CreatedAt in the Firestore Timestamp wire shape', async () => {
    const res = await request(app)
      .post('/store')
      .set('Authorization', asUser())
      .send({ collection: 'TRANSACTIONS' });

    // The legacy app computes date.seconds * 1000 + date.nanoseconds / 1000000.
    // An ISO string here would render "Invalid Date" on every row.
    expect(res.body[0].CreatedAt).toEqual({
      seconds: expect.any(Number),
      nanoseconds: expect.any(Number),
    });
  });

  it('requires a session for a ledger', async () => {
    expect((await request(app).post('/store').send({ collection: 'TRANSACTIONS' })).status).toBe(401);
  });

  it('returns only the caller rows of a ledger', async () => {
    const res = await request(app)
      .post('/store')
      .set('Authorization', asUser())
      .send({ collection: 'TRANSACTIONS' });

    expect(res.body.map((r) => r.docid)).toEqual(['t-mine']);
  });

  it('returns every ledger row to an admin', async () => {
    const res = await request(app)
      .post('/store')
      .set('Authorization', asAdmin())
      .send({ collection: 'TRANSACTIONS' });

    expect(res.body).toHaveLength(2);
  });

  it('refuses the user list to a non-admin', async () => {
    expect(
      (await request(app).post('/store').set('Authorization', asUser()).send({ collection: 'USERS' })).status
    ).toBe(403);
  });

  it('strips sensitive fields from the admin user list', async () => {
    const res = await request(app).post('/store').set('Authorization', asAdmin()).send({ collection: 'USERS' });

    expect(res.status).toBe(200);
    expect(res.body.every((u) => u.passwd === undefined && u.paystacksecretkey === undefined)).toBe(true);
  });

  it('refuses an unknown collection', async () => {
    expect((await request(app).post('/store').send({ collection: 'SECRETS' })).status).toBe(403);
  });

  it('matches WALLETTRANSACTIONS rows owned via either uid or userId, and only those', async () => {
    await collection('WALLETTRANSACTIONS').insertMany([
      { _id: 'w-uid', uid: 'user-1', amount: 10, CreatedAt: new Date() },
      { _id: 'w-userid', userId: 'user-1', amount: 20, CreatedAt: new Date() },
      { _id: 'w-theirs', uid: 'someone-else', amount: 30, CreatedAt: new Date() },
      { _id: 'w-orphan', amount: 40, CreatedAt: new Date() },
    ]);

    const res = await request(app)
      .post('/store')
      .set('Authorization', asUser())
      .send({ collection: 'WALLETTRANSACTIONS' });

    expect(res.body.map((r) => r.docid).sort()).toEqual(['w-uid', 'w-userid']);
  });

  it('re-reads the role from the database rather than trusting the JWT claim', async () => {
    // user-1's stored row says USER; the token below lies and claims ADMIN.
    const forgedAdminToken = `Bearer ${jwt.sign(
      { uid: 'user-1', account: 'ADMIN' },
      process.env.JWT_SECRET,
      { subject: 'user-1' }
    )}`;

    const usersRes = await request(app)
      .post('/store')
      .set('Authorization', forgedAdminToken)
      .send({ collection: 'USERS' });
    expect(usersRes.status).toBe(403);

    const ledgerRes = await request(app)
      .post('/store')
      .set('Authorization', forgedAdminToken)
      .send({ collection: 'TRANSACTIONS' });
    expect(ledgerRes.body.map((r) => r.docid)).toEqual(['t-mine']);
  });
});

describe('POST /store/update', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('user-1', { email: 'u@x.com', account: 'USER', balance: 100 });
    await users.create('admin-1', { email: 'a@x.com', account: 'ADMIN', balance: 0 });
  });

  it('lets a user edit their own profile', async () => {
    const res = await request(app)
      .post('/store/update')
      .set('Authorization', asUser())
      .send({ collection: 'USERS', uid: 'user-1', data: { fullname: 'New Name' } });

    expect(res.status).toBe(200);
    expect((await users.findByUid('user-1')).fullname).toBe('New Name');
  });

  it('silently drops protected fields such as balance and account', async () => {
    await request(app)
      .post('/store/update')
      .set('Authorization', asUser())
      .send({ collection: 'USERS', uid: 'user-1', data: { fullname: 'X', balance: 999999, account: 'ADMIN' } });

    const user = await users.findByUid('user-1');
    expect(user.balance).toBe(100);
    expect(user.account).toBe('USER');
  });

  it('refuses editing another user profile', async () => {
    const res = await request(app)
      .post('/store/update')
      .set('Authorization', asUser())
      .send({ collection: 'USERS', uid: 'admin-1', data: { fullname: 'X' } });

    expect(res.status).toBe(403);
  });

  it('refuses writing to a ledger', async () => {
    const res = await request(app)
      .post('/store/update')
      .set('Authorization', asAdmin())
      .send({ collection: 'TRANSACTIONS', uid: 't-1', data: { amount: 1 } });

    expect(res.status).toBe(403);
  });
});

describe('POST /store/add and GET /store/keystore', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('user-1', { email: 'u@x.com', account: 'USER' });
    await users.create('admin-1', {
      email: 'a@x.com', account: 'ADMIN', setUpProcess: true,
      paystackpublickey: 'pk_test', paystacksecretkey: 'sk_test',
      apiurl: 'https://api.x', supportmail: 's@x.com', appname: 'Samzee',
    });
  });

  it('lets an admin add a catalog row', async () => {
    const res = await request(app)
      .post('/store/add')
      .set('Authorization', asAdmin())
      .send({ collection: 'NETWORKS', data: { name: 'Mtn', id: 1 } });

    expect(res.status).toBe(200);
    expect(await catalogRepo.list('NETWORKS')).toHaveLength(1);
  });

  it('refuses a non-admin adding a catalog row', async () => {
    const res = await request(app)
      .post('/store/add')
      .set('Authorization', asUser())
      .send({ collection: 'NETWORKS', data: { name: 'Mtn' } });

    expect(res.status).toBe(403);
  });

  it('exposes only the public keystore fields', async () => {
    const res = await request(app).get('/store/keystore');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      paystack: 'pk_test', apiurl: 'https://api.x', supportmail: 's@x.com', appname: 'Samzee',
    });
    expect(res.body.paystacksecretkey).toBeUndefined();
  });
});
