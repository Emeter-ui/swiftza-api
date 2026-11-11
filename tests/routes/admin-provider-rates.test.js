import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const request = require('supertest');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');
const { collection } = require('../../src/services/mongo');
const app = require('../../src/app');
const jwt = require('jsonwebtoken');

const asAdmin = () => `Bearer ${jwt.sign({ uid: 'admin-1', account: 'ADMIN' }, process.env.JWT_SECRET || 'test-secret')}`;
const asUser  = () => `Bearer ${jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET || 'test-secret')}`;

const row = {
  provider: 'vtpass', serviceLabel: 'MTN Airtime VTU', matchesTransType: 'airtime',
  expectedRate: 3, active: true,
};

describe('/admin/provider-rates', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await collection('USERS').insertMany([
      { _id: 'admin-1', account: 'ADMIN', setUpProcess: true, balance: 0 },
      { _id: 'user-1', account: 'USER', balance: 0 },
    ]);
  });

  it('refuses a non-admin', async () => {
    expect((await request(app).get('/admin/provider-rates').set('Authorization', asUser())).status).toBe(403);
  });

  it('creates, lists and reads back a rate', async () => {
    const created = await request(app).post('/admin/provider-rates').set('Authorization', asAdmin()).send(row);
    expect(created.status).toBe(201);
    expect(created.body.item).toMatchObject({ provider: 'vtpass', expectedRate: 3 });

    const listed = await request(app).get('/admin/provider-rates').set('Authorization', asAdmin());
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].serviceLabel).toBe('MTN Airtime VTU');
  });

  it('rejects a create missing a required field', async () => {
    const res = await request(app).post('/admin/provider-rates').set('Authorization', asAdmin())
      .send({ provider: 'vtpass' });
    expect(res.status).toBe(422);
  });

  // The factory sends only { active } when the console flips the toggle; the
  // merge in routes/admin/catalog.js must inherit the rest from storage.
  it('flips active without blanking the row', async () => {
    const created = await request(app).post('/admin/provider-rates').set('Authorization', asAdmin()).send(row);
    const id = created.body.item.id;

    const toggled = await request(app).put(`/admin/provider-rates/${id}`).set('Authorization', asAdmin())
      .send({ active: false });
    expect(toggled.status).toBe(200);

    const stored = await collection('PROVIDERRATES').findOne({});
    expect(stored.active).toBe(false);
    expect(stored.expectedRate).toBe(3);
    expect(stored.serviceLabel).toBe('MTN Airtime VTU');
  });

  it('refuses an unconfirmed delete', async () => {
    const created = await request(app).post('/admin/provider-rates').set('Authorization', asAdmin()).send(row);
    const id = created.body.item.id;

    expect((await request(app).delete(`/admin/provider-rates/${id}`).set('Authorization', asAdmin())).status).toBe(400);
    expect((await request(app).delete(`/admin/provider-rates/${id}?confirm=true`).set('Authorization', asAdmin())).status).toBe(200);
    expect(await collection('PROVIDERRATES').countDocuments({})).toBe(0);
  });
});
