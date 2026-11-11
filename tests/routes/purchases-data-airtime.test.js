import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const catalogRepo = require('../../src/repositories/catalog');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const token = () => jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET, { subject: 'user-1' });
const auth = () => `Bearer ${token()}`;
const balance = async () => (await collection('USERS').findOne({ _id: 'user-1' })).balance;

// Stubbed at the fetch boundary: purchase.js destructures getProvider at load
// time, so replacing the module export has no effect. This also exercises the
// husmodata adapter's own interpret() rather than bypassing it.
const stubFetch = (body, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status, text: async () => JSON.stringify(body) });

describe('POST /buy-data and /buy-airtime', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('user-1', { email: 'u@x.com', account: 'USER', balance: 1000 });
    await catalogRepo.insertMany('NETWORKS', [{ name: 'Mtn', id: 1, active: true }]);
    await catalogRepo.insertMany('DATAPACKS', [
      { dataId: 7, Network: 'MTN', planType: 'SME', Size: '1.0 GB', Amount: '₦280.0', active: true },
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  const planId = async () => (await request(app).get('/catalog/data-plans')).body[0].id;

  it('buys data at the catalog price and returns the new wallet', async () => {
    stubFetch({ Status: 'successful', ident: 'p-1' });
    const res = await request(app).post('/buy-data').set('Authorization', auth())
      .send({ network: 'MTN', planType: 'SME', planId: await planId(), phone: '08000000000' });

    expect(res.status).toBe(200);
    expect(res.body.wallet).toBe(720);
    expect(res.body.reference).toMatch(/^pur_/);
    expect(res.body.message).toEqual(expect.any(String));
    expect(await balance()).toBe(720);
  });

  it('ignores any amount in the body — the price comes from the catalog', async () => {
    stubFetch({ Status: 'successful', ident: 'p-1' });
    await request(app).post('/buy-data').set('Authorization', auth())
      .send({ network: 'MTN', planType: 'SME', planId: await planId(), phone: '08000000000', amount: 1 });

    expect(await balance()).toBe(720);
  });

  it('refunds when the provider declines', async () => {
    stubFetch({ error: 'Plan unavailable' });
    const res = await request(app).post('/buy-data').set('Authorization', auth())
      .send({ network: 'MTN', planType: 'SME', planId: await planId(), phone: '08000000000' });

    expect(res.status).toBe(200);
    expect(res.body.wallet).toBe(1000);
    expect(await balance()).toBe(1000);
  });

  it('holds funds when the provider outcome is unknown', async () => {
    stubFetch({}, 500);
    const res = await request(app).post('/buy-data').set('Authorization', auth())
      .send({ network: 'MTN', planType: 'SME', planId: await planId(), phone: '08000000000' });

    expect(res.status).toBe(202);
    expect(res.body.wallet).toBe(720);
    expect(await balance()).toBe(720);
  });

  it('rejects an unknown network with 422 before touching the balance', async () => {
    const res = await request(app).post('/buy-data').set('Authorization', auth())
      .send({ network: 'Vodafone', planType: 'SME', planId: await planId(), phone: '08000000000' });

    expect(res.status).toBe(422);
    expect(await balance()).toBe(1000);
  });

  it('rejects a bad phone number', async () => {
    const res = await request(app).post('/buy-data').set('Authorization', auth())
      .send({ network: 'MTN', planType: 'SME', planId: await planId(), phone: '123' });
    expect(res.status).toBe(422);
  });

  it('buys airtime with a bounds-checked amount', async () => {
    stubFetch({ Status: 'successful', ident: 'p-2' });
    const res = await request(app).post('/buy-airtime').set('Authorization', auth())
      .send({ network: 'MTN', amount: 200, phone: '08000000000' });

    expect(res.status).toBe(200);
    expect(res.body.wallet).toBe(800);
  });

  it('rejects an airtime amount below the minimum', async () => {
    const res = await request(app).post('/buy-airtime').set('Authorization', auth())
      .send({ network: 'MTN', amount: 10, phone: '08000000000' });
    expect(res.status).toBe(422);
  });

  it('requires a session', async () => {
    expect((await request(app).post('/buy-data').send({})).status).toBe(401);
  });
});
