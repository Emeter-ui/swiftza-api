import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const catalogRepo = require('../../src/repositories/catalog');
const { collection } = require('../../src/services/mongo');
const providers = require('../../src/providers');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

// /validate now resolves the cable/disco name against the catalog before
// calling the provider adapter (src/routes/cables.js, src/routes/electricity.js),
// so these tests need the Mongo test harness even though requireAuth itself
// does no database lookup.
const token = () => jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET, { subject: 'user-1' });
const auth = () => `Bearer ${token()}`;

// vi.mock does not work in this project (see tests/routes/purchase.test.js):
// every file under src/ is CommonJS reached through app.js's require() chain,
// and Vitest's mock registry only intercepts static ESM `import` statements.
// Stub at the fetch boundary instead (src/models/http.js calls global fetch),
// which exercises the provider adapter own request/response handling rather
// than bypassing it.
const fetchOk = (body, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    status,
    text: async () => JSON.stringify(body),
  });

const setRouting = (doc) =>
  collection('SETTINGS').updateOne({ _id: 'providers' }, { $set: doc }, { upsert: true });

const CABLE_FIXTURE = { CableName: 'DSTV', CableID: 4, vtpassServiceId: 'dstv', active: true };
const DISCO_FIXTURE = { Disconame: 'IKEDC', DiscoID: 7, vtpassServiceId: 'ikedc-electric', active: true };

describe('GET /cables/validate', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    providers.refresh();
    await catalogRepo.insertMany('CABLES', [CABLE_FIXTURE]);
  });
  afterEach(() => vi.restoreAllMocks());

  // Confirmed against samzeedatas/src/components/dashboard/buycable.vue:147
  // and against pre-refactor production code (git show 690d65c:
  // smazeeapis/src/models/airtimeapi.js), where ValidateIuc(iuc_number,
  // cable_company) sent the raw Vue-supplied display name, not a numeric id --
  // a different husmodata endpoint and contract from BuyCable numeric
  // cableID. This asserts that production-verified wire shape holds with
  // husmodata as the default/no-override provider (tests/setup.js).
  it('sends the cable display name to husmodata, unchanged from production', async () => {
    const fetchSpy = fetchOk({ name: 'JOHN DOE' });

    const res = await request(app)
      .get('/cables/validate')
      .set('Authorization', auth())
      .query({ iucNumber: '1234567890', cableName: 'DSTV' });

    expect(res.status).toBe(200);
    expect(res.body.customerName).toBe('JOHN DOE');
    expect(fetchSpy).toHaveBeenCalled();
    const calledUrl = fetchSpy.mock.calls[0][0];
    expect(calledUrl).toContain('smart_card_number=1234567890');
    expect(calledUrl).toContain('cablename=DSTV');
  });

  it('accepts the new-contract aliases smartcard/provider (samzeenuxt)', async () => {
    fetchOk({ name: 'JOHN DOE' });

    const res = await request(app)
      .get('/cables/validate')
      .set('Authorization', auth())
      .query({ smartcard: '1234567890', provider: 'DSTV' });

    expect(res.status).toBe(200);
    expect(res.body.customerName).toBe('JOHN DOE');
  });

  it('returns customerName from customer_name when name is absent', async () => {
    fetchOk({ customer_name: 'JANE DOE' });

    const res = await request(app)
      .get('/cables/validate')
      .set('Authorization', auth())
      .query({ iucNumber: '1234567890', cableName: 'DSTV' });

    expect(res.body.customerName).toBe('JANE DOE');
  });

  it('still rejects a request missing a required parameter', async () => {
    const fetchSpy = fetchOk({ name: 'JOHN DOE' });

    const res = await request(app)
      .get('/cables/validate')
      .set('Authorization', auth())
      .query({ iucNumber: '1234567890' });

    expect(res.status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a cable name not in the catalog before calling the provider', async () => {
    const fetchSpy = fetchOk({ name: 'JOHN DOE' });

    const res = await request(app)
      .get('/cables/validate')
      .set('Authorization', auth())
      .query({ iucNumber: '1234567890', cableName: 'NOT-A-REAL-CABLE-CO' });

    expect(res.status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the VTpass service id, and NOT the husmodata name, when cable is overridden to vtpass', async () => {
    await setRouting({ active: 'husmodata', overrides: { cable: 'vtpass' } });
    const fetchSpy = fetchOk({ code: '000', content: { name: 'JOHN DOE' } });

    const res = await request(app)
      .get('/cables/validate')
      .set('Authorization', auth())
      .query({ iucNumber: '1234567890', cableName: 'DSTV' });

    expect(res.status).toBe(200);
    expect(res.body.customerName).toBe('JOHN DOE');
    const [, init] = fetchSpy.mock.calls[0];
    const sentBody = JSON.parse(init.body);
    expect(sentBody.serviceID).toBe(CABLE_FIXTURE.vtpassServiceId);
    expect(sentBody.serviceID).not.toBe(CABLE_FIXTURE.CableName);
  });
});

