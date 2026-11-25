import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const request = require('supertest');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const { authfunc } = require('../../src/services/index');
const { signSession } = require('../../src/middleware');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

let uid;
let n = 0;
const call = (method, path, body) =>
  request(app)[method](path).set('Authorization', `Bearer ${signSession({ uid })}`).send(body);
const post = (path, body) => call('post', path, body);

describe('transaction PIN', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    uid = `user-${++n}`; // fresh uid so the reset limiter does not carry over
    await users.create(uid, { email: 'u@x.com', account: 'USER', balance: 500 });
  });
  afterEach(() => vi.restoreAllMocks());

  it('sets once, reports status, and never stores or returns the PIN', async () => {
    expect((await call('get', '/pin/status')).body).toEqual({ hasPin: false });
    expect((await post('/pin/set', { pin: '4821' })).status).toBe(201);
    expect((await call('get', '/pin/status')).body).toEqual({ hasPin: true });
    expect((await post('/pin/set', { pin: '9999' })).status).toBe(409);
    const doc = await collection('USERPINS').findOne({ _id: uid });
    expect(doc.hash).not.toContain('4821');
    expect(JSON.stringify((await post('/userData', {})).body)).not.toContain(doc.hash);
  });

  it.each([undefined, '', '123', '12345', 'abcd', 1234, { $ne: null }])('rejects malformed PIN %j', async (pin) => {
    expect((await post('/pin/set', { pin })).status).toBe(422);
  });

  const SPEND = ['/buy-data', '/buy-airtime', '/buy-cable', '/buy-electricity', '/result-checker',
    '/airtime', '/data', '/cables/buy', '/electricity/buy', '/buyepin'];

  it.each(SPEND)('%s refuses a missing or wrong PIN and lets the right one through', async (path) => {
    await post('/pin/set', { pin: '4821' });
    expect((await post(path, {})).status).toBe(422);
    expect((await post(path, { pin: '0000' })).body.code).toBe('INVALID_PIN');
    const ok = await post(path, { pin: '4821' });
    expect(ok.body.msg).not.toMatch(/PIN/); // reached the route's own validation
  });

  it('keeps PIN-less accounts working for older apps, but never accepts an unchecked PIN', async () => {
    expect((await post('/buy-airtime', {})).body.msg).toMatch(/phone/);
    expect((await post('/buy-airtime', { pin: '1234' })).body.code).toBe('PIN_NOT_SET');
  });

  it('locks after five wrong attempts even when sent in parallel', async () => {
    await post('/pin/set', { pin: '4821' });
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => post('/buy-airtime', { pin: String(1000 + i) })));
    expect(rs.filter((r) => r.body.code === 'INVALID_PIN')).toHaveLength(5);
    expect(rs.filter((r) => r.body.code === 'PIN_LOCKED')).toHaveLength(15);
    expect((await post('/buy-airtime', { pin: '4821' })).body.code).toBe('PIN_LOCKED');
    await collection('USERPINS').updateOne({ _id: uid }, { $set: { lockedUntil: new Date(0) } });
    expect((await post('/buy-airtime', { pin: '0000' })).body.msg).toMatch(/4 tries/);
    expect((await post('/buy-airtime', { pin: '4821' })).body.msg).toMatch(/phone/);
  });

  it('changes only with the current PIN', async () => {
    await post('/pin/set', { pin: '4821' });
    expect((await post('/pin/change', { currentPin: '0000', newPin: '1111' })).status).toBe(403);
    expect((await post('/pin/change', { currentPin: '4821', newPin: '1111' })).status).toBe(200);
    expect((await post('/buy-airtime', { pin: '4821' })).body.code).toBe('INVALID_PIN');
  });

  it('resets only for the session owner’s own password', async () => {
    await post('/pin/set', { pin: '4821' });
    const login = vi.spyOn(authfunc, 'login');
    expect((await post('/pin/reset', { newPin: '1111' })).status).toBe(422);
    login.mockRejectedValueOnce(new Error('bad'));
    expect((await post('/pin/reset', { password: 'x', newPin: '1111' })).status).toBe(403);
    login.mockResolvedValueOnce({ user: { uid: 'someone-else' } });
    expect((await post('/pin/reset', { password: 'x', newPin: '1111' })).status).toBe(403);
    login.mockResolvedValueOnce({ user: { uid } });
    expect((await post('/pin/reset', { password: 'x', newPin: '1111', email: 'evil@x.com' })).status).toBe(200);
    expect(login).toHaveBeenLastCalledWith('u@x.com', 'x');
    expect((await post('/buy-airtime', { pin: '1111' })).body.msg).toMatch(/phone/);
  });

  it('requires a session', async () => {
    expect((await request(app).get('/pin/status')).status).toBe(401);
    expect((await request(app).post('/pin/set').send({ pin: '1234' })).status).toBe(401);
  });
});

describe('concurrent password changes', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['/change-password', { currentPassword: 'old' }, 'newPassword'],
    ['/auth/changepass', { oldpassword: 'old' }, 'newpassword'],
  ])('%s applies each change to its own account', async (path, body, field) => {
    await clearTestMongo();
    for (const id of ['a', 'b']) await users.create(id, { email: `${id}@x.com`, account: 'USER', balance: 0 });
    vi.spyOn(authfunc, 'login').mockImplementation(async (email) => {
      await new Promise((r) => setTimeout(r, email[0] === 'a' ? 10 : 40));
      return { user: { uid: email[0] } };
    });
    vi.spyOn(authfunc, 'signout').mockResolvedValue();
    const seen = {};
    vi.spyOn(authfunc, 'changePassword').mockImplementation(async (pw, user) => {
      await new Promise((r) => setTimeout(r, 40));
      seen[user.uid] = pw;
    });
    const rs = await Promise.all(['a', 'b'].map((id) => request(app).post(path)
      .set('Authorization', `Bearer ${signSession({ uid: id })}`).send({ ...body, email: `${id}@x.com`, [field]: `new-${id}-pass` })));
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    expect(seen).toEqual({ a: 'new-a-pass', b: 'new-b-pass' });
  });

  it('refuses to change a different account than the session’s', async () => {
    vi.spyOn(authfunc, 'login').mockResolvedValue({ user: { uid: 'victim' } });
    const change = vi.spyOn(authfunc, 'changePassword').mockResolvedValue();
    const res = await request(app).post('/auth/changepass').set('Authorization', `Bearer ${signSession({ uid: 'a' })}`)
      .send({ email: 'v@x.com', oldpassword: 'old', newpassword: 'newnew' });
    expect(res.status).toBe(401);
    expect(change).not.toHaveBeenCalled();
  });
});
