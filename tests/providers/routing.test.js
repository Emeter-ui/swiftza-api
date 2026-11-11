import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');
const { collection } = require('../../src/services/mongo');
const providers = require('../../src/providers');

const setRouting = (doc) =>
  collection('SETTINGS').updateOne({ _id: 'providers' }, { $set: doc }, { upsert: true });

describe('provider routing', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => { await clearTestMongo(); providers.refresh(); });
  afterEach(() => providers.refresh());

  it('uses the default when a service has no override', async () => {
    await setRouting({ active: 'husmodata', overrides: {} });
    expect(await providers.getProviderName('data')).toBe('husmodata');
  });

  it('honours a per-service override', async () => {
    await setRouting({ active: 'husmodata', overrides: { cable: 'vtpass' } });
    expect(await providers.getProviderName('cable')).toBe('vtpass');
    // The override must not leak to other services.
    expect(await providers.getProviderName('data')).toBe('husmodata');
  });

  it('getProvider returns the overridden adapter', async () => {
    await setRouting({ active: 'husmodata', overrides: { cable: 'vtpass' } });
    const p = await providers.getProvider('cable');
    expect(p.name).toBe('vtpass');
  });

  it('reports routing with its source for every service', async () => {
    await setRouting({ active: 'husmodata', overrides: { cable: 'vtpass' } });
    const routing = await providers.getRouting();
    expect(routing.active).toBe('husmodata');
    expect(routing.services.cable).toEqual({ provider: 'vtpass', source: 'override' });
    expect(routing.services.data).toEqual({ provider: 'husmodata', source: 'default' });
    expect(Object.keys(routing.services).sort()).toEqual(
      ['airtime', 'cable', 'data', 'electricity', 'epin']
    );
  });

  it('rejects an override naming an unknown provider', async () => {
    await setRouting({ active: 'husmodata', overrides: { cable: 'nope' } });
    await expect(providers.getProvider('cable')).rejects.toThrow(/Unknown provider/);
  });
});
