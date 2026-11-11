import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
const request = require('supertest');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');
const { collection } = require('../../src/services/mongo');
const app = require('../../src/app');
const jwt = require('jsonwebtoken');

const categories = require('../fixtures/vtpass/service-categories.json');
const services = require('../fixtures/vtpass/services-airtime.json');
const variations = require('../fixtures/vtpass/service-variations-mtn-data.json');

const asAdmin = () => `Bearer ${jwt.sign({ uid: 'admin-1', account: 'ADMIN' }, process.env.JWT_SECRET || 'test-secret')}`;
const asUser  = () => `Bearer ${jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET || 'test-secret')}`;

const respond = (body, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status })
  );

// Every catalog collection the annotate-only rule protects.
const CATALOG = ['NETWORKS', 'DATAPACKS', 'CABLES', 'CABLESPLAN', 'ELECTRICITY', 'EPIN', 'ATC'];

async function snapshotCatalog() {
  const out = {};
  for (const name of CATALOG) {
    out[name] = await collection(name).find({}).sort({ _id: 1 }).toArray();
  }
  return JSON.parse(JSON.stringify(out));
}

// Hoisted to file level (rather than one set per describe, as originally
// drafted): starting a MongoMemoryReplSet is by far the slowest thing in any
// test file here, and every other route test in this repo starts exactly one.
beforeAll(startTestMongo);
afterAll(stopTestMongo);

describe('/admin/providers/vtpass/catalog', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await clearTestMongo();
    await collection('USERS').insertMany([
      { _id: 'admin-1', account: 'ADMIN', setUpProcess: true, balance: 0 },
      { _id: 'user-1', account: 'USER', balance: 0 },
    ]);
    await collection('NETWORKS').insertOne({
      name: 'MTN', id: 1, vtpassAirtimeServiceId: 'mtn',
      vtpassDataServiceId: 'mtn-data', active: true, CreatedAt: new Date(),
    });
  });

  it('refuses a non-admin', async () => {
    expect((await request(app).get('/admin/providers/vtpass/catalog').set('Authorization', asUser())).status).toBe(403);
    expect((await request(app).get('/admin/providers/vtpass/audit').set('Authorization', asUser())).status).toBe(403);
  });

  it('returns categories when asked for nothing in particular', async () => {
    respond(categories);
    const res = await request(app).get('/admin/providers/vtpass/catalog').set('Authorization', asAdmin());

    expect(res.status).toBe(200);
    expect(res.body.level).toBe('categories');
    expect(res.body.items).toHaveLength(categories.content.length);
    expect(res.body.items[0].identifier).toBe(categories.content[0].identifier);
  });

  it('returns services for an identifier', async () => {
    respond(services);
    const res = await request(app)
      .get('/admin/providers/vtpass/catalog?identifier=airtime')
      .set('Authorization', asAdmin());

    expect(res.status).toBe(200);
    expect(res.body.level).toBe('services');
    expect(res.body.identifier).toBe('airtime');
    expect(res.body.items[0].serviceID).toBe(services.content[0].serviceID);
  });

  it('returns variations for a serviceID, with the amount off the wire', async () => {
    respond(variations);
    const res = await request(app)
      .get('/admin/providers/vtpass/catalog?serviceID=mtn-data')
      .set('Authorization', asAdmin());

    expect(res.status).toBe(200);
    expect(res.body.level).toBe('variations');
    const wire = variations.content.varations ?? variations.content.variations;
    expect(res.body.items[0].amount).toBe(Number(wire[0].variation_amount));
  });

  // The annotate-only rule, stated as a test. An upstream response must not be
  // able to add something sellable, remove something a customer is mid-purchase
  // on, or touch the field that decides what a customer is charged.
  //
  // The spec speaks of an `updatedAt`; this codebase has no such field, so the
  // full documents are compared instead -- a strictly stronger assertion.
  it('writes nothing to any catalog collection', async () => {
    const before = await snapshotCatalog();

    respond(categories);
    await request(app).get('/admin/providers/vtpass/catalog').set('Authorization', asAdmin());
    vi.restoreAllMocks();
    respond(services);
    await request(app).get('/admin/providers/vtpass/catalog?identifier=airtime').set('Authorization', asAdmin());
    vi.restoreAllMocks();
    respond(variations);
    await request(app).get('/admin/providers/vtpass/catalog?serviceID=mtn-data').set('Authorization', asAdmin());

    expect(await snapshotCatalog()).toEqual(before);
  });

  it('surfaces the provider message and leaves state intact on a failure', async () => {
    const before = await snapshotCatalog();
    respond({ response_description: 'INVALID IDENTIFIER' }, 400);

    const res = await request(app)
      .get('/admin/providers/vtpass/catalog?identifier=nonsense')
      .set('Authorization', asAdmin());

    // 503 via the existing providerUnavailable helper, not a bespoke 502.
    expect(res.status).toBe(503);
    expect(res.body.msg || res.body.message).toContain('INVALID IDENTIFIER');
    expect(await snapshotCatalog()).toEqual(before);
  });

  it('rejects an identifier that is not a plain slug before calling out', async () => {
    const spy = respond(services);
    const res = await request(app)
      .get('/admin/providers/vtpass/catalog?identifier=' + encodeURIComponent('../../etc'))
      .set('Authorization', asAdmin());

    expect(res.status).toBe(422);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('/admin/providers/vtpass/audit', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await clearTestMongo();
    await collection('USERS').insertOne({ _id: 'admin-1', account: 'ADMIN', setUpProcess: true, balance: 0 });
  });

  it('reports a catalog id VTpass no longer lists, and never disables it', async () => {
    await collection('NETWORKS').insertOne({
      name: 'Ghost', id: 9, vtpassAirtimeServiceId: 'ghost-network',
      active: true, CreatedAt: new Date(),
    });
    // Every services call in the audit returns the same airtime payload; a
    // serviceID of 'ghost-network' is not in it.
    respond(services);

    const res = await request(app).get('/admin/providers/vtpass/audit').set('Authorization', asAdmin());

    expect(res.status).toBe(200);
    expect(res.body.missing.some((m) => m.id === 'ghost-network')).toBe(true);

    // Disabling a live service from an upstream response is the exact failure
    // the annotate-only rule exists to prevent.
    const row = await collection('NETWORKS').findOne({ vtpassAirtimeServiceId: 'ghost-network' });
    expect(row.active).toBe(true);
  });

  it('does not report an id VTpass does list', async () => {
    const known = services.content[0].serviceID;
    await collection('NETWORKS').insertOne({
      name: 'Known', id: 8, vtpassAirtimeServiceId: known, active: true, CreatedAt: new Date(),
    });
    respond(services);

    const res = await request(app).get('/admin/providers/vtpass/audit').set('Authorization', asAdmin());
    expect(res.body.missing.some((m) => m.id === known)).toBe(false);
  });

  // A provider that cannot be reached must not be reported as a provider that
  // lists nothing -- that would flag the entire catalog as missing.
  it('reports an unreachable identifier as unchecked, not as missing', async () => {
    await collection('NETWORKS').insertOne({
      name: 'MTN', id: 1, vtpassAirtimeServiceId: 'mtn', active: true, CreatedAt: new Date(),
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));

    const res = await request(app).get('/admin/providers/vtpass/audit').set('Authorization', asAdmin());

    expect(res.status).toBe(200);
    expect(res.body.missing).toHaveLength(0);
    expect(res.body.unchecked.length).toBeGreaterThan(0);
  });
});
