import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const catalogRepo = require('../../src/repositories/catalog');
const users = require('../../src/repositories/users');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const token = (uid) => jwt.sign({ uid, account: 'USER' }, process.env.JWT_SECRET, { subject: uid });

describe('POST /atc/place-order', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('user-1', { email: 'a@b.c', account: 'USER', balance: 0 });
    await catalogRepo.insertMany('ATC', [
      { network: 'MTN', number: '08000000000', percent: 10, active: true },
    ]);
  });

  const body = {
    transref: 'atc-ref-1',
    network: 'MTN',
    amount: 5000,
    accountName: 'A Person',
    accountNumber: '0123456789',
    bankName: 'GTBank',
  };

  it('places an order and computes the receive amount from the stored rate', async () => {
    const res = await request(app)
      .post('/atc/place-order')
      .set('Authorization', `Bearer ${token('user-1')}`)
      .send(body);

    expect(res.status).toBe(201);
    // 5000 less the 10% commission held in the ATC catalog, not the client body.
    expect(res.body.reciveAmount).toBe(4500);

    const order = await collection('ATCORDERS').findOne({ _id: 'atc-ref-1' });
    expect(order).toMatchObject({ uid: 'user-1', status: 'pending', validate: false, percent: 10 });
  });

  it('rejects a duplicate transref with 409', async () => {
    const send = () =>
      request(app)
        .post('/atc/place-order')
        .set('Authorization', `Bearer ${token('user-1')}`)
        .send(body);

    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(409);
    expect(await collection('ATCORDERS').countDocuments()).toBe(1);
  });

  it('rejects an unauthenticated request', async () => {
    expect((await request(app).post('/atc/place-order').send(body)).status).toBe(401);
  });

  it('rejects an amount below the minimum', async () => {
    const res = await request(app)
      .post('/atc/place-order')
      .set('Authorization', `Bearer ${token('user-1')}`)
      .send({ ...body, amount: 10 });

    expect(res.status).toBe(422);
  });
});
