import { describe, it, expect } from 'vitest';

const { ADMIN_COLLECTIONS, formatNairaAmount } = require('../../src/presenters/admin');

const seg = (name) => ADMIN_COLLECTIONS[name];

describe('formatNairaAmount', () => {
  it('formats a number into the display string samzeedatas renders verbatim', () => {
    expect(formatNairaAmount(4200)).toBe('₦4200.0');
    expect(formatNairaAmount('4200')).toBe('₦4200.0');
  });

  it('passes an already-formatted string through unchanged', () => {
    expect(formatNairaAmount('₦4200.0')).toBe('₦4200.0');
  });
});

describe('networks', () => {
  it('presents stored img as logo and stored id as networkId', () => {
    expect(seg('networks').present({ docid: 'n1', name: 'Mtn', img: 'i.png', id: 1, active: true }))
      .toEqual({ id: 'n1', name: 'Mtn', logo: 'i.png', networkId: 1, vtpassDataServiceId: null, vtpassAirtimeServiceId: null, cheapdatahubNetworkId: null, active: true });
  });

  it('maps a submitted row back to stored shape', () => {
    expect(seg('networks').toStored({ name: 'Mtn', logo: 'i.png', networkId: '1', active: true }))
      .toEqual({ name: 'Mtn', img: 'i.png', id: 1, vtpassDataServiceId: null, vtpassAirtimeServiceId: null, cheapdatahubNetworkId: null, active: true });
  });
});

describe('data-plans', () => {
  it('presents the display-string Amount as a numeric amount', () => {
    expect(seg('data-plans').present({
      docid: 'd1', Network: 'MTN', planType: 'SME', Size: '1.0 GB',
      Validity: '30 days', Amount: '₦280.0', dataId: 7, active: true,
    })).toEqual({
      id: 'd1', network: 'MTN', type: 'SME', size: '1.0 GB',
      validity: '30 days', amount: 280, dataId: 7, vtpassCode: null, cheapdatahubBundleId: null, active: true,
    });
  });

  it('formats a numeric amount back into the display string on write', () => {
    const stored = seg('data-plans').toStored({
      network: 'MTN', type: 'SME', size: '1.0 GB', validity: '30 days',
      amount: 280, dataId: '7', active: true,
    });
    expect(stored).toEqual({
      Network: 'MTN', planType: 'SME', Size: '1.0 GB',
      Validity: '30 days', Amount: '₦280.0', dataId: 7, vtpassCode: null, cheapdatahubBundleId: null, active: true,
    });
  });
});

describe('atc', () => {
  it('presents percent as a commissionRate fraction', () => {
    expect(seg('atc').present({ docid: 'a1', network: 'MTN', number: '08000000000', percent: 10, active: true }))
      .toEqual({ id: 'a1', network: 'MTN', payoutNumber: '08000000000', commissionRate: 0.1, active: true });
  });

  it('converts a commissionRate fraction back to percent on write', () => {
    // The unit change is the point: 0.1 on the wire is 10 in storage.
    expect(seg('atc').toStored({ network: 'MTN', payoutNumber: '08000000000', commissionRate: 0.1, active: true }))
      .toEqual({ network: 'MTN', number: '08000000000', percent: 10, active: true });
  });
});

describe('cables and cable-plans', () => {
  it('presents CableName as name and CableID as cableId', () => {
    expect(seg('cables').present({ docid: 'c1', CableName: 'GOTV', img: 'g.png', CableID: 1, active: true }))
      .toEqual({ id: 'c1', name: 'GOTV', logo: 'g.png', cableId: 1, vtpassServiceId: null, cheapdatahubValidatePlanId: null, active: true });
  });

  it('presents a cable plan with an injected providerId', () => {
    expect(seg('cable-plans').present(
      { docid: 'p1', CableplanName: 'GOtv Max', amount: 4150, CableplanID: 2, category: 'gotv', active: true },
      { providerId: 'c1' }
    )).toEqual({ id: 'p1', name: 'GOtv Max', price: 4150, planCode: 2, providerId: 'c1', vtpassCode: null, cheapdatahubPlanId: null, active: true });
  });

  it('maps a cable plan back, taking category from a resolved provider name', () => {
    expect(seg('cable-plans').toStored(
      { name: 'GOtv Max', price: 4150, planCode: '2', providerId: 'c1', active: true },
      { providerName: 'GOTV' }
    )).toEqual({ CableplanName: 'GOtv Max', amount: 4150, CableplanID: 2, category: 'gotv', vtpassCode: null, cheapdatahubPlanId: null, active: true });
  });
});

