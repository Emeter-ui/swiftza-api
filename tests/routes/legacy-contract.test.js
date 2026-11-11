import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const catalogRepo = require('../../src/repositories/catalog');
const { authfunc } = require('../../src/services/index');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const token = (uid, account) =>
  jwt.sign({ uid, account }, process.env.JWT_SECRET, { subject: uid });

function stubAuthfunc() {
  vi.spyOn(authfunc, 'signup').mockImplementation(async (email) => ({ user: { uid: `uid-for-${email}` } }));
  vi.spyOn(authfunc, 'login').mockImplementation(async (email) => ({ user: { uid: `uid-for-${email}` } }));
}

// These assertions encode what samzeedatas reads today. They exist so that
// adding the new contract's fields cannot silently remove or reshape a field
// the live Vue 2 app depends on.
describe('legacy contract (samzeedatas) must not regress', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    stubAuthfunc();
    await users.create('user-1', {
      email: 'u@x.com', account: 'USER', balance: 500,
      passwd: 'never-returned', password: 'never-returned-either', paystacksecretkey: 'sk_live_never',
    });
    await catalogRepo.insertMany('DATAPACKS', [
      { dataId: 7, Network: 'MTN', Size: '1.0 GB', Validity: '30 days', Amount: '₦280.0', planType: 'SME', active: true },
    ]);
    await collection('TRANSACTIONS').insertMany([
      {
        _id: 'T123456', uid: 'user-1', transType: 'Data', amount: 280,
        status: 'success', transref: 'T123456', CreatedAt: new Date(),
      },
      {
        // A second row owned by someone else. Without this, listAll (admin,
        // unfiltered) and listByOwner (filtered) return the same single row
        // and the isolation test below would pass even if the owner filter
        // were removed entirely.
        _id: 'T999999', uid: 'user-2', transType: 'Data', amount: 999,
        status: 'success', transref: 'T999999', CreatedAt: new Date(),
      },
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('POST /login still returns token and data{uid,account}', async () => {
    // The stubbed authfunc.login resolves 'u@x.com' to uid 'uid-for-u@x.com'
    // (matching the convention in auth-flow.test.js and shared-paths.test.js),
    // which is distinct from this file's 'user-1' fixture used by the other
    // tests below. /login now 500s when no USERS document exists for the
    // resolved uid (see routes/login.js), so this needs its own document.
    await users.create('uid-for-u@x.com', { email: 'u@x.com', account: 'USER', balance: 500 });

    const res = await request(app).post('/login').send({ email: 'u@x.com', passwd: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.data).toEqual({ uid: 'uid-for-u@x.com', account: 'USER' });
  });

  it('POST /signup still accepts passwd and creates the user', async () => {
    const res = await request(app).post('/signup').send({ email: 'new@x.com', passwd: 'secret123' });
    expect(res.status).toBe(201);
    const created = await users.findByUid('uid-for-new@x.com');
    expect(created.account).toBe('USER');
    expect(created.passwd).toBeUndefined();
  });

  it('POST /userData still returns balance, account and id, and no secrets', async () => {
    const res = await request(app)
      .post('/userData')
      .set('Authorization', `Bearer ${token('user-1', 'USER')}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(500);
    expect(res.body.account).toBe('USER');
    expect(res.body.id).toBe('user-1');
    // SENSITIVE_FIELDS in src/routes/userData.js strips all three of these;
    // proving only `passwd` leaves the other two unpinned.
    expect(res.body.passwd).toBeUndefined();
    expect(res.body.password).toBeUndefined();
    expect(res.body.paystacksecretkey).toBeUndefined();
  });

  it('POST /store still returns docid and Firestore-shaped CreatedAt', async () => {
    const res = await request(app).post('/store').send({ collection: 'DATAPACKS' });
    expect(res.status).toBe(200);
    expect(res.body[0].docid).toEqual(expect.any(String));
    // The legacy transactions page computes date.seconds * 1000 + ...
    expect(res.body[0].CreatedAt).toEqual({
      seconds: expect.any(Number), nanoseconds: expect.any(Number),
    });
    // The display string must not be normalised to a number.
    expect(res.body[0].Amount).toBe('₦280.0');
  });

  it('POST /store on a ledger still returns only the caller rows, in legacy shape', async () => {
    const res = await request(app)
      .post('/store')
      .set('Authorization', `Bearer ${token('user-1', 'USER')}`)
      .send({ collection: 'TRANSACTIONS' });
    expect(res.status).toBe(200);
    // Asserting on the full set of returned transrefs (not just res.body[0])
    // proves isolation: if the owner filter were dropped, user-2's T999999
    // row would also come back and this would fail.
    expect(res.body.map((r) => r.transref)).toEqual(['T123456']);
    expect(res.body[0].CreatedAt).toEqual({
      seconds: expect.any(Number), nanoseconds: expect.any(Number),
    });
  });

  it('POST /store on WALLETTRANSACTIONS still filters by uid or userId, and only those', async () => {
    await collection('WALLETTRANSACTIONS').insertMany([
      { _id: 'W-uid', uid: 'user-1', amount: 100, CreatedAt: new Date() },
      { _id: 'W-userId', userId: 'user-1', amount: 200, CreatedAt: new Date() },
      { _id: 'W-other', uid: 'user-2', amount: 300, CreatedAt: new Date() },
    ]);
    const res = await request(app)
      .post('/store')
      .set('Authorization', `Bearer ${token('user-1', 'USER')}`)
      .send({ collection: 'WALLETTRANSACTIONS' });
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.docid).sort()).toEqual(['W-uid', 'W-userId']);
  });

  it('POST /store on USERS still returns docid for an admin and never passwd/paystacksecretkey', async () => {
    await users.create('admin-1', {
      email: 'a@x.com', account: 'ADMIN', balance: 0,
      passwd: 'never-returned', paystacksecretkey: 'sk_live_never',
    });
    const res = await request(app)
      .post('/store')
      .set('Authorization', `Bearer ${token('admin-1', 'ADMIN')}`)
      .send({ collection: 'USERS' });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const u of res.body) {
      expect(u.docid).toEqual(expect.any(String));
      expect(u.passwd).toBeUndefined();
      expect(u.paystacksecretkey).toBeUndefined();
    }
  });
});
