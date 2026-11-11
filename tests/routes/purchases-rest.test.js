import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const catalogRepo = require('../../src/repositories/catalog');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const auth = () => `Bearer ${jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET, { subject: 'user-1' })}`;
const balance = async () => (await collection('USERS').findOne({ _id: 'user-1' })).balance;
const stubFetch = (body, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status, text: async () => JSON.stringify(body) });

describe('cable, electricity and epin purchases', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('user-1', { email: 'u@x.com', account: 'USER', balance: 20000 });
    await catalogRepo.insertMany('CABLES', [{ CableName: 'DSTV', CableID: 2, active: true }]);
    await catalogRepo.insertMany('CABLESPLAN', [
      { CableplanID: 5, CableplanName: 'DStv Compact', amount: 9000, category: 'dstv', active: true },
    ]);
    await catalogRepo.insertMany('ELECTRICITY', [{ Disconame: 'Ikeja Electric', DiscoID: 1, active: true }]);
    await catalogRepo.insertMany('EPIN', [{ examid: 1, examName: 'WAEC', amount: 2500, active: true }]);
  });
  afterEach(() => vi.restoreAllMocks());

  const cablePlanId = async () => (await request(app).get('/catalog/cable-plans')).body[0].id;
  const examId = async () => (await request(app).get('/catalog/exam-types')).body[0].id;

  it('buys a cable plan at the catalog price', async () => {
    stubFetch({ Status: 'successful', ident: 'c-1' });
    const res = await request(app).post('/buy-cable').set('Authorization', auth()).send({
      provider: 'DStv', planId: await cablePlanId(), smartcard: '1234567890', customerName: 'A Person',
    });

    expect(res.status).toBe(200);
    expect(res.body.wallet).toBe(11000);
    expect(await balance()).toBe(11000);
  });

  it('rejects an unknown cable provider with 422', async () => {
    const res = await request(app).post('/buy-cable').set('Authorization', auth()).send({
      provider: 'Nosuch', planId: await cablePlanId(), smartcard: '1234567890',
    });
    expect(res.status).toBe(422);
    expect(await balance()).toBe(20000);
  });

  it('buys electricity and returns the token', async () => {
    stubFetch({ Status: 'successful', ident: 'e-1', token: '1234-5678' });
    const res = await request(app).post('/buy-electricity').set('Authorization', auth()).send({
      disco: 'Ikeja Electric', meterType: 'Prepaid', meter: '04123456789',
      amount: 1000, phone: '08000000000', customerName: 'A Person',
    });

    expect(res.status).toBe(200);
    expect(res.body.wallet).toBe(19000);
    expect(res.body.token).toBe('1234-5678');
  });

  it('rejects an electricity amount below the minimum', async () => {
    const res = await request(app).post('/buy-electricity').set('Authorization', auth()).send({
      disco: 'Ikeja Electric', meterType: 'Prepaid', meter: '04123456789', amount: 100, phone: '08000000000',
    });
    expect(res.status).toBe(422);
    expect(await balance()).toBe(20000);
  });

  it('still debits and returns token: null rather than failing when the provider response has no token', async () => {
    stubFetch({ Status: 'successful', ident: 'e-2' });
    const res = await request(app).post('/buy-electricity').set('Authorization', auth()).send({
      disco: 'Ikeja Electric', meterType: 'Prepaid', meter: '04123456789',
      amount: 1000, phone: '08000000000', customerName: 'A Person',
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBe(null);
    expect(res.body.wallet).toBe(19000);
    expect(await balance()).toBe(19000);
  });

  it('buys exam pins, charging unit price times quantity, and normalises pins to strings for the frontend', async () => {
    // resultchecker.vue declares pins as string[] and renders/copies each entry
    // directly -- forwarding the provider's raw {pin, serial} objects would show
    // "[object Object]" to a customer who has already been charged. The
    // serial is included because a result-checker PIN alone is unusable.
    stubFetch({ Status: 'successful', ident: 'x-1', pins: [{ pin: '111', serial: 'S1' }] });
    const res = await request(app).post('/result-checker').set('Authorization', auth())
      .send({ examId: await examId(), quantity: 2 });

    expect(res.status).toBe(200);
    expect(res.body.wallet).toBe(15000);
    expect(res.body.pins).toEqual(['S1 / 111']);
  });

  it('returns an empty pins array rather than failing when the provider response has no pins key', async () => {
    stubFetch({ Status: 'successful', ident: 'x-2' });
    const res = await request(app).post('/result-checker').set('Authorization', auth())
      .send({ examId: await examId(), quantity: 1 });

    expect(res.status).toBe(200);
    expect(res.body.pins).toEqual([]);
    expect(await balance()).toBe(17500);
  });

  it('rejects a quantity outside 1..20', async () => {
    const id = await examId();
    expect((await request(app).post('/result-checker').set('Authorization', auth()).send({ examId: id, quantity: 0 })).status).toBe(422);
    expect((await request(app).post('/result-checker').set('Authorization', auth()).send({ examId: id, quantity: 21 })).status).toBe(422);
  });
});
