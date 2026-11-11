import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
const request = require('supertest');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');
const { collection } = require('../../src/services/mongo');
const app = require('../../src/app');
const jwt = require('jsonwebtoken');
const variations = require('../fixtures/vtpass/service-variations-mtn-data.json');
const services = require('../fixtures/vtpass/services-airtime.json');

const asAdmin = () => `Bearer ${jwt.sign({ uid: 'admin-1', account: 'ADMIN' }, process.env.JWT_SECRET || 'test-secret')}`;
const asUser  = () => `Bearer ${jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET || 'test-secret')}`;

const respond = (body, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));

const CATALOG = ['NETWORKS', 'DATAPACKS', 'CABLES', 'CABLESPLAN', 'ELECTRICITY', 'EPIN', 'ATC'];
async function snapshotCatalog() {
  const out = {};
  for (const n of CATALOG) out[n] = await collection(n).find({}).sort({ _id: 1 }).toArray();
  return JSON.parse(JSON.stringify(out));
}

const wire = variations.content.variations ?? variations.content.varations;

beforeAll(startTestMongo);
afterAll(stopTestMongo);
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await clearTestMongo();
  await collection('USERS').insertMany([
    { _id: 'admin-1', account: 'ADMIN', setUpProcess: true, balance: 0 },
    { _id: 'user-1', account: 'USER', balance: 0 },
  ]);
});

const url = '/admin/import/preview?collection=data-plans&serviceID=mtn-data&markup=15&round=10';

