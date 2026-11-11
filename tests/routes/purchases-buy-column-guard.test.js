import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const catalogRepo = require('../../src/repositories/catalog');
const { serviceIdFor, validateIdFor } = require('../../src/providers/ids');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

// husmodata uses different identifier columns for its buy endpoints
// (CableID/DiscoID) than for its validate endpoints (CableName/Disconame).
// purchases.js:147 and :179 pick the buy column (serviceIdFor) for the
// new-contract POST /buy-cable and POST /buy-electricity routes -- the routes
// samzeenuxt actually calls -- but that was unguarded:
// tests/routes/purchases-rest.test.js only asserts status/wallet/balance, and
// its fixture happens to carry CableName so the wrong column would still be
// present and non-throwing; the only other coverage routes to vtpass, whose
// buy and validate columns coincide and so cannot discriminate either way.
//
// This mirrors the guard tests/routes/legacy-buy-endpoints.test.js already
// has for the legacy /cables/buy and /electricity/buy routes: derive both ids
// from the fixture through the real mapping functions and assert the buy id
// is on the wire and the validate id is not.
const auth = () => `Bearer ${jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET, { subject: 'user-1' })}`;

const fetchOk = (body, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    status,
    text: async () => JSON.stringify(body),
  });

// CableID/CableName and DiscoID/Disconame deliberately hold different values
// so a swap to the wrong column is observable.
const CABLE_FIXTURE = { CableID: 4, CableName: 'DSTV', active: true };
const DISCO_FIXTURE = { DiscoID: 7, Disconame: 'IKEDC', active: true };

describe('POST /buy-cable (new samzeenuxt contract)', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('user-1', { email: 'u@x.com', account: 'USER', balance: 50000 });
    await catalogRepo.insertMany('CABLES', [CABLE_FIXTURE]);
    await catalogRepo.insertMany('CABLESPLAN', [
      { CableplanID: 9, CableplanName: 'DStv Compact', amount: 9000, category: 'dstv', active: true },
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends husmodata the buy id (CableID), not the validate id (CableName)', async () => {
    const fetchSpy = fetchOk({ Status: 'successful', ident: 'c-1' });
    const planId = (await request(app).get('/catalog/cable-plans')).body[0].id;

    const res = await request(app)
      .post('/buy-cable')
      .set('Authorization', auth())
      .send({ provider: CABLE_FIXTURE.CableName, planId, smartcard: '1234567890' });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/cablesub/');
    const sentBody = JSON.parse(init.body);

    // Derived through the real mapping functions, not hard-coded, so this
    // keeps meaning something if the fixture or the column mapping changes.
    const buyId = serviceIdFor('husmodata', 'cable', CABLE_FIXTURE);
    const validateId = validateIdFor('husmodata', 'cable', CABLE_FIXTURE);
    // Fixture-sanity: if these coincided, the assertions below would pass
    // vacuously regardless of which column purchases.js actually picked.
    expect(buyId).not.toBe(validateId);

    expect(sentBody.cablename).toBe(buyId);
    expect(sentBody.cablename).not.toBe(validateId);
  });
});

describe('POST /buy-electricity (new samzeenuxt contract)', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('user-1', { email: 'u@x.com', account: 'USER', balance: 50000 });
    await catalogRepo.insertMany('ELECTRICITY', [DISCO_FIXTURE]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends husmodata the buy id (DiscoID), not the validate id (Disconame)', async () => {
    const fetchSpy = fetchOk({ Status: 'successful', ident: 'e-1', token: '1234-5678' });

    const res = await request(app)
      .post('/buy-electricity')
      .set('Authorization', auth())
      .send({
        disco: DISCO_FIXTURE.Disconame,
        meterType: 'Prepaid',
        meter: '04123456789',
        amount: 1000,
        phone: '08000000000',
      });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/billpayment/');
    const sentBody = JSON.parse(init.body);

    const buyId = serviceIdFor('husmodata', 'electricity', DISCO_FIXTURE);
    const validateId = validateIdFor('husmodata', 'electricity', DISCO_FIXTURE);
    expect(buyId).not.toBe(validateId);

    expect(sentBody.disco_name).toBe(buyId);
    expect(sentBody.disco_name).not.toBe(validateId);
  });
});