describe('epins and electricity', () => {
  it('presents epin amount as unitPrice', () => {
    expect(seg('epins').present({ docid: 'e1', examName: 'WAEC', amount: 2500, img: 'w.png', active: true }))
      .toEqual({ id: 'e1', name: 'WAEC', unitPrice: 2500, logo: 'w.png', vtpassServiceId: null, cheapdatahubProductId: null, active: true });
  });

  it('presents Disconame as name and DiscoID as discoId', () => {
    expect(seg('electricity').present({ docid: 'x1', Disconame: 'Ikeja Electric', img: 'i.png', DiscoID: 1, active: true }))
      .toEqual({ id: 'x1', name: 'Ikeja Electric', logo: 'i.png', discoId: 1, vtpassServiceId: null, cheapdatahubDiscoId: null, active: true });
  });
});

describe('required provider-side ids', () => {
  // husmodata's numeric id is no longer unconditionally required -- a row
  // imported from VTpass cannot supply it. Each collection instead offers it
  // as one alternative in requiresOneOf, so at least one provider's
  // identifier is still mandatory.
  it('every collection that needs a provider id offers it as an identifier alternative', () => {
    expect(seg('networks').requiresOneOf).toContainEqual(['networkId']);
    expect(seg('data-plans').requiresOneOf).toContainEqual(['dataId']);
    expect(seg('cables').requiresOneOf).toContainEqual(['cableId']);
    expect(seg('cable-plans').requiresOneOf).toContainEqual(['planCode']);
    expect(seg('electricity').requiresOneOf).toContainEqual(['discoId']);
  });
});

