import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const asAdmin = () => `Bearer ${jwt.sign({ uid: 'admin-1', account: 'ADMIN' }, process.env.JWT_SECRET, { subject: 'admin-1' })}`;
const asUser = () => `Bearer ${jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET, { subject: 'user-1' })}`;

const at = (min) => new Date(Date.UTC(2026, 8, 4, 12, min, 0));

describe('GET /admin/transactions', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('admin-1', { email: 'a@x.com', account: 'ADMIN' });
    await users.create('user-1', { email: 'u@x.com', account: 'USER', username: 'sam' });
    await users.create('user-2', { email: 'v@x.com', account: 'USER', username: 'ada' });

    await collection('TRANSACTIONS').insertMany([
      { _id: 'pur_a', uid: 'user-1', transType: 'Data', amount: 280, status: 'success', transref: 'pur_a', CreatedAt: at(1) },
      { _id: 'pur_b', uid: 'user-2', transType: 'Airtime-Reversed', amount: 100, status: 'reversed', transref: 'pur_b', CreatedAt: at(3) },
    ]);
    await collection('WALLETTRANSACTIONS').insertMany([
      { _id: 'ps_c', uid: 'user-1', mode: 'credit', channel: 'Wallet', amount: 1000, status: 'success', transref: 'ps_c', CreatedAt: at(2) },
      { _id: 'adj_d', uid: 'ghost-user', mode: 'admin-debit', channel: 'Adjustment', amount: 50, status: 'success', transref: 'adj_d', CreatedAt: at(4) },
    ]);
  });

  it('merges purchases and wallet movements into one time-ordered feed', async () => {
    const res = await request(app).get('/admin/transactions').set('Authorization', asAdmin());

    expect(res.status).toBe(200);
    // Newest first: adj_d(4), pur_b(3), ps_c(2), pur_a(1)
    expect(res.body.transactions.map((t) => t.id)).toEqual(['adj_d', 'pur_b', 'ps_c', 'pur_a']);
  });

  it('derives kind, stripping the -Reversed suffix, and marks wallet rows', async () => {
    const res = await request(app).get('/admin/transactions').set('Authorization', asAdmin());
    const byId = Object.fromEntries(res.body.transactions.map((t) => [t.id, t]));

    expect(byId['pur_a'].kind).toBe('data');
    expect(byId['pur_b'].kind).toBe('airtime');
    expect(byId['ps_c'].kind).toBe('wallet');
    expect(byId['adj_d'].kind).toBe('wallet');
  });

  it('sets type so the page can show the right sign', async () => {
    const res = await request(app).get('/admin/transactions').set('Authorization', asAdmin());
    const byId = Object.fromEntries(res.body.transactions.map((t) => [t.id, t]));

    expect(byId['pur_a'].type).toBe('debit');
    expect(byId['ps_c'].type).toBe('credit');
    expect(byId['adj_d'].type).toBe('debit');
  });

  it('joins usernames and tolerates a missing user', async () => {
    const res = await request(app).get('/admin/transactions').set('Authorization', asAdmin());
    const byId = Object.fromEntries(res.body.transactions.map((t) => [t.id, t]));

    expect(byId['pur_a'].username).toBe('sam');
    expect(byId['pur_b'].username).toBe('ada');
    // The page renders `tx.username || tx.userId`, so a deleted user must not break the row.
    expect(byId['adj_d'].username).toBeNull();
    expect(byId['adj_d'].userId).toBe('ghost-user');
  });

  it('emits ISO timestamps', async () => {
    const res = await request(app).get('/admin/transactions').set('Authorization', asAdmin());
    expect(res.body.transactions[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('filters to wallet rows only', async () => {
    const res = await request(app).get('/admin/transactions?kind=wallet').set('Authorization', asAdmin());
    expect(res.body.transactions.map((t) => t.id).sort()).toEqual(['adj_d', 'ps_c']);
  });

  it('filters to one purchase kind', async () => {
    const res = await request(app).get('/admin/transactions?kind=data').set('Authorization', asAdmin());
    expect(res.body.transactions.map((t) => t.id)).toEqual(['pur_a']);
  });

  it('walks a mixed feed exactly once with a cursor', async () => {
    const seen = [];
    let cursor = null;
    for (let guard = 0; guard < 6; guard += 1) {
      const url = `/admin/transactions?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await request(app).get(url).set('Authorization', asAdmin());
      seen.push(...res.body.transactions.map((t) => t.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(['adj_d', 'pur_b', 'ps_c', 'pur_a']);
    expect(new Set(seen).size).toBe(4);
  });

  it('refuses a non-admin', async () => {
    expect((await request(app).get('/admin/transactions').set('Authorization', asUser())).status).toBe(403);
  });

  // The compound {CreatedAt, _id} cursor exists ONLY to break ties between rows
  // sharing a timestamp. Seed a tie across BOTH collections and walk the whole
  // feed with a small page size: every seeded id must appear exactly once.
  it('T1 walks a tie of same-timestamp rows across both collections exactly once', async () => {
    const tie = at(10);
    await collection('TRANSACTIONS').insertMany([
      { _id: 'tie_a', uid: 'user-1', transType: 'Data', amount: 10, status: 'success', transref: 'tie_a', CreatedAt: tie },
      { _id: 'tie_b', uid: 'user-1', transType: 'Airtime', amount: 20, status: 'success', transref: 'tie_b', CreatedAt: tie },
    ]);
    await collection('WALLETTRANSACTIONS').insertOne(
      { _id: 'tie_c', uid: 'user-1', mode: 'credit', channel: 'Wallet', amount: 30, status: 'success', transref: 'tie_c', CreatedAt: tie }
    );

    const seededIds = ['pur_a', 'pur_b', 'ps_c', 'adj_d', 'tie_a', 'tie_b', 'tie_c'];

    const seen = [];
    let cursor = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const url = `/admin/transactions?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await request(app).get(url).set('Authorization', asAdmin());
      seen.push(...res.body.transactions.map((t) => t.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }

    // Comparing the full sorted multiset catches a skip and a repeat alike: a
    // duplicate changes the multiset even when the array length happens to match.
    expect(seen.slice().sort()).toEqual(seededIds.slice().sort());
  });

  it('T2 returns nothing for an unknown kind', async () => {
    const res = await request(app).get('/admin/transactions?kind=xyz').set('Authorization', asAdmin());

    expect(res.status).toBe(200);
    expect(res.body.transactions).toEqual([]);
  });

  it('T3 tolerates a malformed cursor and returns the first page', async () => {
    const res = await request(app).get('/admin/transactions?cursor=not-base64').set('Authorization', asAdmin());

    expect(res.status).toBe(200);
    expect(res.body.transactions.map((t) => t.id)).toEqual(['adj_d', 'pur_b', 'ps_c', 'pur_a']);
  });

  it('T4 falls back to the default limit and clamps an oversized limit to MAX_PAGE', async () => {
    // 200 extra rows on top of the 4 seeded in beforeEach: 204 total, comfortably
    // past both DEFAULT_PAGE (50) and MAX_PAGE (200), so the two outcomes differ.
    const bulk = Array.from({ length: 200 }, (_, i) => ({
      _id: `bulk_${i}`,
      uid: 'user-1',
      transType: 'Data',
      amount: 5,
      status: 'success',
      transref: `bulk_${i}`,
      CreatedAt: new Date(Date.UTC(2026, 8, 4, 10, 0, i)),
    }));
    await collection('TRANSACTIONS').insertMany(bulk);

    const defaultRes = await request(app).get('/admin/transactions?limit=notanumber').set('Authorization', asAdmin());
    expect(defaultRes.body.transactions.length).toBe(50);

    const clampedRes = await request(app).get('/admin/transactions?limit=9999').set('Authorization', asAdmin());
    expect(clampedRes.body.transactions.length).toBe(200);
  });

  it('T5 normalizes the legacy Epins alias to kind epin', async () => {
    await collection('TRANSACTIONS').insertOne({
      _id: 'legacy_epin', uid: 'user-1', transType: 'Epins', amount: 500, status: 'success', transref: 'legacy_epin', CreatedAt: at(5),
    });

    const res = await request(app).get('/admin/transactions').set('Authorization', asAdmin());
    const row = res.body.transactions.find((t) => t.id === 'legacy_epin');

    expect(row).toBeDefined();
    expect(row.kind).toBe('epin');
  });
});