describe('GET /admin/import/preview', () => {
  it('refuses a non-admin', async () => {
    expect((await request(app).get(url).set('Authorization', asUser())).status).toBe(403);
  });

  it('proposes one row per variation, priced from cost', async () => {
    respond(variations);
    const res = await request(app).get(url).set('Authorization', asAdmin());

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(wire.length);

    const sample = res.body.items.find((i) => i.sourceCode === 'mtn-10mb-100');
    const source = wire.find((v) => v.variation_code === 'mtn-10mb-100');
    expect(sample.cost).toBe(Number(source.variation_amount));
    // 100 at 15% is 115; priceFrom rounds UP to the next multiple of 10 (never
    // down below cost plus markup, per src/models/import-plan.js), so 120.
    expect(sample.proposed.amount).toBe(120);
    // Parsed from the NAME: the code says 10mb, the name says 100MB.
    expect(sample.proposed.size).toBe('100MB');
    expect(sample.proposed.network).toBe('MTN');
    expect(sample.proposed.vtpassCode).toBe('mtn-10mb-100');
  });

  it('proposes attach against a matching row the operator already owns', async () => {
    await collection('DATAPACKS').insertOne({
      Network: 'MTN', Size: '100MB', Validity: '24 hrs', Amount: '₦95.0',
      dataId: 7, active: true, CreatedAt: new Date(),
    });
    respond(variations);
    const res = await request(app).get(url).set('Authorization', asAdmin());

    const sample = res.body.items.find((i) => i.sourceCode === 'mtn-10mb-100');
    expect(sample.action).toBe('attach');
    expect(sample.match.confidence).toBe('likely');
    expect(res.body.summary.attach).toBeGreaterThanOrEqual(1);
  });

  // Final review C1. proposeAction counts rows per variation, never variations
  // per row. The captured payload carries two 3GB plans (30 days and 2 days);
  // with one un-coded 3GB row, both used to propose attaching to it, both
  // started ticked, and applying them left the row pointing at whichever came
  // second -- a live plan silently repointed at a different product.
  it('refuses to attach two variations to the same row', async () => {
    const threeGb = wire.filter((v) => /\b3GB\b/.test(v.name)).map((v) => v.variation_code);
    expect(threeGb).toHaveLength(2);

    const rowId = String((await collection('DATAPACKS').insertOne({
      Network: 'MTN', Size: '3GB', Amount: '₦1000.0', dataId: 11, active: true, CreatedAt: new Date(),
    })).insertedId);
    respond(variations);
    const res = await request(app).get(url).set('Authorization', asAdmin());

    const claimed = res.body.items.filter((i) => threeGb.includes(i.sourceCode));
    expect(claimed).toHaveLength(2);
    for (const item of claimed) {
      expect(item.ambiguous).toBe(true);
      expect(item.action).toBe('create');
      expect(item.match).toBeNull();
    }
    expect(res.body.items.some((i) => i.action === 'attach' && i.match?.id === rowId)).toBe(false);
    // Counted after the downgrade, not before it.
    expect(res.body.summary.attach).toBe(0);
    expect(res.body.summary.create).toBe(res.body.items.length);
  });

  it('reports a row already carrying the code as already imported', async () => {
    await collection('DATAPACKS').insertOne({
      Network: 'MTN', Size: '100MB', Validity: '24 hrs', Amount: '₦115.0',
      vtpassCode: 'mtn-10mb-100', active: true, CreatedAt: new Date(),
    });
    respond(variations);
    const res = await request(app).get(url).set('Authorization', asAdmin());

    expect(res.body.items.find((i) => i.sourceCode === 'mtn-10mb-100').alreadyImported).toBe(true);
    expect(res.body.summary.alreadyImported).toBe(1);
  });

  // The guarantee this whole feature is built to preserve.
  it('writes nothing to any catalog collection', async () => {
    const before = await snapshotCatalog();
    respond(variations);
    await request(app).get(url).set('Authorization', asAdmin());
    expect(await snapshotCatalog()).toEqual(before);
  });

  it('flags a zero-margin import rather than silently pricing at cost', async () => {
    respond(variations);
    const res = await request(app)
      .get('/admin/import/preview?collection=data-plans&serviceID=mtn-data&markup=0&round=0')
      .set('Authorization', asAdmin());

    expect(res.body.items.every((i) => i.noMargin)).toBe(true);
  });

  // Service-level targets (networks, cables, electricity) match on name, not
  // on the size/validity/network fields parseVariation extracts from a plan
  // name -- a service has no such name to parse. This proves that path is
  // actually reachable, not just safely inert.
  it('proposes attach for a service-level target whose name matches an existing row', async () => {
    const wireService = services.content.find((s) => s.serviceID === 'mtn');
    await collection('NETWORKS').insertOne({
      name: wireService.name, id: 5, active: true, CreatedAt: new Date(),
    });
    respond(services);
    const res = await request(app)
      .get('/admin/import/preview?collection=networks&identifier=airtime&markup=0&round=0')
      .set('Authorization', asAdmin());

    const row = res.body.items.find((i) => i.sourceName === wireService.name);
    expect(row.action).toBe('attach');
    expect(row.match.id).toBeTruthy();
  });

  // Final review C3. The purchase path reads EPIN.vtpassServiceId as the VTpass
  // SERVICE id (providers/ids.js -> routes/purchases.js -> vtpass buyEpin), so
  // an imported pin must store the service it came from, never a plan code.
  // No education payload is captured and none may be invented, so this drives
  // the epins target with the real mtn-data payload: it tests the mechanism,
  // not education data.
  it('stores the service id, not the variation code, on an imported exam pin', async () => {
    respond(variations);
    const res = await request(app)
      .get('/admin/import/preview?collection=epins&serviceID=mtn-data&markup=15&round=10')
      .set('Authorization', asAdmin());

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(wire.length);
    res.body.items.forEach((item, i) => {
      expect(item.proposed.vtpassServiceId).toBe('mtn-data');
      // Still the plan it came from, so the dialog can say which.
      expect(item.sourceCode).toBe(wire[i].variation_code);
    });
  });

  // The same value is what an existing pin is compared against: a row that
  // already holds the service id is already imported.
  it('matches an exam pin against existing rows by the service id they store', async () => {
    await collection('EPIN').insertOne({
      examName: 'WAEC', amount: 1000, vtpassServiceId: 'mtn-data', active: true, CreatedAt: new Date(),
    });
    respond(variations);
    const res = await request(app)
      .get('/admin/import/preview?collection=epins&serviceID=mtn-data&markup=15&round=10')
      .set('Authorization', asAdmin());

    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((i) => i.alreadyImported)).toBe(true);
  });

  it('rejects a collection that cannot be imported into', async () => {
    const spy = respond(variations);
    const res = await request(app)
      .get('/admin/import/preview?collection=atc&serviceID=mtn-data&markup=15&round=10')
      .set('Authorization', asAdmin());

    expect(res.status).toBe(422);
    expect(spy).not.toHaveBeenCalled();
  });

  it('surfaces the provider message on a failure and writes nothing', async () => {
    const before = await snapshotCatalog();
    respond({ response_description: 'INVALID SERVICE' }, 400);
    const res = await request(app).get(url).set('Authorization', asAdmin());

    expect(res.status).toBe(503);
    expect(res.body.msg || res.body.message).toContain('INVALID SERVICE');
    expect(await snapshotCatalog()).toEqual(before);
  });
});
