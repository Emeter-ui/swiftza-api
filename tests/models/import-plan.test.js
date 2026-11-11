import { describe, it, expect } from 'vitest';
const { priceFrom, parseVariation, proposeAction } = require('../../src/models/import-plan');
const variations = require('../fixtures/vtpass/service-variations-mtn-data.json');

const wire = variations.content.variations ?? variations.content.varations;

describe('priceFrom', () => {
  it('adds the markup', () => {
    expect(priceFrom(1000, 15, 0)).toBe(1150);
  });

  // The whole reason rounding is ceiling and not nearest. 333 at 15% is
  // 382.95; nearest-10 gives 380, BELOW the intended margin, on roughly half
  // of all rows, invisibly. This test is the guard against someone "tidying"
  // it to Math.round.
  it('rounds UP to the step, never down below cost plus markup', () => {
    const exact = 333 * 1.15;          // 382.95
    const priced = priceFrom(333, 15, 10);
    expect(priced).toBe(390);
    expect(priced).toBeGreaterThanOrEqual(exact);
  });

  // Final review C2. This test used to expect 382.95, and that expectation was
  // wrong. The money layer is whole naira -- data-plan amounts are stored
  // through Math.round, cable-plan and exam-pin prices are Math.round-ed when
  // charged -- so a kobo price lands on the nearest naira, BELOW cost plus
  // markup whenever the kobo are under 50. A zero step means no step: still a
  // whole naira, still rounded up.
  it('treats a zero step as a whole naira, rounded up', () => {
    expect(priceFrom(333, 15, 0)).toBe(383);
  });

  // Float noise must not be ceilinged into a real naira. The captured
  // mtn-10mb-100 costs ₦100, and 100 * 1.1 is 110.00000000000001 in floating
  // point -- which a bare ceiling prices at ₦111, or ₦120 at a step of 10.
  it('does not let float noise add a naira or a step to an exact price', () => {
    const cost = Number(wire.find((x) => x.variation_code === 'mtn-10mb-100').variation_amount);
    expect(priceFrom(cost, 10, 0)).toBe(110);
    expect(priceFrom(cost, 10, 10)).toBe(110);
  });

  it('never returns a fractional price, even for a fractional step', () => {
    const priced = priceFrom(333, 15, 0.3);
    expect(Number.isInteger(priced)).toBe(true);
    expect(priced).toBeGreaterThanOrEqual(333 * 1.15);
  });

  it('returns null rather than a number for unusable input', () => {
    expect(priceFrom(0, 15, 10)).toBeNull();
    expect(priceFrom('abc', 15, 10)).toBeNull();
    expect(priceFrom(1000, -5, 10)).toBeNull();
    // Finite inputs whose product is not: Infinity is not a price.
    expect(priceFrom(Number.MAX_VALUE, 100, 10)).toBeNull();
  });

  // A zero markup is a real operator input, not an error -- it must price at
  // cost so the preview can flag it as no-margin rather than silently reject.
  it('prices at cost for a zero markup', () => {
    expect(priceFrom(1000, 0, 0)).toBe(1000);
  });
});

describe('parseVariation', () => {
  // The trap, taken straight off the wire: this variation's CODE says 10mb and
  // its NAME says 100MB. An implementation that parses the code fails here.
  it('reads the size from the name, not the code', () => {
    const v = wire.find((x) => x.variation_code === 'mtn-10mb-100');
    expect(v.variation_code).toContain('10mb');
    expect(parseVariation(v, 'mtn-data').size).toBe('100MB');
  });

  it('reads the validity from the name', () => {
    const v = wire.find((x) => x.variation_code === 'mtn-10mb-100');
    expect(parseVariation(v, 'mtn-data').validity).toBe('24 hrs');
  });

  it('maps the network from the service id, not the name', () => {
    expect(parseVariation({ name: 'N100 100MB - 24 hrs' }, 'glo-data').network).toBe('GLO');
    expect(parseVariation({ name: 'N100 100MB - 24 hrs' }, 'etisalat-data').network).toBe('9mobile');
  });

  it('parses every variation in the real payload without throwing', () => {
    for (const v of wire) expect(() => parseVariation(v, 'mtn-data')).not.toThrow();
  });

  // A blank the operator fills beats a wrong value they do not notice.
  it('returns null for a field it cannot parse', () => {
    const out = parseVariation({ name: 'Some Bundle' }, 'mtn-data');
    expect(out.size).toBeNull();
    expect(out.validity).toBeNull();
  });

  it('returns a null network for an unmapped service', () => {
    expect(parseVariation({ name: 'x' }, 'nonsense').network).toBeNull();
  });

  // A hyphen inside a compound word ("2-Month Plan") is not a validity
  // delimiter. Treating it as one fabricates a plausible-looking wrong value
  // ("Month Plan") instead of leaving the field null for the operator to fill.
  it('returns null for a hyphen inside a word rather than guessing a validity', () => {
    const compound = wire.find((v) => /\d-Month/i.test(v.name));
    expect(compound).toBeDefined();
    expect(parseVariation(compound, 'mtn-data').validity).toBeNull();
  });

  it('still parses a genuine " - " separator', () => {
    const v = wire.find((x) => x.variation_code === 'mtn-10mb-100');
    expect(parseVariation(v, 'mtn-data').validity).toBe('24 hrs');
  });
});

