import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const catalogRepo = require('../../src/repositories/catalog');
const { serviceIdFor, validateIdFor } = require('../../src/providers/ids');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

// POST /cables/buy and POST /electricity/buy are the legacy samzeedatas
// contract -- see samzeedatas/src/components/dashboard/buycable.vue's
// BuyCable() and buyelectricty.vue's PurchaseDisco(), which post the shapes
// used below. There was previously no HTTP-level test for either endpoint;
// the only cable/electricity buy coverage hit /buy-cable and /buy-electricity
// in purchases.js, a different route file. That gap is why routing these two
// endpoints' prepare hooks through validateIdFor (the display name column)
// instead of serviceIdFor (the numeric column husmodata's buy endpoints
// expect) went unnoticed by the suite.
const auth = () => `Bearer ${jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET, { subject: 'user-1' })}`;

const fetchOk = (body, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    status,
    text: async () => JSON.stringify(body),
  });

const CABLE_FIXTURE = { CableName: 'DSTV', CableID: 4, vtpassServiceId: 'dstv', active: true };
const DISCO_FIXTURE = { Disconame: 'IKEDC', DiscoID: 7, vtpassServiceId: 'ikedc-electric', active: true };

describe('POST /cables/buy (legacy samzeedatas contract)', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('user-1', { email: 'u@x.com', account: 'USER', balance: 50000 });
    await catalogRepo.insertMany('CABLES', [CABLE_FIXTURE]);
    await catalogRepo.insertMany('CABLESPLAN', [
      { CableplanID: 9, CableplanName: 'DStv Compact', amount: 9000, category: 'dstv', vtpassCode: 'dstv-compact', active: true },
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  // Modeled on buycable.vue's BuyCable() body: cableID, cablePlanId,
  // cableName, planName, iuc, IucAccName, uid, amount, transref, channel,
  // createdAt.
  it('sends husmodata the NUMERIC CableID as cablename, not the display name', async () => {
    const fetchSpy = fetchOk({ Status: 'successful', ident: 'c-1' });

    const res = await request(app)
      .post('/cables/buy')
      .set('Authorization', auth())
      .send({
        cableID: CABLE_FIXTURE.CableID,
        cablePlanId: 9,
        cableName: CABLE_FIXTURE.CableName,
        planName: 'DStv Compact',
        iuc: '1234567890',
        IucAccName: 'JOHN DOE',
        uid: 'user-1',
        amount: 9000,
        transref: 'cable-buy-ref-1',
        channel: 'web',
        createdAt: new Date().toISOString(),
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(fetchSpy).toHaveBeenCalled();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/cablesub/');
    const sentBody = JSON.parse(init.body);

    // Derived from the fixture through the real mapping functions, not
    // hard-coded, so this keeps meaning something if the fixture changes.
    const husmodataBuyId = serviceIdFor('husmodata', 'cable', CABLE_FIXTURE);
    const husmodataValidateId = validateIdFor('husmodata', 'cable', CABLE_FIXTURE);

    expect(sentBody.cablename).toBe(husmodataBuyId);
    expect(sentBody.cablename).not.toBe(husmodataValidateId);
    expect(sentBody.cablename).not.toBe(CABLE_FIXTURE.CableName);
  });
});

describe('POST /electricity/buy (legacy samzeedatas contract)', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('user-1', { email: 'u@x.com', account: 'USER', balance: 50000 });
    await catalogRepo.insertMany('ELECTRICITY', [DISCO_FIXTURE]);
  });
  afterEach(() => vi.restoreAllMocks());

  // Modeled on buyelectricty.vue's PurchaseDisco() body: this.dform carries
  // discoName, DiscoID, meterno, meterType, amount, phone, meterName,
  // meterTypeId, plus uid/transref/channel/createdAt added just before
  // posting.
  it('sends husmodata the NUMERIC DiscoID as disco_name, not the display name', async () => {
    const fetchSpy = fetchOk({ Status: 'successful', ident: 'e-1', token: '1234-5678' });

    const res = await request(app)
      .post('/electricity/buy')
      .set('Authorization', auth())
      .send({
        discoName: DISCO_FIXTURE.Disconame,
        DiscoID: DISCO_FIXTURE.DiscoID,
        meterno: '04123456789',
        meterType: 'Prepaid',
        amount: 2000,
        phone: '08000000000',
        meterName: 'JOHN DOE',
        meterTypeId: 1,
        uid: 'user-1',
        transref: 'electric-buy-ref-1',
        channel: 'web',
        createdAt: new Date().toISOString(),
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(fetchSpy).toHaveBeenCalled();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/billpayment/');
    const sentBody = JSON.parse(init.body);

    const husmodataBuyId = serviceIdFor('husmodata', 'electricity', DISCO_FIXTURE);
    const husmodataValidateId = validateIdFor('husmodata', 'electricity', DISCO_FIXTURE);

    expect(sentBody.disco_name).toBe(husmodataBuyId);
    expect(sentBody.disco_name).not.toBe(husmodataValidateId);
    expect(sentBody.disco_name).not.toBe(DISCO_FIXTURE.Disconame);
  });
});
