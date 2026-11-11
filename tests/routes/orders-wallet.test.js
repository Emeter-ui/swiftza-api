import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const catalogRepo = require('../../src/repositories/catalog');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const auth = () => `Bearer ${jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET, { subject: 'user-1' })}`;
const balanceOf = async (uid) => (await collection('USERS').findOne({ _id: uid })).balance;
const balance = () => balanceOf('user-1');

describe('POST /atoc', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('user-1', { email: 'u@x.com', account: 'USER', balance: 0 });
    await catalogRepo.insertMany('ATC', [{ network: 'MTN', number: '08000000000', percent: 10, active: true }]);
  });

  const body = {
    network: 'MTN', mobileNumber: '08000000000', amount: 5000,
    bankName: 'GTBank', accountNumber: '0123456789', accountName: 'A Person',
  };

  it('computes receiveAmount from the catalog commission, not the body', async () => {
    const res = await request(app).post('/atoc').set('Authorization', auth())
      .send({ ...body, commissionRate: 0, receiveAmount: 5000 });

    expect(res.status).toBe(201);
    expect(res.body.receiveAmount).toBe(4500);

    const order = await collection('ATCORDERS').findOne({ uid: 'user-1' });
    expect(order.percent).toBe(10);
    // The stored field keeps its historical misspelling until cutover.
    expect(order.reciveAmount).toBe(4500);
  });

  it('requires a session', async () => {
    expect((await request(app).post('/atoc').send(body)).status).toBe(401);
  });

  it('rejects an amount below the minimum', async () => {
    const res = await request(app).post('/atoc').set('Authorization', auth()).send({ ...body, amount: 10 });
    expect(res.status).toBe(422);
  });

  it('rejects a duplicate submission and leaves exactly one order', async () => {
    const first = await request(app).post('/atoc').set('Authorization', auth()).send(body);
    expect(first.status).toBe(201);

    const second = await request(app).post('/atoc').set('Authorization', auth()).send(body);
    expect(second.status).toBe(409);

    const orders = await collection('ATCORDERS').find({ uid: 'user-1' }).toArray();
    expect(orders.length).toBe(1);
  });

  it('allows a second order that differs in amount', async () => {
    const first = await request(app).post('/atoc').set('Authorization', auth()).send(body);
    expect(first.status).toBe(201);

    const second = await request(app).post('/atoc').set('Authorization', auth()).send({ ...body, amount: 6000 });
    expect(second.status).toBe(201);

    const orders = await collection('ATCORDERS').find({ uid: 'user-1' }).toArray();
    expect(orders.length).toBe(2);
  });
});

describe('POST /fund-wallet/verify', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('user-1', { email: 'u@x.com', account: 'USER', balance: 500 });
    // A second account named by the Paystack metadata, distinct from the
    // session's uid, so a handler that trusted metadata.id instead of the
    // session would be caught crediting the wrong account.
    await users.create('attacker-1', { email: 'a@x.com', account: 'USER', balance: 250 });
  });
  afterEach(() => vi.restoreAllMocks());

  const paystackOk = () =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({
        data: { status: 'success', reference: 'PSK123', amount: 100000, channel: 'card', metadata: { id: 'attacker-1' } },
      }),
    });

  const paystackFailed = () =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({
        data: { status: 'failed', reference: 'PSK123', amount: 100000, channel: 'card', metadata: { id: 'user-1' } },
      }),
    });

  const paystackUnavailable = () =>
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

  it('credits the session user, not the account named in Paystack metadata', async () => {
    paystackOk();
    const res = await request(app).post('/fund-wallet/verify').set('Authorization', auth())
      .send({ reference: 'PSK123' });

    expect(res.status).toBe(200);
    expect(res.body.wallet).toBe(1500);
    expect(await balanceOf('user-1')).toBe(1500);
    // The metadata named 'attacker-1' — its balance must not move.
    expect(await balanceOf('attacker-1')).toBe(250);
  });

  it('credits once when the same reference is verified twice', async () => {
    paystackOk();
    await request(app).post('/fund-wallet/verify').set('Authorization', auth()).send({ reference: 'PSK123' });
    const second = await request(app).post('/fund-wallet/verify').set('Authorization', auth()).send({ reference: 'PSK123' });

    expect(second.status).toBe(200);
    expect(await balance()).toBe(1500);
  });

  it('stores the credit under a namespaced reference so it cannot collide with a purchase', async () => {
    paystackOk();
    await request(app).post('/fund-wallet/verify').set('Authorization', auth()).send({ reference: 'PSK123' });
    expect(await collection('WALLETTRANSACTIONS').findOne({ _id: 'ps_PSK123' })).not.toBeNull();
  });

  it('does not credit when Paystack reports the payment did not succeed', async () => {
    paystackFailed();
    const res = await request(app).post('/fund-wallet/verify').set('Authorization', auth())
      .send({ reference: 'PSK123' });

    expect(res.status).toBe(402);
    expect(await balance()).toBe(500);
  });

  it('does not credit when the verification request fails', async () => {
    paystackUnavailable();
    const res = await request(app).post('/fund-wallet/verify').set('Authorization', auth())
      .send({ reference: 'PSK123' });

    expect(res.status).toBe(503);
    expect(await balance()).toBe(500);
  });
});