describe('GET /electricity/validate', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    providers.refresh();
    await catalogRepo.insertMany('ELECTRICITY', [DISCO_FIXTURE]);
  });
  afterEach(() => vi.restoreAllMocks());

  // Confirmed against samzeedatas/src/components/dashboard/buyelectricty.vue:127
  // and against pre-refactor production code (git show 690d65c:
  // smazeeapis/src/models/airtimeapi.js): husmodata validate_meter_number
  // endpoint takes the disco display name, not the numeric DiscoID used by
  // the buy path. This asserts that production-verified wire shape holds with
  // husmodata as the default/no-override provider (tests/setup.js).
  it('sends the disco display name to husmodata, unchanged from production', async () => {
    const fetchSpy = fetchOk({ name: 'JOHN DOE' });

    const res = await request(app)
      .get('/electricity/validate')
      .set('Authorization', auth())
      .query({ meterNumber: '1111111111', disconame: 'IKEDC', mtype: 'PREPAID' });

    expect(res.status).toBe(200);
    expect(res.body.customerName).toBe('JOHN DOE');
    expect(fetchSpy).toHaveBeenCalled();
    const calledUrl = fetchSpy.mock.calls[0][0];
    expect(calledUrl).toContain('meternumber=1111111111');
    expect(calledUrl).toContain('disconame=IKEDC');
    expect(calledUrl).toContain('mtype=PREPAID');
  });

  it('accepts the new-contract aliases meter/disco/type (samzeenuxt)', async () => {
    fetchOk({ name: 'JOHN DOE' });

    const res = await request(app)
      .get('/electricity/validate')
      .set('Authorization', auth())
      .query({ meter: '1111111111', disco: 'IKEDC', type: 'PREPAID' });

    expect(res.status).toBe(200);
    expect(res.body.customerName).toBe('JOHN DOE');
  });

  it('returns customerName from Customer_Name when name and customer_name are absent', async () => {
    fetchOk({ Customer_Name: 'JANE DOE' });

    const res = await request(app)
      .get('/electricity/validate')
      .set('Authorization', auth())
      .query({ meterNumber: '1111111111', disconame: 'IKEDC', mtype: 'PREPAID' });

    expect(res.body.customerName).toBe('JANE DOE');
  });

  it('still rejects a request missing a required parameter', async () => {
    const fetchSpy = fetchOk({ name: 'JOHN DOE' });

    const res = await request(app)
      .get('/electricity/validate')
      .set('Authorization', auth())
      .query({ meterNumber: '1111111111' });

    expect(res.status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a disco name not in the catalog before calling the provider', async () => {
    const fetchSpy = fetchOk({ name: 'JOHN DOE' });

    const res = await request(app)
      .get('/electricity/validate')
      .set('Authorization', auth())
      .query({ meterNumber: '1111111111', disconame: 'NOT-A-REAL-DISCO', mtype: 'PREPAID' });

    expect(res.status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the VTpass service id, and NOT the husmodata name, when electricity is overridden to vtpass', async () => {
    await setRouting({ active: 'husmodata', overrides: { electricity: 'vtpass' } });
    const fetchSpy = fetchOk({ code: '000', content: { name: 'JOHN DOE' } });

    const res = await request(app)
      .get('/electricity/validate')
      .set('Authorization', auth())
      .query({ meterNumber: '1111111111', disconame: 'IKEDC', mtype: 'PREPAID' });

    expect(res.status).toBe(200);
    expect(res.body.customerName).toBe('JOHN DOE');
    const [, init] = fetchSpy.mock.calls[0];
    const sentBody = JSON.parse(init.body);
    expect(sentBody.serviceID).toBe(DISCO_FIXTURE.vtpassServiceId);
    expect(sentBody.serviceID).not.toBe(DISCO_FIXTURE.Disconame);
  });
});
