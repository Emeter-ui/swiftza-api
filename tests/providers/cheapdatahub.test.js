import { describe, it, expect, vi, afterEach } from 'vitest';
const cheapdatahub = require('../../src/providers/cheapdatahub');
const { serviceIdFor, planIdFor, validateIdFor } = require('../../src/providers/ids');

const reply = (body, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status })
  );

describe('cheapdatahub adapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends the documented airtime body with a Bearer key and trailing slash', async () => {
    const spy = reply({ status: 'true', message: 'ok', transaction_id: 449 });
    const r = await cheapdatahub.create({}).buyAirtime({ networkId: 1, phone: '08012345678', amount: 100 });

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://www.cheapdatahub.ng/api/v1/resellers/airtime/purchase/');
    expect(init.headers.Authorization).toBe('Bearer test-cheapdatahub-api-key');
    expect(JSON.parse(init.body)).toEqual({ provider_id: 1, phone_number: '08012345678', amount: 100 });
    expect(r.status).toBe('success');
    expect(r.reference).toBe(449);
    expect(r.providerRequestId).toBe('449');
  });

  it('buys data by bundle id alone', async () => {
    const spy = reply({ status: 'true', message: 'ok', reference: 'CDH567890' });
    const r = await cheapdatahub.create({}).buyData({ networkId: 1, phone: '0801', planId: 46 });
    expect(JSON.parse(spy.mock.calls[0][1].body)).toEqual({ bundle_id: 46, phone_number: '0801' });
    expect(r.status).toBe('success');
    expect(r.reference).toBe('CDH567890');
  });

  it('reads status "false" as failed', async () => {
    reply({ status: 'false', message: 'Invalid bundle' });
    const r = await cheapdatahub.create({}).buyData({ phone: '0801', planId: 1 });
    expect(r.status).toBe('failed');
    expect(r.message).toBe('Invalid bundle');
  });

  it('reads a documented 4xx (insufficient balance) as failed', async () => {
    reply({ status: 'false', message: 'Insufficient balance' }, 402);
    const r = await cheapdatahub.create({}).buyData({ phone: '0801', planId: 1 });
    expect(r.status).toBe('failed');
  });

  it('holds a 5xx, a timeout-like failure, or an unknown body as pending -- never refunds', async () => {
    reply({ detail: 'boom' }, 500);
    expect((await cheapdatahub.create({}).buyData({ phone: '0801', planId: 1 })).status).toBe('pending');

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('socket hang up'));
    expect((await cheapdatahub.create({}).buyData({ phone: '0801', planId: 1 })).status).toBe('pending');

    vi.restoreAllMocks();
    reply({ something: 'else' });
    expect((await cheapdatahub.create({}).buyData({ phone: '0801', planId: 1 })).status).toBe('pending');
  });

  it('holds an accepted-but-processing transaction as pending', async () => {
    reply({ status: 'true', message: 'queued', data: { transaction: { id: 9, status: 'processing' } } });
    const r = await cheapdatahub.create({}).buyData({ phone: '0801', planId: 1 });
    expect(r.status).toBe('pending');
    expect(r.providerRequestId).toBe('9');
  });

  it('validates a meter and returns the customer', async () => {
    const spy = reply({ status: 'true', data: { name: 'ADAMS BROWN', address: '1 Wole Str' } });
    const r = await cheapdatahub.create({}).validateMeter({ meterNumber: '0411', discoId: 4, meterType: 'PREPAID' });
    expect(JSON.parse(spy.mock.calls[0][1].body)).toEqual({ disco_id: 4, meter_type: 'prepaid', meter_number: '0411' });
    expect(r).toEqual({ valid: true, data: { name: 'ADAMS BROWN', address: '1 Wole Str' } });
  });

  it('reports an invalid smart card with the provider message', async () => {
    reply({ status: 'false', message: 'Customer details could not be validated' }, 400);
    const r = await cheapdatahub.create({}).validateIuc({ smartCard: '807', cableId: 12 });
    expect(r.valid).toBe(false);
    expect(r.message).toBe('Customer details could not be validated');
  });

  it('requery trusts only a positively stated status', async () => {
    reply({ status: 'true', data: { id: 449, status: 'successful' } });
    expect((await cheapdatahub.create({}).requery('449')).status).toBe('success');

    vi.restoreAllMocks();
    reply({ status: 'true', data: { id: 449, status: 'refunded' } });
    expect((await cheapdatahub.create({}).requery('449')).status).toBe('failed');

    vi.restoreAllMocks();
    reply({ detail: 'Not found.' }, 404);
    expect((await cheapdatahub.create({}).requery('449')).status).toBe('pending');

    vi.restoreAllMocks();
    reply({ status: 'true', data: { id: 449 } });
    expect((await cheapdatahub.create({}).requery('449')).status).toBe('pending');
  });

  it('maps catalog columns for every service', () => {
    const net = { id: 11, cheapdatahubNetworkId: 1 };
    expect(serviceIdFor('cheapdatahub', 'airtime', net)).toBe(1);
    expect(serviceIdFor('cheapdatahub', 'data', net)).toBe(1);
    expect(planIdFor('cheapdatahub', 'data', { cheapdatahubBundleId: 46 })).toBe(46);
    expect(planIdFor('cheapdatahub', 'cable', { cheapdatahubPlanId: 8 })).toBe(8);
    expect(validateIdFor('cheapdatahub', 'cable', { cheapdatahubValidatePlanId: 3 })).toBe(3);
    expect(validateIdFor('cheapdatahub', 'electricity', { cheapdatahubDiscoId: 4 })).toBe(4);
    expect(serviceIdFor('cheapdatahub', 'epin', { cheapdatahubProductId: 2 })).toBe(2);
    expect(() => planIdFor('cheapdatahub', 'data', { dataId: 7 })).toThrow(/cheapdatahubBundleId/);
  });
});
