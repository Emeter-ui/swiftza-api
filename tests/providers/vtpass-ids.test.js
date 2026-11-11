import { describe, it, expect, vi, afterEach } from 'vitest';
const vtpass = require('../../src/providers/vtpass');
const { serviceIdFor, validateIdFor } = require('../../src/providers/ids');

// One catalog row per kind, carrying every column a provider might read off
// it. The husmodata comparison values below are derived from these fixtures
// through the real column-mapping functions (providers/ids.js), not
// hard-coded, so the negative assertions stay meaningful if the fixture or
// the column mapping ever changes.
const CABLE_DOC = { CableName: 'DSTV', CableID: 4, vtpassServiceId: 'dstv' };
const DISCO_DOC = { Disconame: 'IKEDC', DiscoID: 7, vtpassServiceId: 'ikedc-electric' };

describe('vtpass adapter takes resolved ids', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes the given serviceID and variation_code straight through', async () => {
    let sent = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ code: '000', content: { transactions: { status: 'delivered' } } }),
        { status: 200 }
      );
    });
    process.env.PROVIDER_VTPASS_API_KEY = 'k';
    process.env.PROVIDER_VTPASS_SECRET_KEY = 's';

    const p = vtpass.create({});
    await p.buyData({ networkId: 'mtn-data', phone: '08030000000', planId: 'mtn-1gb', transref: 't1' });

    expect(sent.serviceID).toBe('mtn-data');
    expect(sent.variation_code).toBe('mtn-1gb');
  });

  it('no longer requires a serviceMap in config', () => {
    // create({}) with no serviceMap must not throw -- mapping moved to the catalog.
    expect(() => vtpass.create({})).not.toThrow();
  });

  it('validateIuc sends the VTpass service id straight through, not any husmodata value', async () => {
    let sent = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ code: '000', content: { name: 'JOHN DOE' } }),
        { status: 200 }
      );
    });
    process.env.PROVIDER_VTPASS_API_KEY = 'k';
    process.env.PROVIDER_VTPASS_SECRET_KEY = 's';

    // Whatever the route resolves via validateIdFor('vtpass', 'cable', doc)
    // for this row.
    const vtpassId = validateIdFor('vtpass', 'cable', CABLE_DOC);
    // What husmodata's own validate call would carry for the same row
    // (the display name -- see providers/ids.js VALIDATE_COLUMNS) and what
    // husmodata's buy call would carry (the numeric CableID).
    const husmodataValidateId = validateIdFor('husmodata', 'cable', CABLE_DOC);
    const husmodataBuyId = serviceIdFor('husmodata', 'cable', CABLE_DOC);

    const p = vtpass.create({});
    await p.validateIuc({ smartCard: '1234567890', cableId: vtpassId });

    expect(sent.serviceID).toBe(vtpassId);
    expect(sent.serviceID).not.toBe(husmodataValidateId);
    expect(sent.serviceID).not.toBe(husmodataBuyId);
    expect(typeof sent.serviceID).not.toBe('number');
  });

  it('validateMeter sends the VTpass service id straight through, not any husmodata value', async () => {
    let sent = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ code: '000', content: { name: 'JOHN DOE' } }),
        { status: 200 }
      );
    });
    process.env.PROVIDER_VTPASS_API_KEY = 'k';
    process.env.PROVIDER_VTPASS_SECRET_KEY = 's';

    const vtpassId = validateIdFor('vtpass', 'electricity', DISCO_DOC);
    const husmodataValidateId = validateIdFor('husmodata', 'electricity', DISCO_DOC);
    const husmodataBuyId = serviceIdFor('husmodata', 'electricity', DISCO_DOC);

    const p = vtpass.create({});
    await p.validateMeter({ meterNumber: '1111111111', discoId: vtpassId, meterType: 'prepaid' });

    expect(sent.serviceID).toBe(vtpassId);
    expect(sent.serviceID).not.toBe(husmodataValidateId);
    expect(sent.serviceID).not.toBe(husmodataBuyId);
    expect(typeof sent.serviceID).not.toBe('number');
  });
});
