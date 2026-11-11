import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const asAdmin = () => `Bearer ${jwt.sign({ uid: 'admin-1', account: 'ADMIN' }, process.env.JWT_SECRET, { subject: 'admin-1' })}`;
const asUser = () => `Bearer ${jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET, { subject: 'user-1' })}`;

describe('GET /admin/stats', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('admin-1', { email: 'a@x.com', account: 'ADMIN' });
    await users.create('user-1', { email: 'u@x.com', account: 'USER' });
  });

  it('returns the three counts the page reads', async () => {
    await collection('TRANSACTIONS').insertMany([
      { _id: 't1', uid: 'user-1', amount: 100, CreatedAt: new Date() },
      { _id: 't2', uid: 'user-1', amount: 200, CreatedAt: new Date() },
    ]);
    await collection('WALLETTRANSACTIONS').insertOne({ _id: 'w1', uid: 'user-1', amount: 500, CreatedAt: new Date() });

    const res = await request(app).get('/admin/stats').set('Authorization', asAdmin());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userCount: 2, txCount: 2, walletTxCount: 1, waitlistCount: 0 });
  });

  it('returns zeros on an empty system rather than failing', async () => {
    await clearTestMongo();
    await users.create('admin-1', { email: 'a@x.com', account: 'ADMIN' });
    const res = await request(app).get('/admin/stats').set('Authorization', asAdmin());
    expect(res.body).toEqual({ userCount: 1, txCount: 0, walletTxCount: 0, waitlistCount: 0 });
  });

  it('refuses a non-admin', async () => {
    expect((await request(app).get('/admin/stats').set('Authorization', asUser())).status).toBe(403);
  });
});
