import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const request = require('supertest');
const app = require('../../src/app');
const catalogRepo = require('../../src/repositories/catalog');
const { ADMIN_COLLECTIONS } = require('../../src/presenters/admin');
const { resolveNetwork } = require('../../src/models/resolve');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

describe('GET /catalog/*', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await catalogRepo.insertMany('DATAPACKS', [
      { dataId: 7, Network: 'MTN', planType: 'SME', Size: '1.0 GB', Validity: '30 days', Amount: '₦280.0', active: true },
    ]);
    await catalogRepo.insertMany('CABLES', [
      { CableID: 1, CableName: 'GOTV', img: 'g.png', active: true },
      { CableID: 2, CableName: 'DSTV', img: 'd.png', active: true },
    ]);
    await catalogRepo.insertMany('CABLESPLAN', [
      { CableplanID: 2, CableplanName: 'GOtv Max', amount: 4150, category: 'gotv', active: true },
      { CableplanID: 5, CableplanName: 'DStv Compact', amount: 9000, category: 'dstv', active: true },
      { CableplanID: 9, CableplanName: 'Orphan', amount: 100, category: 'nosuch', active: true },
    ]);
    await catalogRepo.insertMany('ELECTRICITY', [
      { DiscoID: 1, Disconame: 'Ikeja Electric', img: 'i.png', active: true },
    ]);
    await catalogRepo.insertMany('EPIN', [
      { examid: 1, examName: 'WAEC', amount: 2500, img: 'w.png', active: true },
    ]);
    await catalogRepo.insertMany('ATC', [
      { network: 'MTN', number: '08000000000', percent: 10, active: true },
    ]);
  });

  it('serves data plans publicly with a numeric amount', async () => {
    const res = await request(app).get('/catalog/data-plans');
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ network: 'MTN', type: 'SME', size: '1.0 GB', amount: 280 });
    expect(res.body[0].id).toEqual(expect.any(String));
    expect(res.body[0].docid).toBeUndefined();
    expect(res.body[0].Amount).toBeUndefined();
  });

  it('joins cable plans to their provider by category, case-insensitively', async () => {
    const providers = (await request(app).get('/catalog/cable-providers')).body;
    const plans = (await request(app).get('/catalog/cable-plans')).body;

    const gotv = providers.find((p) => p.name === 'GOTV');
    const dstv = providers.find((p) => p.name === 'DSTV');

    // buy-cable.vue filters with p.providerId === provider.id
    expect(plans.find((p) => p.name === 'GOtv Max').providerId).toBe(gotv.id);
    expect(plans.find((p) => p.name === 'DStv Compact').providerId).toBe(dstv.id);
    // A plan whose category matches no provider is simply never selectable.
    expect(plans.find((p) => p.name === 'Orphan').providerId).toBeNull();
  });

  it('serves discos, exam types and atc networks in contract shape', async () => {
    expect((await request(app).get('/catalog/disco-providers')).body[0])
      .toMatchObject({ name: 'Ikeja Electric', image: 'i.png' });
    expect((await request(app).get('/catalog/exam-types')).body[0])
      .toMatchObject({ name: 'WAEC', unitPrice: 2500 });
    expect((await request(app).get('/catalog/atc-networks')).body[0])
      .toMatchObject({ network: 'MTN', payoutNumber: '08000000000', commissionRate: 0.1 });
  });

  it('serves networks by the name an airtime purchase resolves, without provider ids', async () => {
    // Stored through the admin console's own producer, so the fixture has the
    // exact shape a network row has in production.
    const { networks } = ADMIN_COLLECTIONS;
    await catalogRepo.insertMany('NETWORKS', [
      networks.toStored({ name: 'MTN', logo: 'm.png', networkId: 1, vtpassAirtimeServiceId: 'mtn', active: true }),
      networks.toStored({ name: 'Glo', logo: 'g.png', networkId: 2, active: false }),
    ]);

    const res = await request(app).get('/catalog/networks');
    expect(res.status).toBe(200);

    const mtn = res.body.find((n) => n.name === 'MTN');
    expect(mtn).toMatchObject({ name: 'MTN', image: 'm.png', active: true });
    expect(mtn.id).toEqual(expect.any(String));
    // Inactive rows are listed and flagged, like every other catalog listing.
    expect(res.body.find((n) => n.name === 'Glo')).toMatchObject({ active: false });

    // buy-airtime.vue posts back the name it was shown; that name must resolve
    // to the same row the listing came from.
    expect((await resolveNetwork(mtn.name)).doc.docid).toBe(mtn.id);

    // Provider routing ids are the server's business, not the customer's.
    expect(mtn.networkId).toBeUndefined();
    expect(mtn.vtpassAirtimeServiceId).toBeUndefined();
    expect(mtn.docid).toBeUndefined();
  });

  it('requires no session', async () => {
    expect((await request(app).get('/catalog/data-plans')).status).toBe(200);
  });
});
