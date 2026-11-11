import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
const crypto = require('crypto');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

// The webhook (wenbook.js), the legacy verify route (fundwallet.js) and the
// new-contract verify route (wallet.js) each independently credit the same
// Paystack payment. finance.creditWallet is idempotent on whatever _id it is
// given, but that only closes the loop if all three writers derive the SAME
// _id from the reference. This test drives one payment through two of the
// three writers (webhook + new /fund-wallet/verify) in both orders and
// asserts a single credit — it must fail if the writers ever diverge again,
// the way tests/models/finance.test.js (which shares one transref directly,
// bypassing the routes) could not catch.

const REFERENCE = 'shared-pay-1';
const AMOUNT_KOBO = 500000; // -> N5000

const webhookEvent = {
  event: 'charge.success',
  data: {
    status: 'success', reference: REFERENCE, amount: AMOUNT_KOBO,
    channel: 'card', metadata: { id: 'user-1', email: 'u@x.com' },
  },
};

const sign = (raw) =>
  crypto.createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET).update(raw).digest('hex');

const auth = () =>
  `Bearer ${jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET, { subject: 'user-1' })}`;

const balance = async () => (await collection('USERS').findOne({ _id: 'user-1' })).balance;

function postWebhook() {
  const raw = JSON.stringify(webhookEvent);
  return request(app)
    .post('/wenbook')
    .set('Content-Type', 'application/json')
    .set('x-paystack-signature', sign(raw))
    .send(raw);
}

function stubPaystackVerify() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    status: 200,
    text: async () => JSON.stringify({
      data: {
        status: 'success', reference: REFERENCE, amount: AMOUNT_KOBO,
        channel: 'card', metadata: { id: 'user-1', email: 'u@x.com' },
      },
    }),
  });
}

function postVerify() {
  return request(app)
    .post('/fund-wallet/verify')
    .set('Authorization', auth())
    .send({ reference: REFERENCE });
}

describe('wallet credit idempotency across writers', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('user-1', { email: 'u@x.com', account: 'USER', balance: 0 });
  });
  afterEach(() => vi.restoreAllMocks());

  it('credits exactly once when the webhook arrives before /fund-wallet/verify', async () => {
    await postWebhook();
    // The handler acknowledges before crediting, so give the async work a tick.
    await new Promise((r) => setTimeout(r, 200));
    expect(await balance()).toBe(5000);

    stubPaystackVerify();
    const res = await postVerify();

    expect(res.status).toBe(200);
    expect(res.body.wallet).toBe(5000);
    expect(await balance()).toBe(5000);
    // Both writers must have landed on the same WALLETTRANSACTIONS document.
    expect(await collection('WALLETTRANSACTIONS').countDocuments({})).toBe(1);
  });

  it('credits exactly once when /fund-wallet/verify arrives before the webhook', async () => {
    stubPaystackVerify();
    const res = await postVerify();
    expect(res.status).toBe(200);
    expect(res.body.wallet).toBe(5000);

    await postWebhook();
    await new Promise((r) => setTimeout(r, 200));

    expect(await balance()).toBe(5000);
    expect(await collection('WALLETTRANSACTIONS').countDocuments({})).toBe(1);
  });
});
