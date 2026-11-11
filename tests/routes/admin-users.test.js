import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const asAdmin = () => `Bearer ${jwt.sign({ uid: 'admin-1', account: 'ADMIN' }, process.env.JWT_SECRET, { subject: 'admin-1' })}`;
const asUser = () => `Bearer ${jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET, { subject: 'user-1' })}`;
const balanceOf = async (uid) => (await collection('USERS').findOne({ _id: uid })).balance;

describe('GET /admin/users', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('admin-1', { email: 'a@x.com', account: 'ADMIN', balance: 0 });
    await users.create('user-1', {
      email: 'u@x.com', account: 'USER', balance: 500, username: 'sam', phone: '0800',
      passwd: 'leaked', paystacksecretkey: 'sk_leaked',
    });
  });

  it('returns the paginated object shape the page tolerates', async () => {
    const res = await request(app).get('/admin/users').set('Authorization', asAdmin());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
    expect(res.body).toHaveProperty('nextCursor');
  });

  it('presents wallet and role, and never leaks secrets', async () => {
    const res = await request(app).get('/admin/users').set('Authorization', asAdmin());
    const row = res.body.users.find((u) => u.id === 'user-1');

    expect(row).toMatchObject({ username: 'sam', email: 'u@x.com', wallet: 500, role: 'USER', phone: '0800' });
    expect(row.passwd).toBeUndefined();
    expect(row.paystacksecretkey).toBeUndefined();
  });

  it('refuses a non-admin', async () => {
    expect((await request(app).get('/admin/users').set('Authorization', asUser())).status).toBe(403);
  });

  it('refuses a non-admin on the mutating route too', async () => {
    // The GET case above would still pass if PUT were moved to a router mounted
    // without requireAdmin. This asserts the mutating route directly.
    // Target a DIFFERENT user than the caller: a self-targeted PUT would 422 on
    // the self-role-change guard even without requireAdmin, which would isolate
    // nothing.
    const res = await request(app)
      .put('/admin/users/admin-1')
      .set('Authorization', asUser())
      .send({ role: 'ADMIN' });
    expect(res.status).toBe(403);
  });
});

describe('PUT /admin/users/:id', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('admin-1', { email: 'a@x.com', account: 'ADMIN', balance: 0 });
    await users.create('user-1', { email: 'u@x.com', account: 'USER', balance: 500 });
  });

  it('changes a role and writes an audit row', async () => {
    const res = await request(app).put('/admin/users/user-1').set('Authorization', asAdmin())
      .send({ role: 'ADMIN' });

    expect(res.status).toBe(200);
    expect(res.body.item.role).toBe('ADMIN');
    expect(await collection('AUDITLOG').findOne({ action: 'role.change' })).toMatchObject({
      adminUid: 'admin-1', targetUid: 'user-1', from: 'USER', to: 'ADMIN',
    });
  });

  it('rejects an unknown role', async () => {
    const res = await request(app).put('/admin/users/user-1').set('Authorization', asAdmin())
      .send({ role: 'SUPERUSER' });
    expect(res.status).toBe(422);
    expect((await users.findByUid('user-1')).account).toBe('USER');
  });

  it('refuses an admin changing their own role', async () => {
    const res = await request(app).put('/admin/users/admin-1').set('Authorization', asAdmin())
      .send({ role: 'USER' });
    expect(res.status).toBe(422);
    expect((await users.findByUid('admin-1')).account).toBe('ADMIN');
  });

  it('still lets an admin adjust their own balance', async () => {
    // The self-role guard sits inside the `role` branch on purpose.
    const res = await request(app).put('/admin/users/admin-1').set('Authorization', asAdmin())
      .send({ adjustment: { amount: 250, reason: 'reconciliation' } });

    expect(res.status).toBe(200);
    expect(res.body.item.wallet).toBe(250);
    expect(await balanceOf('admin-1')).toBe(250);
  });

  it('applies a signed balance adjustment through the finance layer', async () => {
    const res = await request(app).put('/admin/users/user-1').set('Authorization', asAdmin())
      .send({ adjustment: { amount: 250, reason: 'refund for T123' } });

    expect(res.status).toBe(200);
    expect(res.body.item.wallet).toBe(750);
    expect(await balanceOf('user-1')).toBe(750);

    // Visible in the customer's own wallet summary like any other movement.
    const row = await collection('WALLETTRANSACTIONS').findOne({ uid: 'user-1' });
    expect(row).toMatchObject({ mode: 'admin-credit', amount: 250, prevBal: 500, newBal: 750 });
  });

  it('refuses an adjustment with no reason', async () => {
    const res = await request(app).put('/admin/users/user-1').set('Authorization', asAdmin())
      .send({ adjustment: { amount: 250 } });
    expect(res.status).toBe(422);
    expect(await balanceOf('user-1')).toBe(500);
  });

  it('refuses an adjustment that would go negative', async () => {
    const res = await request(app).put('/admin/users/user-1').set('Authorization', asAdmin())
      .send({ adjustment: { amount: -5000, reason: 'oops' } });
    expect(res.status).toBe(422);
    expect(await balanceOf('user-1')).toBe(500);
  });

  it('never writes balance directly, even if the body carries one', async () => {
    // This is the ONLY test anywhere guarding the core guarantee of this
    // sub-project: a balance can move solely through the audited
    // finance.adjustBalance path, never via a raw wallet/balance field in the
    // request body. Do not simplify or remove this test.
    // The old dialog posted an absolute `wallet`. It must be ignored entirely.
    await request(app).put('/admin/users/user-1').set('Authorization', asAdmin())
      .send({ wallet: 999999, balance: 999999, role: 'USER' });

    expect(await balanceOf('user-1')).toBe(500);
  });

  it('404s an unknown user', async () => {
    const res = await request(app).put('/admin/users/ghost').set('Authorization', asAdmin())
      .send({ role: 'USER' });
    expect(res.status).toBe(404);
  });
});