// Fix round 1: Number() silently turns a garbage string into NaN, which is
// valid BSON and would write into MongoDB with no error anywhere. A numeric
// field must fail loudly instead of storing NaN or a null that produces an
// unsellable-but-plausible-looking row.
describe('numeric field validation on write', () => {
  it('throws VALIDATION_FAILED for a non-numeric provider-side id', () => {
    expect(() => seg('networks').toStored({ name: 'Mtn', logo: 'i.png', networkId: 'abc', active: true }))
      .toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));

    expect(() => seg('data-plans').toStored({
      network: 'MTN', type: 'SME', size: '1.0 GB', validity: '30 days',
      amount: 280, dataId: 'abc', active: true,
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));

    expect(() => seg('cables').toStored({ name: 'GOTV', logo: 'g.png', cableId: 'abc', active: true }))
      .toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));

    expect(() => seg('cable-plans').toStored(
      { name: 'GOtv Max', price: 4150, planCode: 'abc', providerId: 'c1', active: true },
      { providerName: 'GOTV' }
    )).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));

    expect(() => seg('electricity').toStored({ name: 'Ikeja Electric', logo: 'i.png', discoId: 'abc', active: true }))
      .toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('throws VALIDATION_FAILED for a non-numeric commissionRate', () => {
    expect(() => seg('atc').toStored({
      network: 'MTN', payoutNumber: '08000000000', commissionRate: 'abc', active: true,
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('throws VALIDATION_FAILED for a non-numeric amount', () => {
    expect(() => seg('data-plans').toStored({
      network: 'MTN', type: 'SME', size: '1.0 GB', validity: '30 days',
      amount: 'abc', dataId: 7, active: true,
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('still maps an empty string to null, unchanged from before the fix', () => {
    expect(seg('networks').toStored({ name: 'Mtn', logo: 'i.png', networkId: '', active: true }))
      .toEqual({ name: 'Mtn', img: 'i.png', id: null, vtpassDataServiceId: null, vtpassAirtimeServiceId: null, cheapdatahubNetworkId: null, active: true });
  });

  it('still converts a valid numeric string to a number, unchanged from before the fix', () => {
    expect(seg('cables').toStored({ name: 'GOTV', logo: 'g.png', cableId: '7', active: true }))
      .toEqual({ CableName: 'GOTV', img: 'g.png', CableID: 7, vtpassServiceId: null, cheapdatahubValidatePlanId: null, active: true });
  });
});

describe('VTpass identifiers', () => {
  it('round-trips VTpass identifiers without making them required', () => {
    const net = ADMIN_COLLECTIONS.networks;
    const presented = net.present({
      name: 'MTN', id: 1, vtpassDataServiceId: 'mtn-data', vtpassAirtimeServiceId: 'mtn',
    });
    expect(presented.vtpassDataServiceId).toBe('mtn-data');
    expect(presented.vtpassAirtimeServiceId).toBe('mtn');
    expect(net.toStored(presented).vtpassDataServiceId).toBe('mtn-data');
    // Optional: a row with no VTpass ids is still valid while husmodata serves it.
    expect(net.required).not.toContain('vtpassDataServiceId');
    expect(net.toStored({ name: 'MTN', networkId: 1 }).vtpassDataServiceId).toBe(null);
  });

  it('round-trips the VTpass plan code on data plans and cable plans', () => {
    const dp = ADMIN_COLLECTIONS['data-plans'];
    expect(dp.present({ Network: 'MTN', vtpassCode: 'mtn-10gb' }).vtpassCode).toBe('mtn-10gb');
    expect(dp.toStored({ network: 'MTN', amount: 100, dataId: 7, vtpassCode: 'mtn-10gb' }).vtpassCode)
      .toBe('mtn-10gb');
    expect(dp.required).not.toContain('vtpassCode');

    const cp = ADMIN_COLLECTIONS['cable-plans'];
    expect(cp.present({ CableplanName: 'Padi', vtpassCode: 'dstv-padi' }).vtpassCode).toBe('dstv-padi');
    expect(cp.toStored({ name: 'Padi', price: 3500, planCode: '1', providerId: 'c1', vtpassCode: 'dstv-padi', active: true }, { providerName: 'DSTV' }).vtpassCode)
      .toBe('dstv-padi');
    expect(cp.required).not.toContain('vtpassCode');
  });

  it('round-trips a VTpass service id on cables, electricity and epins', () => {
    const cables = ADMIN_COLLECTIONS.cables;
    expect(cables.present({ vtpassServiceId: 'dstv' }).vtpassServiceId).toBe('dstv');
    expect(cables.toStored({ name: 'DStv', cableId: 2, vtpassServiceId: 'dstv', active: true }).vtpassServiceId)
      .toBe('dstv');
    expect(cables.required).not.toContain('vtpassServiceId');

    const electricity = ADMIN_COLLECTIONS.electricity;
    expect(electricity.present({ vtpassServiceId: 'ikeja' }).vtpassServiceId).toBe('ikeja');
    expect(electricity.toStored({ name: 'Ikeja Electric', discoId: 1, vtpassServiceId: 'ikeja', active: true }).vtpassServiceId)
      .toBe('ikeja');
    expect(electricity.required).not.toContain('vtpassServiceId');

    const epins = ADMIN_COLLECTIONS.epins;
    expect(epins.present({ vtpassServiceId: 'waec' }).vtpassServiceId).toBe('waec');
    expect(epins.toStored({ name: 'WAEC', unitPrice: 2500, vtpassServiceId: 'waec', active: true }).vtpassServiceId)
      .toBe('waec');
    expect(epins.required).not.toContain('vtpassServiceId');
  });
});

// Fix round 2: num() previously accepted any finite number, so a negative
// amount, a zero price or a zero provider id all saved with a clean 200/201
// and only failed later, at a customer's purchase, as "misconfigured". These
// bounds move that failure to the operator's save.
describe('numeric lower-bound validation on write', () => {
  it('rejects a negative price on a cable plan', () => {
    expect(() => seg('cable-plans').toStored(
      { name: 'GOtv Max', price: -500, planCode: '2', providerId: 'c1', active: true },
      { providerName: 'GOTV' }
    )).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('rejects a zero provider id', () => {
    expect(() => seg('cables').toStored({ name: 'GOTV', logo: 'g.png', cableId: 0, active: true }))
      .toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));

    expect(() => seg('networks').toStored({ name: 'Mtn', logo: 'i.png', networkId: 0, active: true }))
      .toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('rejects a zero or negative data-plan amount', () => {
    expect(() => seg('data-plans').toStored({
      network: 'MTN', type: 'SME', size: '1.0 GB', validity: '30 days',
      amount: 0, dataId: 7, active: true,
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));

    expect(() => seg('data-plans').toStored({
      network: 'MTN', type: 'SME', size: '1.0 GB', validity: '30 days',
      amount: -280, dataId: 7, active: true,
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('rejects a commissionRate of 5 (i.e. 500%)', () => {
    expect(() => seg('atc').toStored({
      network: 'MTN', payoutNumber: '08000000000', commissionRate: 5, active: true,
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('still saves a valid row unchanged — the new bounds are not over-tight', () => {
    expect(seg('cable-plans').toStored(
      { name: 'GOtv Max', price: 4150, planCode: '2', providerId: 'c1', active: true },
      { providerName: 'GOTV' }
    )).toEqual({ CableplanName: 'GOtv Max', amount: 4150, CableplanID: 2, category: 'gotv', vtpassCode: null, cheapdatahubPlanId: null, active: true });

    expect(seg('networks').toStored({ name: 'Mtn', logo: 'i.png', networkId: '1', active: true }))
      .toEqual({ name: 'Mtn', img: 'i.png', id: 1, vtpassDataServiceId: null, vtpassAirtimeServiceId: null, cheapdatahubNetworkId: null, active: true });

    expect(seg('atc').toStored({ network: 'MTN', payoutNumber: '08000000000', commissionRate: 0.1, active: true }))
      .toEqual({ network: 'MTN', number: '08000000000', percent: 10, active: true });

    expect(seg('data-plans').toStored({
      network: 'MTN', type: 'SME', size: '1.0 GB', validity: '30 days',
      amount: 280, dataId: '7', active: true,
    })).toEqual({
      Network: 'MTN', planType: 'SME', Size: '1.0 GB',
      Validity: '30 days', Amount: '₦280.0', dataId: 7, vtpassCode: null, cheapdatahubBundleId: null, active: true,
    });
  });
});

describe('provider-rates', () => {
  it('presents a stored rate row', () => {
    expect(
      seg('provider-rates').present({
        docid: 'r1', provider: 'vtpass', serviceLabel: 'MTN Airtime VTU',
        matchesTransType: 'airtime', expectedRate: 3, cappedAt: null, active: true,
      })
    ).toEqual({
      id: 'r1', provider: 'vtpass', serviceLabel: 'MTN Airtime VTU',
      matchesTransType: 'airtime', expectedRate: 3, cappedAt: null, active: true,
    });
  });

  it('stores expectedRate as a percentage, not a fraction', () => {
    const stored = seg('provider-rates').toStored({
      provider: 'vtpass', serviceLabel: 'MTN Airtime VTU',
      matchesTransType: 'airtime', expectedRate: 3, active: true,
    });
    expect(stored.expectedRate).toBe(3);
    expect(stored.cappedAt).toBeNull();
  });

  // Stated as a requirement in the spec. This system already has a `percent`
  // field meaning the commission WITHHELD FROM A CUSTOMER, and an inverted
  // reading of it would have paid every ATC customer nothing. The rate here is
  // the opposite direction -- what a provider pays US. The two must never
  // share a name, and this test is the guard.
  it('never writes a field named percent', () => {
    const stored = seg('provider-rates').toStored({
      provider: 'vtpass', serviceLabel: 'MTN Airtime VTU',
      matchesTransType: 'airtime', expectedRate: 3, active: true,
    });
    expect(Object.keys(stored)).not.toContain('percent');
    expect(Object.keys(seg('provider-rates').present({ docid: 'r1' }))).not.toContain('percent');
  });

  it("leaves the ATC collection's own percent untouched", () => {
    const atc = seg('atc').toStored({
      network: 'MTN', payoutNumber: '08000000000', commissionRate: 0.1, active: true,
    });
    expect(atc.percent).toBe(10);
  });

  it('rejects an unknown provider', () => {
    expect(() =>
      seg('provider-rates').toStored({
        provider: 'nobody', serviceLabel: 'x', matchesTransType: 'airtime', expectedRate: 3,
      })
    ).toThrow(/provider/i);
  });

  it('rejects a rate outside 0-100', () => {
    const base = { provider: 'vtpass', serviceLabel: 'x', matchesTransType: 'airtime' };
    expect(() => seg('provider-rates').toStored({ ...base, expectedRate: -1 })).toThrow();
    expect(() => seg('provider-rates').toStored({ ...base, expectedRate: 100 })).toThrow();
    expect(() => seg('provider-rates').toStored({ ...base, expectedRate: 'abc' })).toThrow();
  });

  it('accepts an optional naira cap and stores null when absent', () => {
    const base = {
      provider: 'vtpass', serviceLabel: 'x', matchesTransType: 'data', expectedRate: 5,
    };
    expect(seg('provider-rates').toStored({ ...base, cappedAt: 100 }).cappedAt).toBe(100);
    expect(seg('provider-rates').toStored({ ...base, cappedAt: '' }).cappedAt).toBeNull();
  });
});

// The presenter cannot import providers/index.js without pulling settings and
// mongo into a pure mapping module, so it carries its own copy of the provider
// names. This is the guard against the two drifting apart.
describe('provider name list', () => {
  it('matches the adapters the provider registry actually offers', () => {
    const providers = require('../../src/providers');
    const { PROVIDER_NAMES } = require('../../src/presenters/admin');
    expect([...PROVIDER_NAMES].sort()).toEqual([...providers.available].sort());
  });
});
