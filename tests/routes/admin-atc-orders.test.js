import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const request = require('supertest');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');
const { collection } = require('../../src/services/mongo');
const app = require('../../src/app');
const jwt = require('jsonwebtoken');

const asAdmin = () => `Bearer ${jwt.sign({ uid: 'admin-1', account: 'ADMIN' }, process.env.JWT_SECRET || 'test-secret')}`;
const asUser  = () => `Bearer ${jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET || 'test-secret')}`;

// The exact key set a listing row is allowed to carry. toMatchObject would
// pass even if the route started spreading the raw ATCORDERS document (uid,
// accountName, accountNumber, bankName and all) alongside these -- asserting
// the full key set is what actually pins the explicit-field-selection
// discipline the route is supposed to follow.
const ROW_KEYS = [
  'id', 'reference', 'userId', 'username', 'network', 'atcNumber',
  'percent', 'claimedAmount', 'expectedAmount', 'status', 'createdAt',
].sort();

describe('/admin/atc-orders', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await collection('USERS').insertMany([
      { _id: 'admin-1', account: 'ADMIN', setUpProcess: true, balance: 0 },
      { _id: 'user-1', account: 'USER', balance: 1000, username: 'ada' },
    ]);
    await collection('ATCORDERS').insertMany([
      { _id: 'atc_1', transref: 'atc_1', uid: 'user-1', network: 'MTN', atcNumber: '0803',
        percent: 80, amount: 5000, reciveAmount: 4000, status: 'pending', CreatedAt: new Date() },
      { _id: 'atc_done', transref: 'atc_done', uid: 'user-1', network: 'GLO', atcNumber: '0805',
        percent: 80, amount: 1000, reciveAmount: 800, status: 'success', CreatedAt: new Date() },
    ]);
  });

  it('refuses a non-admin on both routes', async () => {
    expect((await request(app).get('/admin/atc-orders').set('Authorization', asUser())).status).toBe(403);
    expect((await request(app).put('/admin/atc-orders/atc_1').set('Authorization', asUser())
      .send({ decision: 'reject', reason: 'x' })).status).toBe(403);
  });

  it('defaults to the pending queue and carries what the operator needs', async () => {
    const res = await request(app).get('/admin/atc-orders').set('Authorization', asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.id)).toEqual(['atc_1']);
    // Exact shape, not toMatchObject: an extra property (uid, accountName,
    // accountNumber, bankName -- anything a raw spread would leak) must fail
    // this test, since the row's only job is to NOT carry those.
    expect(Object.keys(res.body.items[0]).sort()).toEqual(ROW_KEYS);
    expect(res.body.items[0]).toMatchObject({
      network: 'MTN', claimedAmount: 5000, percent: 80, username: 'ada',
    });
  });

  it('can list another status explicitly', async () => {
    const res = await request(app).get('/admin/atc-orders?status=success').set('Authorization', asAdmin());
    expect(res.body.items.map((i) => i.id)).toEqual(['atc_done']);
  });

  it('an unknown status matches nothing rather than 500ing or returning everything', async () => {
    const res = await request(app).get('/admin/atc-orders?status=nonsense').set('Authorization', asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('approves, crediting from the received amount', async () => {
    const res = await request(app).put('/admin/atc-orders/atc_1').set('Authorization', asAdmin())
      .send({ decision: 'approve', receivedAmount: 4800, reason: 'confirmed' });
    expect(res.status).toBe(200);
    // percent (80) is the commission WITHHELD, not the payout share: credited
    // = received - (percent/100)*received = 4800 - 3840 = 960. Matches the
    // identical fixture in tests/models/atc-orders.test.js.
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1960);
  });

  it('rejects without moving money, writing no wallet row, and marks the order rejected', async () => {
    const res = await request(app).put('/admin/atc-orders/atc_1').set('Authorization', asAdmin())
      .send({ decision: 'reject', reason: 'nothing arrived' });
    expect(res.status).toBe(200);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1000);
    // Not just "balance untouched" -- a route wiring bug that called the
    // wrong finance method could coincidentally leave the balance alone.
    // These pin that reject actually ran, not merely that approve did not.
    expect(await collection('WALLETTRANSACTIONS').countDocuments()).toBe(0);
    const row = await collection('ATCORDERS').findOne({ _id: 'atc_1' });
    expect(row.status).toBe('rejected');
    expect(row.rejectionReason).toBe('nothing arrived');
  });

  it('422s a decision on an order that is not pending, and writes nothing', async () => {
    const res = await request(app).put('/admin/atc-orders/atc_done').set('Authorization', asAdmin())
      .send({ decision: 'approve', receivedAmount: 1000, reason: 'x' });
    expect(res.status).toBe(422);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1000);
  });

  it('422s an unknown decision and a missing received amount on approve', async () => {
    expect((await request(app).put('/admin/atc-orders/atc_1').set('Authorization', asAdmin())
      .send({ decision: 'maybe', reason: 'x' })).status).toBe(422);
    expect((await request(app).put('/admin/atc-orders/atc_1').set('Authorization', asAdmin())
      .send({ decision: 'approve', reason: 'x' })).status).toBe(422);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1000);
  });
});
