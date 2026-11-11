import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const catalogRepo = require('../../src/repositories/catalog');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

// vi.mock('../../src/providers', ...) does not work here: every file under
// src/ is CommonJS reached through app.js's require() chain, and Vitest's
// mock registry only intercepts static ESM `import` statements. Even if it
// did fire, src/models/purchase.js destructures `getProvider` at load time,
// so replacing the export afterwards would have no effect.
//
// Instead we stub at the fetch boundary (src/models/http.js calls global
// fetch), which intercepts every provider call regardless of module system
// and exercises the husmodata adapter's own interpret() logic instead of
// bypassing it. No SETTINGS document is seeded, so the provider resolver
// falls back to ACTIVE_PROVIDER from env (husmodata, per tests/setup.js).
const fetchOk = (body, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    status,
    text: async () => JSON.stringify(body),
  });

const token = () => jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET, { subject: 'user-1' });
const balance = async () => (await collection('USERS').findOne({ _id: 'user-1' })).balance;

const body = { transref: 'buy-ref-1', mobile: '08000000000', network_id: 1, dataId: 7, channel: 'Data' };

describe('POST /data', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  afterEach(() => {
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('user-1', { email: 'u@x.com', account: 'USER', balance: 1000 });
    // network_id: 1 in `body` below is husmodata's own numeric id; buydata.js
    // now resolves it against NETWORKS so it can be translated for whichever
    // provider actually serves the purchase.
    await catalogRepo.insertMany('NETWORKS', [{ name: 'MTN', id: 1, active: true }]);
    await catalogRepo.insertMany('DATAPACKS', [
      { dataId: 7, Network: 'MTN', Size: '1.0 GB', Amount: '₦280.0', active: true },
    ]);
  });

  it('settles the debit on a successful purchase', async () => {
    fetchOk({ Status: 'successful', ident: 'p-1' });

    const res = await request(app).post('/data').set('Authorization', `Bearer ${token()}`).send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    // Price comes from the catalog, never the request body.
    expect(await balance()).toBe(720);
    expect((await collection('WALLETTRANSACTIONS').findOne({ _id: 'buy-ref-1' })).status).toBe('success');
  });

  it('refunds when the provider declines', async () => {
    fetchOk({ error: 'Plan unavailable' });

    const res = await request(app).post('/data').set('Authorization', `Bearer ${token()}`).send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('error');
    expect(await balance()).toBe(1000);
    expect((await collection('WALLETTRANSACTIONS').findOne({ _id: 'buy-ref-1' })).status).toBe('reversed');
  });

  it('holds the funds when the provider outcome is unknown', async () => {
    fetchOk({ oops: 'unexpected shape' }, 500);

    const res = await request(app).post('/data').set('Authorization', `Bearer ${token()}`).send(body);

    expect(res.status).toBe(202);
    // Must NOT refund — the provider may have fulfilled the order.
    expect(await balance()).toBe(720);
    expect((await collection('WALLETTRANSACTIONS').findOne({ _id: 'buy-ref-1' })).status).toBe('requery');
  });

  it('rejects a replayed transref', async () => {
    fetchOk({ Status: 'successful', ident: 'p-1' });

    await request(app).post('/data').set('Authorization', `Bearer ${token()}`).send(body);
    const second = await request(app).post('/data').set('Authorization', `Bearer ${token()}`).send(body);

    expect(second.status).toBe(409);
    expect(await balance()).toBe(720);
  });

  it('rejects a purchase that exceeds the balance', async () => {
    await collection('USERS').updateOne({ _id: 'user-1' }, { $set: { balance: 10 } });
    const fetchSpy = fetchOk({ Status: 'successful', ident: 'p-1' });

    const res = await request(app).post('/data').set('Authorization', `Bearer ${token()}`).send(body);

    expect(res.status).toBe(402);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an invalid phone number before touching the balance', async () => {
    const res = await request(app)
      .post('/data')
      .set('Authorization', `Bearer ${token()}`)
      .send({ ...body, mobile: '123' });

    expect(res.status).toBe(422);
    expect(await balance()).toBe(1000);
  });
});
