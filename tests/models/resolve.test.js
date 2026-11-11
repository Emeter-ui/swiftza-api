import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { resolveNetwork, resolveCable, resolveDisco } = require('../../src/models/resolve');
const catalogRepo = require('../../src/repositories/catalog');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

describe('name to provider-id resolution', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await catalogRepo.insertMany('NETWORKS', [
      { name: 'Mtn', id: 1, active: true },
      { name: '9mobile', id: 3, active: true },
      { name: 'Glo', id: 2, active: false },
    ]);
    await catalogRepo.insertMany('CABLES', [{ CableName: 'DSTV', CableID: 2, active: true }]);
    await catalogRepo.insertMany('ELECTRICITY', [{ Disconame: 'Ikeja Electric', DiscoID: 1, active: true }]);
  });

  it('matches case-insensitively — buy-data.vue sends "MTN", the catalog stores "Mtn"', async () => {
    expect((await resolveNetwork('MTN')).providerId).toBe(1);
    expect((await resolveNetwork('  mtn  ')).providerId).toBe(1);
    expect((await resolveNetwork('9MOBILE')).providerId).toBe(3);
  });

  it('resolves cable and disco names', async () => {
    expect((await resolveCable('DStv')).providerId).toBe(2);
    expect((await resolveDisco('ikeja electric')).providerId).toBe(1);
  });

  it('rejects an unknown name with 422, not 500', async () => {
    await expect(resolveNetwork('Vodafone')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED', httpStatus: 422,
    });
  });

  it('rejects an inactive entry', async () => {
    await expect(resolveNetwork('Glo')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects an empty name', async () => {
    await expect(resolveNetwork('')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(resolveNetwork(undefined)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
