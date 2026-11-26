import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
const crypto = require('crypto');
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.PROVIDER_SMEAPI_TOKEN ||= 'test-smeapi-token';
process.env.ACTIVE_PROVIDER = 'smeapi';

const app = require('../../src/app');
const users = require('../../src/repositories/users');
const catalogRepo = require('../../src/repositories/catalog');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const token = (uid, account = 'USER') => `Bearer ${jwt.sign({ uid, account }, process.env.JWT_SECRET, { subject: uid })}`;
const sign = (raw) => crypto.createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET).update(raw).digest('hex');
const guest = { name: 'Ada Guest', email: 'ada@guest.com', guestId: 'gst_abcdef123' };
const dataOrder = { service: 'data', details: { network: 'MTN', planId: 'plan-1gb', phone: '08031234567' } };

let ipSeq = 0;
let ip;
const api = (method, path) => request(app)[method](path).set('X-Forwarded-For', ip);

// Paystack and SME API stubbed by URL. `provider` is what SME API answers to a
// purchase: 'success', 'failed' or 'unknown' (a 500, outcome unknown).
function stubUpstream({ provider = 'success', paid = null, refund = true } = {}) {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: u, body });
    const reply = (status, json) => ({ status, text: async () => JSON.stringify(json) });
    if (u.includes('/transaction/verify/')) {
      const reference = decodeURIComponent(u.split('/transaction/verify/')[1]);
      return reply(200, { status: true, data: { status: 'success', reference, amount: paid ?? stubUpstream.lastCharge, currency: 'NGN', channel: 'card' } });
    }
    if (u.includes('/refund')) return refund ? reply(200, { status: true, data: {} }) : reply(400, { status: false, message: 'Refund not allowed' });
    if (u.includes('smeapi')) {
      if (provider === 'success') return reply(200, { Status: 'successful', ident: 'sme-1' });
      if (provider === 'failed') return reply(200, { Status: 'failed', api_response: 'Number not valid' });
      return reply(500, { detail: 'gateway' });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  return calls;
}

async function placeOrder(order = dataOrder, who = guest) {
  const res = await api('post', '/guest/orders').send({ guest: who, ...order });
  stubUpstream.lastCharge = res.body.chargeKobo;
  return res;
}

