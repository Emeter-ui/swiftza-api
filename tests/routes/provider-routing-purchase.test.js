import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');
const { collection } = require('../../src/services/mongo');
const providers = require('../../src/providers');
const app = require('../../src/app');
const users = require('../../src/repositories/users');

const auth = () => `Bearer ${jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET, { subject: 'user-1' })}`;

describe("purchase uses the serving provider's ids", () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    providers.refresh();
    await users.create('user-1', { email: 'u@x.com', account: 'USER', balance: 100000 });
    await collection('NETWORKS').insertOne({
      _id: 'n1', name: 'MTN', id: 1, vtpassDataServiceId: 'mtn-data', active: true,
    });
    await collection('DATAPACKS').insertOne({
      _id: 'd1', Network: 'MTN', Size: '1GB', Amount: '₦280.0', dataId: 7,
      vtpassCode: 'mtn-1gb', active: true,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends husmodata ids when husmodata serves data', async () => {
    await collection('SETTINGS').updateOne(
      { _id: 'providers' }, { $set: { active: 'husmodata', overrides: {} } }, { upsert: true }
    );
    const seen = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      seen.push({ url: String(url), body: init?.body });
      return new Response(JSON.stringify({ Status: 'successful' }), { status: 200 });
    });

    await request(app).post('/buy-data').set('Authorization', auth())
      .send({ uid: 'user-1', planId: 'd1', network: 'MTN', phone: '08030000000' });

    expect(seen[0].body).toContain('"plan":7');
  });

  it('sends VTpass ids when data is overridden to vtpass', async () => {
    await collection('SETTINGS').updateOne(
      { _id: 'providers' },
      { $set: { active: 'husmodata', overrides: { data: 'vtpass' } } },
      { upsert: true }
    );
    const seen = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      seen.push({ url: String(url), body: init?.body });
      return new Response(
        JSON.stringify({ code: '000', content: { transactions: { status: 'delivered' } } }),
        { status: 200 }
      );
    });

    await request(app).post('/buy-data').set('Authorization', auth())
      .send({ uid: 'user-1', planId: 'd1', network: 'MTN', phone: '08030000000' });

    // The husmodata numbers must NOT appear; VTpass's own strings must.
    expect(seen[0].body).toContain('mtn-data');
    expect(seen[0].body).toContain('mtn-1gb');
    expect(seen[0].body).not.toContain('"variation_code":7');
  });

  it('refuses with the missing column when the row is not mapped, and moves no money', async () => {
    await collection('DATAPACKS').updateOne({ _id: 'd1' }, { $unset: { vtpassCode: '' } });
    await collection('SETTINGS').updateOne(
      { _id: 'providers' },
      { $set: { active: 'husmodata', overrides: { data: 'vtpass' } } },
      { upsert: true }
    );
    const res = await request(app).post('/buy-data').set('Authorization', auth())
      .send({ uid: 'user-1', planId: 'd1', network: 'MTN', phone: '08030000000' });

    expect(res.status).toBe(422);
    expect(res.body.msg).toMatch(/vtpassCode/);
    // Nothing may have been charged for a purchase that never dispatched.
    const user = await collection('USERS').findOne({ _id: 'user-1' });
    expect(user.balance).toBe(100000);
    // Unchanged balance alone cannot distinguish "never charged" from "charged
    // and refunded" -- the ledgers must show no trace of this attempt either.
    expect(await collection('TRANSACTIONS').countDocuments({ uid: 'user-1' })).toBe(0);
    expect(await collection('WALLETTRANSACTIONS').countDocuments({ uid: 'user-1' })).toBe(0);
  });

  // The data-plan test above proves the negative for /buy-data; cable is the
  // only other new-contract route whose catalog row carries both a husmodata
  // AND a VTpass column for both the service id and the plan id (CableID /
  // vtpassServiceId, CableplanID / vtpassCode), so it gets the same negative
  // assertion rather than resting on data alone.
  it('sends VTpass ids when cable is overridden to vtpass, not husmodata numbers', async () => {
    await collection('CABLES').insertOne({
      _id: 'c1', CableName: 'DStv', CableID: 2, vtpassServiceId: 'dstv', active: true,
    });
    await collection('CABLESPLAN').insertOne({
      _id: 'cp1', CableplanID: 5, CableplanName: 'DStv Compact', amount: 9000,
      vtpassCode: 'dstv-compact', active: true,
    });
    await collection('SETTINGS').updateOne(
      { _id: 'providers' },
      { $set: { active: 'husmodata', overrides: { cable: 'vtpass' } } },
      { upsert: true }
    );
    const seen = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      seen.push({ url: String(url), body: init?.body });
      return new Response(
        JSON.stringify({ code: '000', content: { transactions: { status: 'delivered' } } }),
        { status: 200 }
      );
    });

    await request(app).post('/buy-cable').set('Authorization', auth())
      .send({ uid: 'user-1', provider: 'DStv', planId: 'cp1', smartcard: '1234567890' });

    // VTpass's own strings must be on the wire...
    expect(seen[0].body).toContain('dstv-compact');
    expect(seen[0].body).toContain('"serviceID":"dstv"');
    // ...and husmodata's numeric CableID/CableplanID must NOT be.
    expect(seen[0].body).not.toContain('"serviceID":2');
    expect(seen[0].body).not.toContain('"variation_code":5');
  });
});
