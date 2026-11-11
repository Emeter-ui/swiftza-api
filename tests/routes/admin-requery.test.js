import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
const request = require('supertest');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');
const { collection } = require('../../src/services/mongo');
const app = require('../../src/app');
const { finance } = require('../../src/models/finance');
const jwt = require('jsonwebtoken');

// Follow the local-helper convention every other admin-route test in this repo
// uses; there is no tests/helpers/auth.js.
const asAdmin = () => `Bearer ${jwt.sign({ uid: 'admin-1', account: 'ADMIN' }, process.env.JWT_SECRET || 'test-secret')}`;
const asUser  = () => `Bearer ${jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET || 'test-secret')}`;

describe('/admin/requery', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await collection('USERS').insertMany([
      { _id: 'admin-1', account: 'ADMIN', setUpProcess: true, balance: 0 },
      { _id: 'user-1', account: 'USER', balance: 1000, username: 'ada' },
    ]);
    // Real WALLETTRANSACTIONS rows carry `channel` (written by
    // finance.reserveFunds from purchases.js: 'Data', 'Airtime', 'Cable',
    // 'Electricity', 'Epin'), never `transType` -- that field lives on the
    // separate TRANSACTIONS collection. This fixture mirrors what production
    // actually writes, per admin-transactions.test.js / ledgers-api.test.js.
    await collection('WALLETTRANSACTIONS').insertOne({
      _id: 'pur_h', transref: 'pur_h', uid: 'user-1', amount: 500, status: 'requery',
      requeryReason: 'timeout', providerResponse: '{"raw":"x"}', flaggedAt: new Date(),
      channel: 'Data', CreatedAt: new Date(),
      // Written by holdForRequery from what the adapter actually sent. /ask
      // matches on this, never on transref -- the provider has never seen our
      // reference. A row without it is not askable at all.
      providerRequestId: '202609081453purh',
    });
  });

  it('refuses a non-admin', async () => {
    expect((await request(app).get('/admin/requery').set('Authorization', asUser())).status).toBe(403);
    expect((await request(app).put('/admin/requery/pur_h').set('Authorization', asUser())
      .send({ decision: 'settle', reason: 'x' })).status).toBe(403);
  });

  it('lists held rows with what the operator needs to decide', async () => {
    const res = await request(app).get('/admin/requery').set('Authorization', asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      reference: 'pur_h', amount: 500, reason: 'timeout', username: 'ada',
    });
    expect(res.body.items[0].providerResponse).toContain('raw');
    // R13: holdForRequery writes flaggedAt (finance.js) but the listing used
    // to never emit it -- an operator triaging held money could not tell a
    // row held ten minutes ago from one held last week.
    expect(res.body.items[0].flaggedAt).not.toBeNull();
    expect(new Date(res.body.items[0].flaggedAt).toString()).not.toBe('Invalid Date');
  });

  it('does not list rows that are not held', async () => {
    await collection('WALLETTRANSACTIONS').insertOne({
      _id: 'pur_ok', uid: 'user-1', amount: 100, status: 'success', CreatedAt: new Date(),
    });
    const res = await request(app).get('/admin/requery').set('Authorization', asAdmin());
    expect(res.body.items.map((i) => i.reference)).toEqual(['pur_h']);
  });

  it('ask returns the provider answer and WRITES NOTHING', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ Status: 'successful' }), { status: 200 })
    );
    const res = await request(app).post('/admin/requery/pur_h/ask').set('Authorization', asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');

    const row = await collection('WALLETTRANSACTIONS').findOne({ _id: 'pur_h' });
    expect(row.status).toBe('requery');
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1000);
    expect(await collection('AUDITLOG').countDocuments()).toBe(0);
    vi.restoreAllMocks();
  });

  // Anchor test: builds the held row through the real production path
  // (finance.reserveFunds -> finance.holdForRequery) instead of hand-writing
  // a document, so the fixture's shape can never again diverge from what the
  // code that creates a held row actually produces. Also proves the provider
  // is called with the row's own reference.
  it('ask calls the provider with the stored provider id, for a row built through the real reserve/hold path', async () => {
    await collection('USERS').updateOne({ _id: 'user-1' }, { $set: { balance: 2000 } });
    await finance.reserveFunds({
      uid: 'user-1', amount: 300, transref: 'pur_real', channel: 'Airtime', createdAt: new Date(),
    });
    await finance.holdForRequery({
      transref: 'pur_real', reason: 'timeout', raw: { note: 'x' },
      providerRequestId: '202609081453purreal',
    });

    let capturedBody = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ Status: 'successful' }), { status: 200 });
    });

    const res = await request(app).post('/admin/requery/pur_real/ask').set('Authorization', asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    // The provider is asked with the id IT issued, never with our transref --
    // a string it has never seen, which is what this route used to send and
    // why every answer came back "could not confirm".
    expect(capturedBody.request_id).toBe('202609081453purreal');
    expect(capturedBody.request_id).not.toBe('pur_real');

    const row = await collection('WALLETTRANSACTIONS').findOne({ _id: 'pur_real' });
    expect(row.status).toBe('requery');
    vi.restoreAllMocks();
  });

  // The only branch that ran against real data before this fix: a row whose
  // channel maps to no known provider service (e.g. a wallet credit, never
  // actually held at 'requery' in production, but the route must not guess).
  it('ask returns pending without calling a provider when the channel maps to no service', async () => {
    await collection('WALLETTRANSACTIONS').updateOne({ _id: 'pur_h' }, { $set: { channel: 'Wallet' } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await request(app).post('/admin/requery/pur_h/ask').set('Authorization', asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  // provider.requery() reports `pending` for every non-OK transport outcome
  // (4xx, 5xx, timeout, network error) on purpose -- a rejected status
  // question is not a failed purchase. The route must pass that through
  // as-is, never translate it into something more definite.
  it('ask passes a provider 4xx through as pending, untranslated', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
    const res = await request(app).post('/admin/requery/pur_h/ask').set('Authorization', asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    vi.restoreAllMocks();
  });

  it('applies a settle decision: the debit stands and the balance does not move', async () => {
    const res = await request(app).put('/admin/requery/pur_h').set('Authorization', asAdmin())
      .send({ decision: 'settle', reason: 'confirmed delivered by provider' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');

    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1000);
    const row = await collection('WALLETTRANSACTIONS').findOne({ _id: 'pur_h' });
    expect(row.status).toBe('success');
    expect(await collection('AUDITLOG').countDocuments({ action: 'requery.resolve' })).toBe(1);
  });

  it('applies a reverse decision and refunds', async () => {
    const res = await request(app).put('/admin/requery/pur_h').set('Authorization', asAdmin())
      .send({ decision: 'reverse', reason: 'never delivered' });
    expect(res.status).toBe(200);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1500);
    expect(await collection('AUDITLOG').countDocuments({ action: 'requery.resolve' })).toBe(1);
  });

  it('422s a decision on a row that is not held, and writes nothing', async () => {
    await collection('WALLETTRANSACTIONS').updateOne({ _id: 'pur_h' }, { $set: { status: 'success' } });
    const res = await request(app).put('/admin/requery/pur_h').set('Authorization', asAdmin())
      .send({ decision: 'reverse', reason: 'x' });
    expect(res.status).toBe(422);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1000);
  });

  it('422s a missing reason', async () => {
    const res = await request(app).put('/admin/requery/pur_h').set('Authorization', asAdmin())
      .send({ decision: 'settle' });
    expect(res.status).toBe(422);
  });
});