describe('guest quick buy', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    ip = `10.20.0.${++ipSeq}`;
    await clearTestMongo();
    await users.create('adm', { email: 'a@x.com', account: 'ADMIN', balance: 0 });
    await users.create('u1', { email: 'u1@x.com', account: 'USER', balance: 0 });
    await catalogRepo.insertMany('NETWORKS', [{ _id: 'net-mtn', name: 'MTN', smeapiNetworkId: 1 }]);
    await catalogRepo.insertMany('DATAPACKS', [{ _id: 'plan-1gb', networkId: 'net-mtn', planType: 'SME', Size: '1GB', Validity: '30 days', Amount: '₦500.0', smeapiDataPlanId: 7 }]);
    // ₦50 + 1% card fee, added on top.
    await request(app).post('/admin/fees/rules').set('Authorization', token('adm', 'ADMIN'))
      .send({ rule: { name: 'Card', minAmount: 100, mode: 'on_top', flatFee: 50, percentFee: 1 } });
  });
  afterEach(() => vi.restoreAllMocks());

  it('quotes the catalog price plus the card fee', async () => {
    const res = await api('post', '/guest/quote').send(dataOrder);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ label: 'MTN 1GB data', price: 500, fee: 55, charge: 555 });
  });

  it('refuses a bad order before any payment', async () => {
    const bad = await api('post', '/guest/orders').send({ guest, service: 'data', details: { network: 'MTN', planId: 'nope', phone: '08031234567' } });
    expect(bad.status).toBe(422);
    const noEmail = await api('post', '/guest/orders').send({ guest: { name: 'Ada' }, ...dataOrder });
    expect(noEmail.status).toBe(422);
    expect(await collection('GUESTORDERS').countDocuments()).toBe(0);
  });

  it('delivers a paid order from a temporary wallet that ends empty', async () => {
    const created = await placeOrder();
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ charge: 555, price: 500, fee: 55, email: 'ada@guest.com' });
    expect(created.body.reference).toMatch(/^SWZG-/);

    const calls = stubUpstream({ provider: 'success' });
    const done = await api('post', `/guest/orders/${created.body.reference}/verify`).send({ token: created.body.token });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'delivered', label: 'MTN 1GB data', recipient: '08031234567', charge: 555 });
    expect(calls.filter((c) => c.url.includes('smeapi'))).toHaveLength(1);

    const order = await collection('GUESTORDERS').findOne({ _id: created.body.reference });
    const temp = await collection('USERS').findOne({ _id: order.tempUid });
    expect(temp).toMatchObject({ account: 'GUEST', email: null, guestEmail: 'ada@guest.com', balance: 0 });
    // The private link works only with its token.
    expect((await api('get', `/guest/orders/${created.body.reference}?t=${created.body.token}`)).body.status).toBe('delivered');
    expect((await api('get', `/guest/orders/${created.body.reference}?t=wrong`)).status).toBe(404);
  });

  it('refunds the card in full when the provider declines', async () => {
    const created = await placeOrder();
    const calls = stubUpstream({ provider: 'failed' });
    const res = await api('post', `/guest/orders/${created.body.reference}/verify`).send({ token: created.body.token });
    expect(res.body.status).toBe('refunded');
    expect(res.body.refunded).toBe(555);
    const refund = calls.find((c) => c.url.includes('/refund'));
    expect(refund.body).toEqual({ transaction: created.body.reference, amount: 55500 });
    const order = await collection('GUESTORDERS').findOne({ _id: created.body.reference });
    expect((await collection('USERS').findOne({ _id: order.tempUid })).balance).toBe(0);
  });

  it('holds an unconfirmed order, then follows the requery ruling', async () => {
    const created = await placeOrder();
    stubUpstream({ provider: 'unknown' });
    const res = await api('post', `/guest/orders/${created.body.reference}/verify`).send({ token: created.body.token });
    expect(res.body.status).toBe('held');

    const order = await collection('GUESTORDERS').findOne({ _id: created.body.reference });
    const calls = stubUpstream();
    const ruling = await request(app).put(`/admin/requery/${order.purchaseRef}`).set('Authorization', token('adm', 'ADMIN'))
      .send({ decision: 'reverse', reason: 'provider confirmed failure' });
    expect(ruling.status).toBe(200);
    expect((await collection('GUESTORDERS').findOne({ _id: created.body.reference })).status).toBe('refunded');
    expect(calls.some((c) => c.url.includes('/refund'))).toBe(true);
  });

  it('runs once when the webhook and the browser both confirm', async () => {
    const created = await placeOrder();
    const calls = stubUpstream({ provider: 'success' });
    const raw = JSON.stringify({ event: 'charge.success', data: { status: 'success', reference: created.body.reference, amount: created.body.chargeKobo, currency: 'NGN', channel: 'card' } });
    await request(app).post('/wenbook').set('Content-Type', 'application/json').set('x-paystack-signature', sign(raw)).send(raw);
    await new Promise((r) => setTimeout(r, 400));
    const res = await api('post', `/guest/orders/${created.body.reference}/verify`).send({ token: created.body.token });
    expect(res.body.status).toBe('delivered');
    expect(calls.filter((c) => c.url.includes('smeapi'))).toHaveLength(1);
  });

  it('refunds an underpayment without buying anything', async () => {
    const created = await placeOrder();
    const calls = stubUpstream({ paid: 30000 });
    const res = await api('post', `/guest/orders/${created.body.reference}/verify`).send({ token: created.body.token });
    expect(res.body.status).toBe('refunded');
    expect(calls.some((c) => c.url.includes('smeapi'))).toBe(false);
    expect(calls.find((c) => c.url.includes('/refund')).body.amount).toBe(30000);
  });

  it("never credits a guest's payment to a signed-in wallet", async () => {
    const created = await placeOrder();
    stubUpstream();
    const res = await request(app).post('/fund-wallet/verify').set('Authorization', token('u1')).send({ reference: created.body.reference });
    expect(res.status).toBe(409);
    expect((await collection('USERS').findOne({ _id: 'u1' })).balance).toBe(0);
  });

  it('records a refused refund for staff to retry', async () => {
    const created = await placeOrder();
    stubUpstream({ provider: 'failed', refund: false });
    const res = await api('post', `/guest/orders/${created.body.reference}/verify`).send({ token: created.body.token });
    expect(res.body.status).toBe('refund_failed');

    const list = await request(app).get('/admin/guest-orders?status=refund_failed').set('Authorization', token('adm', 'ADMIN'));
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ reference: created.body.reference, guest: { email: 'ada@guest.com' }, refundError: 'Refund not allowed' });

    vi.restoreAllMocks();
    stubUpstream({ refund: true });
    const retry = await request(app).post(`/admin/guest-orders/${created.body.reference}/refund`).set('Authorization', token('adm', 'ADMIN'));
    expect(retry.body.status).toBe('refunded');
  });

  it('caps orders per order and per email per day, and can be switched off', async () => {
    const admin = (settings) => request(app).put('/admin/ai/settings').set('Authorization', token('adm', 'ADMIN')).send({ settings });
    await admin({ guestMaxOrder: 400 });
    expect((await placeOrder()).body.code).toBe('GUEST_LIMIT');

    await admin({ guestMaxOrder: 20000, guestDailyLimitPerEmail: 900 });
    const first = await placeOrder();
    stubUpstream({ provider: 'success' });
    await api('post', `/guest/orders/${first.body.reference}/verify`).send({ token: first.body.token });
    const second = await placeOrder();
    expect(second.status).toBe(422);
    expect(second.body.code).toBe('GUEST_LIMIT');

    await admin({ guestQuickBuyEnabled: false });
    expect((await api('post', '/guest/quote').send(dataOrder)).status).toBe(403);
  });
});