// Mirrors the shape ADMIN_COLLECTIONS['data-plans'].present() returns, because
// that is what the route feeds in -- presented rows, so field names are the
// friendly ones and matching does not need to know storage columns.
const dataTarget = {
  codeField: 'vtpassCode',
  matchOn: ['network', 'size'],
  exactOn: ['validity'],
  label: (r) => `${r.network} ${r.size}`,
};

const row = (over) => ({
  id: 'r1', network: 'MTN', size: '1GB', validity: '30 days',
  amount: 280, dataId: 7, vtpassCode: null, active: true, ...over,
});

describe('proposeAction', () => {
  it('creates when nothing matches', () => {
    const out = proposeAction({ network: 'GLO', size: '2GB', validity: '30 days' }, 'glo-x', [row()], dataTarget);
    expect(out.action).toBe('create');
    expect(out.match).toBeNull();
  });

  it('attaches to a single match and calls it likely when validity agrees', () => {
    const out = proposeAction({ network: 'MTN', size: '1GB', validity: '30 days' }, 'mtn-1gb', [row()], dataTarget);
    expect(out.action).toBe('attach');
    expect(out.match.id).toBe('r1');
    expect(out.match.confidence).toBe('likely');
  });

  it('calls it possible when validity differs', () => {
    const out = proposeAction({ network: 'MTN', size: '1GB', validity: '7 days' }, 'mtn-1gb', [row()], dataTarget);
    expect(out.action).toBe('attach');
    expect(out.match.confidence).toBe('possible');
  });

  // Attaching to the wrong row sells the customer the plan next to the one
  // they picked. When the feature cannot tell, it must not guess.
  it('refuses to attach when more than one row matches', () => {
    const rows = [row(), row({ id: 'r2', validity: '7 days' })];
    const out = proposeAction({ network: 'MTN', size: '1GB', validity: '30 days' }, 'mtn-1gb', rows, dataTarget);
    expect(out.ambiguous).toBe(true);
    expect(out.action).toBe('create');
  });

  // A row that already carries a code either IS this variation or belongs to a
  // different one; overwriting would repoint a live plan at the wrong product.
  it('never treats a row that already has a code as a candidate', () => {
    const rows = [row({ vtpassCode: 'mtn-something-else' })];
    const out = proposeAction({ network: 'MTN', size: '1GB', validity: '30 days' }, 'mtn-1gb', rows, dataTarget);
    expect(out.action).toBe('create');
    expect(out.match).toBeNull();
  });

  it('reports a row already carrying this exact code as already imported', () => {
    const rows = [row({ vtpassCode: 'mtn-1gb' })];
    const out = proposeAction({ network: 'MTN', size: '1GB', validity: '30 days' }, 'mtn-1gb', rows, dataTarget);
    expect(out.alreadyImported).toBe(true);
  });

  it('does not match on a field the parse could not fill', () => {
    const out = proposeAction({ network: 'MTN', size: null, validity: null }, 'mtn-x', [row()], dataTarget);
    expect(out.action).toBe('create');
  });

  it('normalises spacing and case when comparing', () => {
    const rows = [row({ size: '1 gb' })];
    const out = proposeAction({ network: 'mtn', size: '1GB', validity: '30 days' }, 'mtn-1gb', rows, dataTarget);
    expect(out.action).toBe('attach');
  });

  it('does not call a match likely when the exact-match field is blank on both sides', () => {
    const rows = [row({ validity: null })];
    const out = proposeAction({ network: 'MTN', size: '1GB', validity: null }, 'mtn-1gb', rows, dataTarget);
    expect(out.action).toBe('attach');
    expect(out.match.confidence).toBe('possible');
  });
});
