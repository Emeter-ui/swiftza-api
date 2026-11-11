import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const crypto = require('crypto');
const request = require('supertest');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const event = {
  event: 'charge.success',
  data: { status: 'success', reference: 'pay-1', amount: 500000, channel: 'card', metadata: { id: 'user-1', email: 'u@x.com' } },
};

const sign = (raw) =>
  crypto.createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET).update(raw).digest('hex');

const balance = async () => (await collection('USERS').findOne({ _id: 'user-1' })).balance;

describe('POST /wenbook', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('user-1', { email: 'u@x.com', account: 'USER', balance: 0 });
  });

  it('rejects an unsigned event', async () => {
    const res = await request(app).post('/wenbook').set('Content-Type', 'application/json').send(JSON.stringify(event));
    expect(res.status).toBe(401);
  });

  it('rejects a wrongly signed event', async () => {
    const raw = JSON.stringify(event);
    const res = await request(app)
      .post('/wenbook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', sign('tampered'))
      .send(raw);

    expect(res.status).toBe(401);
    expect(await balance()).toBe(0);
  });

  it('credits the wallet once, even when replayed', async () => {
    const raw = JSON.stringify(event);
    const send = () =>
      request(app)
        .post('/wenbook')
        .set('Content-Type', 'application/json')
        .set('x-paystack-signature', sign(raw))
        .send(raw);

    expect((await send()).status).toBe(200);
    // The handler acknowledges before crediting, so give the async work a tick.
    await new Promise((r) => setTimeout(r, 200));
    expect(await balance()).toBe(5000);

    await send();
    await new Promise((r) => setTimeout(r, 200));
    expect(await balance()).toBe(5000);
  });
});
