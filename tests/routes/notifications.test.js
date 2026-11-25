import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const request = require('supertest');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const { finance } = require('../../src/models/finance');
const { signSession } = require('../../src/middleware');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const as = (uid) => `Bearer ${signSession({ uid })}`;
const list = async (uid = 'u1') => (await request(app).get('/notifications').set('Authorization', as(uid))).body;
const post = (path, body) => request(app).post(path).set('Authorization', as('u1')).send(body);
const reserve = (transref, channel = 'Airtime') =>
  finance.reserveFunds({ uid: 'u1', amount: 500, transref, channel, createdAt: new Date().toISOString() });

describe('notifications', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    for (const u of ['u1', 'u2']) await users.create(u, { email: `${u}@x.com`, account: 'USER', balance: 5000 });
  });

  it('covers success, refund, pending, top-up and admin adjustments', async () => {
    await reserve('pur_ok0001'); await finance.settle({ transref: 'pur_ok0001' });
    await reserve('pur_bad001', 'Data'); await finance.reverse({ uid: 'u1', transref: 'pur_bad001' });
    await reserve('pur_hold01', 'Cable'); await finance.holdForRequery({ transref: 'pur_hold01' });
    await finance.creditWallet({ uid: 'u1', amount: 2000, transref: 'ps_1' });
    await finance.adjustBalance({ uid: 'u1', amount: -100, reason: 'secret note', adminUid: 'admin' });
    const { notifications, unread } = await list();
    const bodies = notifications.map((n) => `${n.title}: ${n.body}`);
    expect(bodies).toEqual(expect.arrayContaining([
      'Payment successful: Your ₦500 Airtime payment was successful.',
      'Payment refunded: Your ₦500 Data payment failed and was refunded.',
      'Payment pending: Your ₦500 Cable TV payment is being confirmed.',
      'Wallet funded: ₦2,000 was added to your wallet.',
      'Wallet debited: ₦100 was removed from your wallet.',
    ]));
    expect(unread).toBe(5);
    expect(JSON.stringify(notifications)).not.toMatch(/secret note|admin/);
  });

  it('becomes unread again when a pending payment is resolved', async () => {
    await reserve('pur_hold01'); await finance.holdForRequery({ transref: 'pur_hold01' });
    const first = await list();
    await post('/notifications/read', { upTo: first.notifications[0].createdAt });
    expect((await list()).unread).toBe(0);
    await finance.resolveRequery({ transref: 'pur_hold01', decision: 'reverse', adminUid: 'a', reason: 'x' });
    const after = await list();
    expect(after).toMatchObject({ unread: 1, notifications: [{ title: 'Payment refunded', unread: true }] });
  });

  it('does not mark something newer than what was seen, nor the future', async () => {
    await finance.creditWallet({ uid: 'u1', amount: 10, transref: 'ps_1' });
    const seen = (await list()).notifications[0].createdAt;
    await new Promise((r) => setTimeout(r, 5));
    await finance.creditWallet({ uid: 'u1', amount: 20, transref: 'ps_2' });
    await post('/notifications/read', { upTo: seen });
    expect((await list()).unread).toBe(1);
    await post('/notifications/read', { upTo: '2999-01-01T00:00:00Z' });
    await new Promise((r) => setTimeout(r, 5));
    await finance.creditWallet({ uid: 'u1', amount: 30, transref: 'ps_3' });
    expect((await list()).unread).toBe(1);
  });

  it('reports account events and keeps users apart', async () => {
    await post('/pin/set', { pin: '4821' });
    await post('/pin/change', { currentPin: '4821', newPin: '5555' });
    await post('/account', { fullname: 'A' });
    for (let i = 0; i < 5; i++) await post('/buy-airtime', { pin: '0000' });
    expect((await list()).notifications.map((n) => n.title)).toEqual(['PIN locked', 'Profile updated', 'PIN changed', 'PIN created']);
    expect(await list('u2')).toEqual({ notifications: [], unread: 0 });
    expect((await request(app).get('/notifications')).status).toBe(401);
  });
});
