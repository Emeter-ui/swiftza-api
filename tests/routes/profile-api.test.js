import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const { authfunc } = require('../../src/services/index');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const auth = () => `Bearer ${jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET, { subject: 'user-1' })}`;

describe('profile endpoints', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('user-1', { email: 'u@x.com', account: 'USER', balance: 500 });
  });
  afterEach(() => vi.restoreAllMocks());

  it('updates bank details and returns the presented user', async () => {
    const res = await request(app).post('/account').set('Authorization', auth())
      .send({ bankName: 'GTBank', accountName: 'A Person', accountNumber: '0123456789' });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: 'user-1', wallet: 500, role: 'USER',
      bankName: 'GTBank', accountName: 'A Person', accountNumber: '0123456789',
    });
    expect(res.body.user.passwd).toBeUndefined();
  });

  it('rejects an oversized or non-string accountNumber, matching what /atoc requires', async () => {
    // Without this, /account could store a value /atoc then rejects with
    // requireString(..., maxLength), leaving /atoc unusable for that user.
    const tooLong = await request(app).post('/account').set('Authorization', auth())
      .send({ accountNumber: '1'.repeat(21) });
    expect(tooLong.status).toBe(422);

    const wrongType = await request(app).post('/account').set('Authorization', auth())
      .send({ accountNumber: { hack: true } });
    expect(wrongType.status).toBe(422);

    const stored = await users.findByUid('user-1');
    expect(stored.accountNumber).toBeUndefined();
  });

  it('refuses to let /account write a protected field', async () => {
    // isAdmin/role/wallet aren't real USERS fields (balance/account are), but
    // sending them alongside balance/account is what distinguishes a genuine
    // allow-list from a deny-list targeted at just those two names — a
    // deny-list refactor (the pattern store.js already uses) would block
    // balance/account but let an attacker-chosen field like isAdmin through,
    // and the suite would stay green without this.
    await request(app).post('/account').set('Authorization', auth())
      .send({
        bankName: 'GTBank', balance: 999999, account: 'ADMIN',
        isAdmin: true, role: 'ADMIN', wallet: 999999,
      });

    const stored = await users.findByUid('user-1');
    expect(stored.balance).toBe(500);
    expect(stored.account).toBe('USER');
    expect(stored.isAdmin).toBeUndefined();
    expect(stored.role).toBeUndefined();
    expect(stored.wallet).toBeUndefined();
  });

  it('changes the password using the email from the session, not the body', async () => {
    const login = vi.spyOn(authfunc, 'login').mockResolvedValue({ user: { uid: 'user-1' } });
    vi.spyOn(authfunc, 'changePassword').mockResolvedValue(undefined);
    vi.spyOn(authfunc, 'signout').mockResolvedValue(undefined);

    const res = await request(app).post('/change-password').set('Authorization', auth())
      .send({ currentPassword: 'old-secret', newPassword: 'new-secret', email: 'attacker@x.com' });

    expect(res.status).toBe(200);
    // Reauthentication must use the session user's own email.
    expect(login).toHaveBeenCalledWith('u@x.com', 'old-secret');
  });

  it('rejects a short new password', async () => {
    const res = await request(app).post('/change-password').set('Authorization', auth())
      .send({ currentPassword: 'old-secret', newPassword: 'abc' });
    expect(res.status).toBe(422);
  });

  it('always returns the same message for a reset request', async () => {
    vi.spyOn(authfunc, 'reset').mockResolvedValue(undefined);
    const res = await request(app).post('/reset-password').send({ email: 'nobody@x.com' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if that email has an account/i);
  });

  it('requires a session for /account and /change-password', async () => {
    expect((await request(app).post('/account').send({})).status).toBe(401);
    expect((await request(app).post('/change-password').send({})).status).toBe(401);
  });
});
