import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const token = (uid) => jwt.sign({ uid, account: 'USER' }, process.env.JWT_SECRET, { subject: uid });

describe('GET /transactions and /wallet-summary', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await collection('TRANSACTIONS').insertMany([
      { _id: 'pur_mine', uid: 'user-1', transType: 'Data', amount: 280, status: 'success', transref: 'pur_mine', CreatedAt: new Date() },
      { _id: 'pur_theirs', uid: 'user-2', transType: 'Data', amount: 500, status: 'success', transref: 'pur_theirs', CreatedAt: new Date() },
    ]);
    await collection('WALLETTRANSACTIONS').insertMany([
      { _id: 'w-uid', uid: 'user-1', mode: 'debit', amount: 280, prevBal: 500, newBal: 220, status: 'success', channel: 'Data', CreatedAt: new Date() },
      { _id: 'w-userid', userId: 'user-1', mode: 'credit', amount: 1000, prevBal: 0, newBal: 1000, status: 'success', channel: 'Wallet', CreatedAt: new Date() },
      { _id: 'w-theirs', uid: 'user-2', mode: 'debit', amount: 10, CreatedAt: new Date() },
    ]);
  });

  it('returns only the caller rows, in contract shape with an ISO createdAt', async () => {
    const res = await request(app).get('/transactions').set('Authorization', `Bearer ${token('user-1')}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 'pur_mine', type: 'Data', amount: 280, reference: 'pur_mine' });
    expect(res.body[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body[0].docid).toBeUndefined();
  });

  it('matches wallet rows under either owner field', async () => {
    const res = await request(app).get('/wallet-summary').set('Authorization', `Bearer ${token('user-1')}`);
    expect(res.body.map((r) => r.id).sort()).toEqual(['w-uid', 'w-userid']);
    expect(res.body.find((r) => r.id === 'w-uid')).toMatchObject({ mode: 'debit', prevBal: 500, newBal: 220 });
  });

  it('requires a session', async () => {
    expect((await request(app).get('/transactions')).status).toBe(401);
    expect((await request(app).get('/wallet-summary')).status).toBe(401);
  });
});
