import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const catalogModel = require('../../src/models/catalog');
const catalogRepo = require('../../src/repositories/catalog');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

describe('models/catalog', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(clearTestMongo);

  it('parses both the display-string and numeric price forms', () => {
    expect(catalogModel.parsePrice('₦4200.0')).toBe(4200);
    expect(catalogModel.parsePrice(4200)).toBe(4200);
    expect(catalogModel.parsePrice('nonsense')).toBeNaN();
  });

  it('resolves a data plan by dataId and takes the price from the catalog', async () => {
    await catalogRepo.insertMany('DATAPACKS', [
      { dataId: 7, Network: 'MTN', Size: '1.0 GB', Amount: '₦280.0', active: true },
    ]);

    const plan = await catalogModel.getDataPlan({ dataId: 7 });
    expect(plan).toMatchObject({ price: 280, providerPlanId: 7, label: 'MTN 1.0 GB' });
  });

  it('resolves a data plan by docid', async () => {
    const docid = await catalogRepo.insert('DATAPACKS', {
      dataId: 7, Network: 'MTN', Size: '1.0 GB', Amount: '₦280.0', active: true,
    });

    expect((await catalogModel.getDataPlan({ docid })).price).toBe(280);
  });

  it('falls back to dataId when docid is malformed rather than throwing', async () => {
    await catalogRepo.insertMany('DATAPACKS', [
      { dataId: 7, Network: 'MTN', Size: '1.0 GB', Amount: '₦280.0', active: true },
    ]);

    // Firestore accepted any string as a doc id; ObjectId does not. Without
    // the isValid guard this is a 500 instead of a clean fallback.
    const plan = await catalogModel.getDataPlan({ docid: 'not-an-object-id', dataId: 7 });
    expect(plan.price).toBe(280);
  });

  it('rejects an inactive plan', async () => {
    await catalogRepo.insertMany('DATAPACKS', [
      { dataId: 7, Network: 'MTN', Size: '1.0 GB', Amount: '₦280.0', active: false },
    ]);

    await expect(catalogModel.getDataPlan({ dataId: 7 }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects an unknown plan', async () => {
    await expect(catalogModel.getDataPlan({ dataId: 999 }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects a dataId that is a Mongo query operator instead of resolving an arbitrary plan', async () => {
    // Two plans seeded so an injection that matched "anything" would visibly
    // resolve one of them rather than the request failing cleanly.
    await catalogRepo.insertMany('DATAPACKS', [
      { dataId: 1, Network: 'MTN', Size: '1.0 GB', Amount: '₦280.0', active: true },
      { dataId: 2, Network: 'GLO', Size: '2.0 GB', Amount: '₦500.0', active: true },
    ]);

    // Under Firestore this matched nothing (where() only accepts scalars).
    // Under raw MongoDB, findOne({ dataId: { $ne: null } }) would resolve the
    // first plan in the collection -- a plan the caller never selected.
    await expect(catalogModel.getDataPlan({ dataId: { $ne: null } }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects a plan with an unparseable price', async () => {
    await catalogRepo.insertMany('DATAPACKS', [
      { dataId: 7, Network: 'MTN', Amount: 'free', active: true },
    ]);

    await expect(catalogModel.getDataPlan({ dataId: 7 }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('resolves a cable plan', async () => {
    await catalogRepo.insertMany('CABLESPLAN', [
      { CableplanID: 5, CableplanName: 'DStv Compact', amount: 9000, active: true },
    ]);

    expect(await catalogModel.getCablePlan(5)).toMatchObject({ price: 9000, providerPlanId: 5 });
  });

  it('multiplies the epin unit price by quantity and bounds it', async () => {
    await catalogRepo.insertMany('EPIN', [{ examName: 'WAEC', amount: 2500, active: true }]);

    expect((await catalogModel.getEpin('WAEC', 3)).price).toBe(7500);
    await expect(catalogModel.getEpin('WAEC', 0)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(catalogModel.getEpin('WAEC', 21)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('resolves an ATC rate', async () => {
    await catalogRepo.insertMany('ATC', [
      { network: 'MTN', number: '08000000000', percent: 10, active: true },
    ]);

    expect(await catalogModel.getAtcRate('MTN')).toEqual({
      percent: 10, number: '08000000000', network: 'MTN',
    });
  });

  it('bounds variable amounts', () => {
    expect(catalogModel.validateAirtimeAmount(100)).toBe(100);
    expect(() => catalogModel.validateAirtimeAmount(10)).toThrow();
    expect(() => catalogModel.validateElectricityAmount(100)).toThrow();
    expect(catalogModel.validateElectricityAmount(1000)).toBe(1000);
  });
});
