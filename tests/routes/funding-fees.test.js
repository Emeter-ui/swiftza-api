import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
const crypto = require('crypto');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const token = (uid, account = 'USER') => `Bearer ${jwt.sign({ uid, account }, process.env.JWT_SECRET, { subject: uid })}`;
const balance = async (uid) => (await collection('USERS').findOne({ _id: uid })).balance;
const sign = (raw) => crypto.createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET).update(raw).digest('hex');

function stubPaystack(reference, amountKobo, extra = {}) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    status: 200,
    text: async () => JSON.stringify({ data: { status: 'success', reference, amount: amountKobo, channel: 'card', metadata: {}, ...extra } }),
  });
}

const admin = () => request(app);
const ONTOP = { name: 'Standard', minAmount: 100, maxAmount: null, mode: 'on_top', flatFee: 50, percentFee: 1 };

describe('wallet funding with fees', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('user-1', { email: 'u@x.com', account: 'USER', balance: 0 });
    await users.create('user-2', { email: 'v@x.com', account: 'USER', balance: 0 });
    await users.create('admin-1', { email: 'a@x.com', account: 'ADMIN', balance: 0 });
  });
  afterEach(() => vi.restoreAllMocks());

  it('admin creates a rule; quote and credit follow it', async () => {
    const created = await admin().post('/admin/fees/rules').set('Authorization', token('admin-1', 'ADMIN')).send({ rule: ONTOP });
    expect(created.status).toBe(201);

    const init = await request(app).post('/fund-wallet/initialize').set('Authorization', token('user-1')).send({ amount: 1000, method: 'card' });
    expect(init.status).toBe(200);
    expect(init.body.quote).toMatchObject({ charge: 1060, credit: 1000, fee: 60 });
    expect(init.body.reference).toMatch(/^SWZ-/);

    stubPaystack(init.body.reference, init.body.chargeKobo);
    const v = await request(app).post('/fund-wallet/verify').set('Authorization', token('user-1')).send({ reference: init.body.reference });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ wallet: 1000, credited: 1000, fee: 60 });

    const row = await collection('WALLETTRANSACTIONS').findOne({ uid: 'user-1' });
    expect(row).toMatchObject({ amount: 1000, grossPaid: 1060, totalFee: 60, feeMode: 'on_top', feeRuleName: 'Standard' });
    expect((await collection('FUNDINGINTENTS').findOne({ _id: init.body.reference })).status).toBe('credited');
  });

  it('webhook credits from the intent even without metadata.id, once', async () => {
    await admin().post('/admin/fees/rules').set('Authorization', token('admin-1', 'ADMIN')).send({ rule: ONTOP });
    const init = await request(app).post('/fund-wallet/initialize').set('Authorization', token('user-1')).send({ amount: 2000 });
    const raw = JSON.stringify({ event: 'charge.success', data: { status: 'success', reference: init.body.reference, amount: init.body.chargeKobo, channel: 'card', metadata: {} } });
    await request(app).post('/wenbook').set('Content-Type', 'application/json').set('x-paystack-signature', sign(raw)).send(raw);
    await new Promise((r) => setTimeout(r, 300));
    expect(await balance('user-1')).toBe(2000);

    stubPaystack(init.body.reference, init.body.chargeKobo);
    const v = await request(app).post('/fund-wallet/verify').set('Authorization', token('user-1')).send({ reference: init.body.reference });
    expect(v.body.message).toMatch(/already been credited/);
    expect(await balance('user-1')).toBe(2000);
  });

  it('refuses to credit an intent to a different signed-in account', async () => {
    const init = await request(app).post('/fund-wallet/initialize').set('Authorization', token('user-1')).send({ amount: 1000 });
    stubPaystack(init.body.reference, init.body.chargeKobo);
    const v = await request(app).post('/fund-wallet/verify').set('Authorization', token('user-2')).send({ reference: init.body.reference });
    expect(v.status).toBe(403);
    expect(await balance('user-2')).toBe(0);
  });

  it('credits only what an underpayment covers', async () => {
    await admin().post('/admin/fees/rules').set('Authorization', token('admin-1', 'ADMIN')).send({ rule: ONTOP });
    const init = await request(app).post('/fund-wallet/initialize').set('Authorization', token('user-1')).send({ amount: 1000 });
    stubPaystack(init.body.reference, 100000); // paid ₦1000, quote was ₦1060
    await request(app).post('/fund-wallet/verify').set('Authorization', token('user-1')).send({ reference: init.body.reference });
    const bal = await balance('user-1');
    expect(bal).toBeLessThan(1000);
    expect(bal).toBeGreaterThan(900);
  });

  it('a legacy reference without an intent is priced from the paid amount', async () => {
    await admin().post('/admin/fees/rules').set('Authorization', token('admin-1', 'ADMIN')).send({ rule: { ...ONTOP, mode: 'deducted', flatFee: 0, percentFee: 2 } });
    stubPaystack('SWZ-legacy-1', 500000);
    await request(app).post('/fund-wallet/verify').set('Authorization', token('user-1')).send({ reference: 'SWZ-legacy-1' });
    expect(await balance('user-1')).toBe(4900);
  });

  it('rejects a rule that overlaps an existing one, with the clash in details', async () => {
    const a = token('admin-1', 'ADMIN');
    await admin().post('/admin/fees/rules').set('Authorization', a).send({ rule: { ...ONTOP, maxAmount: 5000 } });
    const res = await admin().post('/admin/fees/rules').set('Authorization', a).send({ rule: { ...ONTOP, name: 'Second', minAmount: 4000, maxAmount: 9000 } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FEE_CONFIG_INVALID');
    expect(res.body.details.errors[0].code).toBe('RANGE_OVERLAP');
    expect((await admin().get('/admin/fees').set('Authorization', a)).body.rules).toHaveLength(1);
  });

  it('refuses a save built on a stale version', async () => {
    const a = token('admin-1', 'ADMIN');
    await admin().post('/admin/fees/rules').set('Authorization', a).send({ rule: ONTOP });
    const res = await admin().put('/admin/fees/settings').set('Authorization', a).send({ settings: { maxDeposit: 200000 }, expectedVersion: 0 });
    expect(res.status).toBe(409);
  });

  it('validate and simulate run without saving', async () => {
    const a = token('admin-1', 'ADMIN');
    const v = await admin().post('/admin/fees/validate').set('Authorization', a).send({ rules: [ONTOP, { ...ONTOP, name: 'Dup' }] });
    expect(v.body.ok).toBe(false);
    const s = await admin().post('/admin/fees/simulate').set('Authorization', a).send({ rules: [ONTOP], amount: 1000 });
    expect(s.body.quote.charge).toBe(1060);
    expect((await admin().get('/admin/fees').set('Authorization', a)).body.rules).toHaveLength(0);
  });

  it('blocks non-admins from the fee admin', async () => {
    expect((await admin().get('/admin/fees').set('Authorization', token('user-1'))).status).toBe(403);
  });

  it('enforces deposit limits on initialize', async () => {
    await admin().put('/admin/fees/settings').set('Authorization', token('admin-1', 'ADMIN')).send({ settings: { minDeposit: 500, maxDeposit: 100000 } });
    const res = await request(app).post('/fund-wallet/initialize').set('Authorization', token('user-1')).send({ amount: 200 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DEPOSIT_TOO_SMALL');
  });
});
