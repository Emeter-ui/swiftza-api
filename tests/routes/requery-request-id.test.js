import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const catalogRepo = require('../../src/repositories/catalog');
const settings = require('../../src/repositories/settings');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

// VTpass matches a requery on the `request_id` we sent at purchase time and on
// nothing else. That id embeds the current minute (buildRequestId), so it
// cannot be recomputed afterwards -- if it is not persisted when the purchase
// is held, the money is unrecoverable except by hand.
//
// These tests take their expected value off the WIRE -- whatever the adapter
// actually put in the outgoing request body -- rather than from a hand-written
// fixture. A fixture written from the same understanding as the code cannot
// detect that understanding being wrong, which is exactly how two earlier
// tests in this repo certified bugs.

const token = () => jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET, { subject: 'user-1' });
const adminToken = () => jwt.sign({ uid: 'admin-1', account: 'ADMIN' }, process.env.JWT_SECRET, { subject: 'admin-1' });

const buy = { transref: 'buy-ref-1', mobile: '08000000000', network_id: 1, dataId: 7, channel: 'Data' };

// Records every outgoing call so a test can read back what was actually sent.
function captureFetch(responder) {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    return responder(calls.length, body);
  });
  return calls;
}

const sentRequestId = (calls) => calls[0].body.request_id;

describe('provider request id survives to the requery console', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('user-1', { email: 'u@x.com', account: 'USER', balance: 1000 });
    await users.create('admin-1', { email: 'a@x.com', account: 'ADMIN', balance: 0 });
    await settings.set('providers', { active: 'vtpass' });
    await catalogRepo.insertMany('NETWORKS', [
      { name: 'MTN', id: 1, vtpassDataServiceId: 'mtn-data', active: true },
    ]);
    await catalogRepo.insertMany('DATAPACKS', [
      { dataId: 7, Network: 'MTN', Size: '1.0 GB', Amount: '₦280.0', vtpassCode: 'mtn-1gb', active: true },
    ]);
  });

  // The case that matters most: a timeout produces NO response body at all, so
  // an implementation that reads the id back off the provider's reply records
  // nothing here -- and a timeout is precisely when the debit is held.
  it('persists the id it sent even when the provider never responds', async () => {
    const calls = captureFetch(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });

    const res = await request(app).post('/data').set('Authorization', `Bearer ${token()}`).send(buy);
    expect(res.body.status).toBe('pending');

    const row = await collection('WALLETTRANSACTIONS').findOne({ _id: 'buy-ref-1' });
    expect(row.status).toBe('requery');
    // Not a literal: the value the adapter actually put on the wire.
    expect(row.providerRequestId).toBe(sentRequestId(calls));
    expect(row.providerRequestId).toMatch(/^\d{12}/);
  });

  it('persists the id it sent when the provider answers pending', async () => {
    const calls = captureFetch(async () => ({
      status: 200,
      text: async () => JSON.stringify({ code: '099', response_description: 'TRANSACTION PROCESSING' }),
    }));

    await request(app).post('/data').set('Authorization', `Bearer ${token()}`).send(buy);

    const row = await collection('WALLETTRANSACTIONS').findOne({ _id: 'buy-ref-1' });
    expect(row.status).toBe('requery');
    expect(row.providerRequestId).toBe(sentRequestId(calls));
  });

  // The whole point of persisting it: /ask must ask with the provider's id,
  // not with our own transref, which the provider has never seen.
  it('asks the provider using the stored id, not our transref', async () => {
    const calls = captureFetch(async (n) => {
      if (n === 1) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { status: 200, text: async () => JSON.stringify({ code: '000', content: { transactions: { status: 'delivered' } } }) };
    });

    await request(app).post('/data').set('Authorization', `Bearer ${token()}`).send(buy);
    const sent = sentRequestId(calls);

    const ask = await request(app)
      .post('/admin/requery/buy-ref-1/ask')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(ask.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].body.request_id).toBe(sent);
    expect(calls[1].body.request_id).not.toBe('buy-ref-1');
  });

  // A row with no stored id must say so rather than making a call that always
  // comes back "could not confirm" -- indistinguishable from the provider
  // genuinely not knowing, which is the more dangerous answer to guess at.
  it('does not call the provider for a row with no stored id', async () => {
    await collection('WALLETTRANSACTIONS').insertOne({
      _id: 'old-ref', transref: 'old-ref', uid: 'user-1', amount: 500,
      status: 'requery', requeryReason: 'stale-pending', channel: 'Data',
      providerReference: 'vt-internal-9', flaggedAt: new Date(), CreatedAt: new Date(),
    });
    const calls = captureFetch(async () => ({ status: 200, text: async () => '{}' }));

    const ask = await request(app)
      .post('/admin/requery/old-ref/ask')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(ask.status).toBe(200);
    expect(ask.body.status).toBe('pending');
    expect(ask.body.message).toMatch(/vt-internal-9/);
    expect(calls).toHaveLength(0);
  });

  it('tells the console which rows can be asked', async () => {
    captureFetch(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
    await request(app).post('/data').set('Authorization', `Bearer ${token()}`).send(buy);
    await collection('WALLETTRANSACTIONS').insertOne({
      _id: 'old-ref', transref: 'old-ref', uid: 'user-1', amount: 500,
      status: 'requery', channel: 'Data', flaggedAt: new Date(), CreatedAt: new Date(),
    });

    const list = await request(app).get('/admin/requery').set('Authorization', `Bearer ${adminToken()}`);
    const byRef = Object.fromEntries(list.body.items.map((i) => [i.reference, i.canAsk]));
    expect(byRef['buy-ref-1']).toBe(true);
    expect(byRef['old-ref']).toBe(false);
  });
});
