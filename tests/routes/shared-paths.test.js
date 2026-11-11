import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const { authfunc } = require('../../src/services/index');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const token = (uid) => jwt.sign({ uid, account: 'USER' }, process.env.JWT_SECRET, { subject: uid });

describe('shared paths gain new-contract fields without losing legacy ones', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    vi.spyOn(authfunc, 'login').mockImplementation(async (email) => ({ user: { uid: `uid-for-${email}` } }));
    vi.spyOn(authfunc, 'signup').mockImplementation(async (email) => ({ user: { uid: `uid-for-${email}` } }));
    await users.create('uid-for-u@x.com', {
      email: 'u@x.com', account: 'USER', balance: 500, username: 'sam',
      phone: '08000000000', bankName: 'GTB', accountName: 'S U', accountNumber: '012',
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('POST /login returns BOTH data{uid,account} and user{...}', async () => {
    const res = await request(app).post('/login').send({ email: 'u@x.com', passwd: 'x' });
    expect(res.body.data).toEqual({ uid: 'uid-for-u@x.com', account: 'USER' });
    expect(res.body.user).toMatchObject({
      id: 'uid-for-u@x.com', email: 'u@x.com', wallet: 500, role: 'USER',
      username: 'sam', phone: '08000000000', bankName: 'GTB',
    });
    expect(res.body.user.passwd).toBeUndefined();
  });

  it('POST /login accepts `password` as well as `passwd` (samzeenuxt sends `password`)', async () => {
    const res = await request(app).post('/login').send({ email: 'u@x.com', password: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ uid: 'uid-for-u@x.com', account: 'USER' });
    expect(res.body.user).toMatchObject({ id: 'uid-for-u@x.com', email: 'u@x.com' });
    expect(authfunc.login).toHaveBeenCalledWith('u@x.com', 'x');
  });

  it('POST /signup accepts `password` as well as `passwd`', async () => {
    const res = await request(app).post('/signup').send({ email: 'new@x.com', password: 'secret123' });
    expect(res.status).toBe(201);
    const created = await users.findByUid('uid-for-new@x.com');
    expect(created).not.toBeNull();
    expect(created.passwd).toBeUndefined();
    expect(created.password).toBeUndefined();
  });

  it('POST /userData returns wallet and role alongside balance and account', async () => {
    const res = await request(app)
      .post('/userData')
      .set('Authorization', `Bearer ${token('uid-for-u@x.com')}`)
      .send({});
    expect(res.body.balance).toBe(500);
    expect(res.body.account).toBe('USER');
    expect(res.body.wallet).toBe(500);
    expect(res.body.role).toBe('USER');
    expect(res.body.id).toBe('uid-for-u@x.com');
  });
});
