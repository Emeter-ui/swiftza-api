import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');
const { collection } = require('../../src/services/mongo');
const users = require('../../src/repositories/users');
const providers = require('../../src/providers');
const { validateIdFor, serviceIdFor } = require('../../src/providers/ids');
const app = require('../../src/app');

const token = (uid, account) => jwt.sign({ uid, account }, process.env.JWT_SECRET, { subject: uid });
const asAdmin = () => `Bearer ${token('admin-1', 'ADMIN')}`;
const asUser = () => `Bearer ${token('user-1', 'USER')}`;

describe('GET/PUT /admin/providers', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    providers.refresh();
    await users.create('admin-1', { email: 'a@x.com', account: 'ADMIN' });
    await users.create('user-1', { email: 'u@x.com', account: 'USER' });
    await collection('SETTINGS').updateOne(
      { _id: 'providers' }, { $set: { active: 'husmodata', overrides: {} } }, { upsert: true }
    );
  });

  it('refuses a non-admin', async () => {
    const res = await request(app).get('/admin/providers').set('Authorization', asUser());
    expect(res.status).toBe(403);
  });

  it('reports routing, adapters and coverage', async () => {
    await collection('DATAPACKS').insertMany([
      { _id: 'a', dataId: 1, vtpassCode: 'x', active: true },
      { _id: 'b', dataId: 2, active: true },
    ]);
    const res = await request(app).get('/admin/providers').set('Authorization', asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.active).toBe('husmodata');
    expect(res.body.available).toEqual(expect.arrayContaining(['husmodata', 'vtpass']));
    expect(res.body.coverage.vtpass.data.missing).toBe(1);
  });

  it('treats an absent column, an explicit null and an empty string as equally missing', async () => {
    await collection('DATAPACKS').insertMany([
      { _id: 'a', dataId: 1, active: true }, // vtpassCode absent entirely
      { _id: 'b', dataId: 2, vtpassCode: null, active: true },
      { _id: 'c', dataId: 3, vtpassCode: '', active: true },
      { _id: 'd', dataId: 4, vtpassCode: 'x', active: true },
      // Inactive rows must not count against coverage.
      { _id: 'e', dataId: 5, active: false },
    ]);
    const res = await request(app).get('/admin/providers').set('Authorization', asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.coverage.vtpass.data.missing).toBe(3);
  });

  it('refuses a switch when rows are unmapped, and writes nothing', async () => {
    await collection('DATAPACKS').insertOne({ _id: 'b', dataId: 2, active: true });
    const res = await request(app).put('/admin/providers').set('Authorization', asAdmin())
      .send({ service: 'data', provider: 'vtpass' });

    expect(res.status).toBe(422);
    expect(res.body.msg).toMatch(/1 .*data/i);
    const doc = await collection('SETTINGS').findOne({ _id: 'providers' });
    expect(doc.overrides.data).toBeUndefined();
  });

  it('refuses a switch to a provider with no credentials configured, and writes nothing', async () => {
    await collection('DATAPACKS').insertOne({ _id: 'a', dataId: 1, vtpassCode: 'x', active: true });

    // Gate 1.5 must fire before Gate 2's coverage check, so unset the one
    // secret this switch would otherwise pass every other gate for.
    const savedApiKey = process.env.PROVIDER_VTPASS_API_KEY;
    delete process.env.PROVIDER_VTPASS_API_KEY;
    try {
      const res = await request(app).put('/admin/providers').set('Authorization', asAdmin())
        .send({ service: 'data', provider: 'vtpass' });

      expect(res.status).toBe(422);
      expect(res.body.msg).toMatch(/PROVIDER_VTPASS_API_KEY/);
      const doc = await collection('SETTINGS').findOne({ _id: 'providers' });
      expect(doc?.overrides?.data).toBeUndefined();
      expect(await providers.getProviderName('data')).toBe('husmodata');
    } finally {
      process.env.PROVIDER_VTPASS_API_KEY = savedApiKey;
    }
  });

  it('refuses an unknown provider and an unknown service', async () => {
    const a = await request(app).put('/admin/providers').set('Authorization', asAdmin())
      .send({ service: 'data', provider: 'nope' });
    expect(a.status).toBe(422);
    const b = await request(app).put('/admin/providers').set('Authorization', asAdmin())
      .send({ service: 'nope', provider: 'vtpass' });
    expect(b.status).toBe(422);
  });

  it('requires a passing pre-flight for cable, and refuses on failure', async () => {
    await collection('CABLES').insertOne({ _id: 'c1', CableName: 'DStv', CableID: 2, vtpassServiceId: 'dstv', active: true });
    await collection('CABLESPLAN').insertOne({ _id: 'p1', CableplanID: 9, vtpassCode: 'dstv-padi', active: true });
    await collection('SETTINGS').updateOne(
      { _id: 'providers' },
      { $set: { preflight: { cable: { smartCard: '1212121212', cableId: 2 } } } }
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));

    const res = await request(app).put('/admin/providers').set('Authorization', asAdmin())
      .send({ service: 'cable', provider: 'vtpass' });

    expect(res.status).toBe(422);
    expect(res.body.msg).toMatch(/pre-flight/i);
    const doc = await collection('SETTINGS').findOne({ _id: 'providers' });
    expect(doc.overrides?.cable).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('refuses a cable switch with no saved pre-flight sample', async () => {
    await collection('CABLES').insertOne({ _id: 'c1', CableName: 'DStv', CableID: 2, vtpassServiceId: 'dstv', active: true });
    await collection('CABLESPLAN').insertOne({ _id: 'p1', CableplanID: 9, vtpassCode: 'dstv-padi', active: true });

    const res = await request(app).put('/admin/providers').set('Authorization', asAdmin())
      .send({ service: 'cable', provider: 'vtpass' });

    expect(res.status).toBe(422);
    expect(res.body.msg).toMatch(/pre-flight/i);
  });

  it('passes the cable pre-flight when the provider validates the sample, resolving through the catalog', async () => {
    await collection('CABLES').insertOne({ _id: 'c1', CableName: 'DStv', CableID: 2, vtpassServiceId: 'dstv', active: true });
    await collection('CABLESPLAN').insertOne({ _id: 'p1', CableplanID: 9, vtpassCode: 'dstv-padi', active: true });
    await collection('SETTINGS').updateOne(
      { _id: 'providers' },
      { $set: { preflight: { cable: { smartCard: '1212121212', cableId: 2 } } } }
    );

    let capturedBody = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ code: '000', content: { Customer_Name: 'Jane' } }), { status: 200 });
    });

    const res = await request(app).put('/admin/providers').set('Authorization', asAdmin())
      .send({ service: 'cable', provider: 'vtpass' });

    expect(res.status).toBe(200);
    // The resolved id sent upstream is vtpass's own serviceID for this cable
    // row (vtpassServiceId), not the internal CableID the sample was keyed by.
    expect(capturedBody.serviceID).toBe('dstv');
    expect(capturedBody.billersCode).toBe('1212121212');
    vi.restoreAllMocks();
  });

  it('resolves the cable pre-flight through husmodata using CableName, not the buy id CableID', async () => {
    // husmodata's validate_iuc and buy endpoints take different columns
    // (CableName vs CableID) — unlike vtpass, where both coincide. Only a
    // husmodata-targeted test can prove resolveSample picked the validate
    // column and not the buy column.
    const cableDoc = { CableID: 4, CableName: 'DSTV', vtpassServiceId: 'dstv' };
    await collection('CABLES').insertOne({ _id: 'c-hus', active: true, ...cableDoc });
    await collection('CABLESPLAN').insertOne({ _id: 'p-hus', CableplanID: 11, active: true });
    await collection('SETTINGS').updateOne(
      { _id: 'providers' },
      { $set: { preflight: { cable: { smartCard: '1212121212', cableId: 4 } } } }
    );

    let capturedUrl = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      capturedUrl = url;
      return new Response('{}', { status: 200 });
    });

    const res = await request(app).put('/admin/providers').set('Authorization', asAdmin())
      .send({ service: 'cable', provider: 'husmodata' });

    expect(res.status).toBe(200);
    const sent = new URL(capturedUrl).searchParams.get('cablename');
    const expectedValidateId = String(validateIdFor('husmodata', 'cable', cableDoc));
    const buyId = String(serviceIdFor('husmodata', 'cable', cableDoc));
    expect(expectedValidateId).not.toBe(buyId); // sanity: the fixture actually discriminates
    expect(sent).toBe(expectedValidateId);
    expect(sent).not.toBe(buyId);
    vi.restoreAllMocks();
  });

  it('resolves the electricity pre-flight through husmodata using Disconame, not the buy id DiscoID', async () => {
    const discoDoc = { DiscoID: 7, Disconame: 'IKEDC', vtpassServiceId: 'ikedc' };
    await collection('ELECTRICITY').insertOne({ _id: 'e-hus', active: true, ...discoDoc });
    await collection('SETTINGS').updateOne(
      { _id: 'providers' },
      { $set: { preflight: { electricity: { meterNumber: '1234567890', discoId: 7, meterType: 'prepaid' } } } }
    );

    let capturedUrl = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      capturedUrl = url;
      return new Response('{}', { status: 200 });
    });

    const res = await request(app).put('/admin/providers').set('Authorization', asAdmin())
      .send({ service: 'electricity', provider: 'husmodata' });

    expect(res.status).toBe(200);
    const sent = new URL(capturedUrl).searchParams.get('disconame');
    const expectedValidateId = String(validateIdFor('husmodata', 'electricity', discoDoc));
    const buyId = String(serviceIdFor('husmodata', 'electricity', discoDoc));
    expect(expectedValidateId).not.toBe(buyId); // sanity: the fixture actually discriminates
    expect(sent).toBe(expectedValidateId);
    expect(sent).not.toBe(buyId);
    vi.restoreAllMocks();
  });

  it('switches, busts the cache and audits when every gate passes', async () => {
    await collection('DATAPACKS').insertOne({ _id: 'a', dataId: 1, vtpassCode: 'x', active: true });
    const res = await request(app).put('/admin/providers').set('Authorization', asAdmin())
      .send({ service: 'data', provider: 'vtpass' });

    expect(res.status).toBe(200);
    expect(res.body.services.data.provider).toBe('vtpass');
    expect(await providers.getProviderName('data')).toBe('vtpass');

    const entry = await collection('AUDITLOG').findOne({ action: 'provider.route' });
    expect(entry).toMatchObject({ service: 'data', from: 'husmodata', to: 'vtpass' });
    expect(entry.adminUid).toBeTruthy();
  });

  it('returns the same enriched shape as GET after a successful switch, not just active/services', async () => {
    // samzeenuxt/app/pages/admin/index.vue assigns the PUT response straight
    // over the ref GET originally populated -- so a PUT response missing
    // `available` blanks every service dropdown after the first switch.
    await collection('DATAPACKS').insertOne({ _id: 'a', dataId: 1, vtpassCode: 'x', active: true });
    const res = await request(app).put('/admin/providers').set('Authorization', asAdmin())
      .send({ service: 'data', provider: 'vtpass' });

    expect(res.status).toBe(200);
    expect(res.body.available).toEqual(expect.arrayContaining(['husmodata', 'vtpass']));
    expect(res.body.supports).toBeTruthy();
    expect(res.body.supports.vtpass).toContain('data');
    expect(res.body.coverage).toBeTruthy();
    expect(res.body.coverage.vtpass.data.missing).toBe(0);
  });

  it('round-trips a pre-flight sample through PUT /admin/providers/preflight', async () => {
    const res = await request(app).put('/admin/providers/preflight').set('Authorization', asAdmin())
      .send({ service: 'cable', sample: { smartCard: '1212121212', cableId: 2 } });
    expect(res.status).toBe(200);
    expect(res.body.preflight.cable).toEqual({ smartCard: '1212121212', cableId: 2 });

    const doc = await collection('SETTINGS').findOne({ _id: 'providers' });
    expect(doc.preflight.cable).toEqual({ smartCard: '1212121212', cableId: 2 });
  });

  it('refuses a pre-flight sample for a service other than cable or electricity', async () => {
    const res = await request(app).put('/admin/providers/preflight').set('Authorization', asAdmin())
      .send({ service: 'data', sample: { foo: 'bar' } });
    expect(res.status).toBe(422);
  });
});
