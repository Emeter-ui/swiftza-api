import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.PROVIDER_SMEAPI_TOKEN ||= 'test-smeapi-token';
process.env.ACTIVE_PROVIDER = 'smeapi';

const app = require('../../src/app');
const users = require('../../src/repositories/users');
const catalogRepo = require('../../src/repositories/catalog');
const referrals = require('../../src/models/referrals');
const { authfunc } = require('../../src/services/index');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const token = (uid, account = 'USER') => `Bearer ${jwt.sign({ uid, account }, process.env.JWT_SECRET, { subject: uid })}`;
const balance = async (uid) => (await collection('USERS').findOne({ _id: uid })).balance;

let ipSeq = 0;
let ip;
const signup = (body) => request(app).post('/signup').set('X-Forwarded-For', ip).send({ password: 'secret123', fullname: 'Tobi Bello', ...body });

describe('referrals', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    ip = `10.30.0.${++ipSeq}`;
    await clearTestMongo();
    vi.spyOn(authfunc, 'signup').mockImplementation(async (email) => ({ user: { uid: `uid-${email}` } }));
    vi.spyOn(authfunc, 'sendVerification').mockImplementation(async () => {});
    await users.create('ada', { email: 'ada@x.com', fullname: 'Ada Obi', phone: '+2348030000001', account: 'USER', balance: 0 });
    await users.create('adm', { email: 'a@x.com', account: 'ADMIN', balance: 0 });
  });
  afterEach(() => vi.restoreAllMocks());

  const adaCode = async () => (await request(app).get('/referrals/me').set('Authorization', token('ada'))).body.code;

  it('gives each customer one stable code and their totals', async () => {
    const first = await request(app).get('/referrals/me').set('Authorization', token('ada'));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ enabled: true, referrerReward: 500, referred: 0, earned: 0, friends: [] });
    expect(first.body.code).toMatch(/^[A-Z2-9]{7}$/);
    expect(await adaCode()).toBe(first.body.code);
    expect((await request(app).get('/referrals/stats').set('Authorization', token('ada'))).body.code).toBe(first.body.code);
  });

  it('links a signup to the referrer and tells them', async () => {
    const code = await adaCode();
    const res = await signup({ email: 'tobi@x.com', phone: '+2348030000002', referral: code.toLowerCase(), referredBy: 'someone-else', balance: 99999 });
    expect(res.status).toBe(201);
    const tobi = await collection('USERS').findOne({ _id: 'uid-tobi@x.com' });
    expect(tobi).toMatchObject({ referredBy: 'ada', referredWithCode: code, balance: 0 });
    expect(tobi.referral).toBeUndefined();
    const note = await collection('USERNOTIFICATIONS').findOne({ uid: 'ada' });
    expect(note).toMatchObject({ type: 'referral', title: 'Tobi just joined Swiftza' });
    expect(note.body).toMatch(/unlocks after their first payment/);
  });

  it('refuses a bad code or your own phone before creating the account', async () => {
    const bad = await signup({ email: 'x@x.com', referral: 'NOPE123' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('INVALID_REFERRAL');
    const own = await signup({ email: 'y@x.com', phone: '08030000001', referral: await adaCode() });
    expect(own.status).toBe(422);
    expect(authfunc.signup).not.toHaveBeenCalled();
  });

  describe('rewards', () => {
    beforeEach(async () => {
      await users.create('tobi', { email: 't@x.com', fullname: 'Tobi Bello', account: 'USER', balance: 5000, referredBy: 'ada' });
    });

    it("pays the referrer once, on the friend's first qualifying purchase", async () => {
      await catalogRepo.insertMany('NETWORKS', [{ _id: 'net-mtn', name: 'MTN', smeapiNetworkId: 1 }]);
      await catalogRepo.insertMany('DATAPACKS', [{ _id: 'plan-1gb', networkId: 'net-mtn', planType: 'SME', Size: '1GB', Validity: '30 days', Amount: '₦700.0', smeapiDataPlanId: 7 }]);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 200, text: async () => JSON.stringify({ Status: 'successful' }) });
      const buy = () => request(app).post('/buy-data').set('Authorization', token('tobi')).send({ network: 'MTN', planId: 'plan-1gb', phone: '08031234567' });

      expect((await buy()).body.status).toBe('success');
      expect(await balance('ada')).toBe(500);
      expect((await buy()).body.status).toBe('success');
      expect(await balance('ada')).toBe(500);

      const me = await request(app).get('/referrals/me').set('Authorization', token('ada'));
      expect(me.body).toMatchObject({ referred: 1, rewarded: 1, earned: 500, latestReward: { amount: 500, role: 'referrer' } });
      expect(me.body.friends).toEqual([expect.objectContaining({ name: 'Tobi', status: 'rewarded' })]);

      // Shows as a credit, with its own notification.
      const notes = await request(app).get('/notifications').set('Authorization', token('ada'));
      const titles = (notes.body.notifications || notes.body).map((n) => n.title);
      expect(titles).toEqual(expect.arrayContaining(['Reward added!', 'Referral reward']));
    });

    it('ignores purchases under the minimum, and never pays twice when two settle at once', async () => {
      expect(await referrals.onPurchaseSuccess('tobi', 100)).toBeNull();
      expect(await balance('ada')).toBe(0);
      const results = await Promise.all([referrals.onPurchaseSuccess('tobi', 1000), referrals.onPurchaseSuccess('tobi', 1000)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await balance('ada')).toBe(500);
      expect(await collection('WALLETTRANSACTIONS').countDocuments({ mode: 'referral-credit' })).toBe(1);
    });

    it('pays the new customer too when a welcome reward is set, and respects the monthly cap', async () => {
      await request(app).put('/admin/referrals/settings').set('Authorization', token('adm', 'ADMIN')).send({ settings: { refereeReward: 200, maxRewardsPerMonth: 1 } });
      await referrals.onPurchaseSuccess('tobi', 1000);
      expect(await balance('ada')).toBe(500);
      expect(await balance('tobi')).toBe(5200);

      await users.create('kemi', { email: 'k@x.com', fullname: 'Kemi', account: 'USER', balance: 0, referredBy: 'ada' });
      expect(await referrals.onPurchaseSuccess('kemi', 1000)).toBeNull();
      expect(await balance('ada')).toBe(500);
      expect((await collection('USERS').findOne({ _id: 'kemi' })).referralSkipped).toBe('monthly-cap');
    });

    it('can be switched off', async () => {
      const code = await adaCode();
      const res = await request(app).put('/admin/referrals/settings').set('Authorization', token('adm', 'ADMIN')).send({ settings: { enabled: false } });
      expect(res.body.settings.enabled).toBe(false);
      expect((await request(app).get('/referrals/me').set('Authorization', token('ada'))).body).toEqual({ enabled: false });
      expect(await referrals.onPurchaseSuccess('tobi', 1000)).toBeNull();
      // A code typed while switched off is simply not applied.
      expect((await signup({ email: 'z@x.com', referral: code })).status).toBe(201);
      expect((await collection('USERS').findOne({ _id: 'uid-z@x.com' })).referredBy).toBeUndefined();
    });

    it('validates admin settings', async () => {
      const res = await request(app).put('/admin/referrals/settings').set('Authorization', token('adm', 'ADMIN')).send({ settings: { referrerReward: -5 } });
      expect(res.status).toBe(422);
      expect((await request(app).get('/admin/referrals/settings').set('Authorization', token('ada'))).status).toBe(403);
    });
  });
});
