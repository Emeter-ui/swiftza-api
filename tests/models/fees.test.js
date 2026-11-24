import { describe, it, expect } from 'vitest';
const fees = require('../../src/models/fees');

const rule = (over = {}) => fees.normalizeRule({ name: 'R', minAmount: 100, maxAmount: null, mode: 'on_top', ...over }).rule;
const cfg = (rules, settings = {}) => ({ settings: { ...fees.DEFAULT_SETTINGS, ...settings }, rules });
const codes = (list) => list.map((x) => x.code);

describe('fee quote', () => {
  it('adds the fee on top: customer pays more, wallet gets the amount', () => {
    const q = fees.quote(cfg([rule({ flatFee: 50, percentFee: 1 })]), { amount: 1000 });
    expect(q).toMatchObject({ fee: 60, tax: 0, charge: 1060, credit: 1000, mode: 'on_top' });
  });

  it('deducts the fee: customer pays the amount, wallet gets less', () => {
    const q = fees.quote(cfg([rule({ mode: 'deducted', percentFee: 2 })]), { amount: 5000 });
    expect(q).toMatchObject({ fee: 100, charge: 5000, credit: 4900 });
  });

  it('applies min fee, cap and VAT on the fee', () => {
    const r = rule({ percentFee: 1.5, minFee: 50, capAmount: 2000, taxRate: 7.5 });
    expect(fees.quote(cfg([r]), { amount: 1000 })).toMatchObject({ fee: 50, tax: 3.75, floored: true });
    expect(fees.quote(cfg([r]), { amount: 500000 })).toMatchObject({ fee: 2000, tax: 150, capped: true, charge: 502150 });
  });

  it('taxes the amount when the tax base is amount', () => {
    const q = fees.quote(cfg([rule({ flatFee: 10, taxRate: 1, taxBase: 'amount' })]), { amount: 1000 });
    expect(q).toMatchObject({ fee: 10, tax: 10, charge: 1020 });
  });

  it('grosses up so the processor percentage is fully covered', () => {
    const q = fees.quote(cfg([rule({ flatFee: 100, percentFee: 1.5, grossUp: true })]), { amount: 10000 });
    // processor keeps 100 + 1.5% of the charge; what is left must be >= 10000
    const kept = 100 + q.charge * 0.015;
    expect(q.charge - kept).toBeGreaterThanOrEqual(10000);
    expect(q.charge - kept).toBeLessThan(10000.05);
    expect(q.credit).toBe(10000);
  });

  it('prefers a method-specific rule over an "any" rule', () => {
    const c = cfg([rule({ name: 'any', flatFee: 10 }), rule({ name: 'transfer', method: 'transfer', flatFee: 0, percentFee: 0.5 })]);
    expect(fees.quote(c, { amount: 1000, method: 'transfer' }).ruleName).toBe('transfer');
    expect(fees.quote(c, { amount: 1000, method: 'card' }).ruleName).toBe('any');
  });

  it('enforces deposit limits and whole-naira amounts with readable errors', () => {
    const c = cfg([], { minDeposit: 100, maxDeposit: 50000 });
    expect(() => fees.quote(c, { amount: 50 })).toThrow(/minimum you can add is ₦100/);
    expect(() => fees.quote(c, { amount: 60000 })).toThrow(/maximum/);
    expect(() => fees.quote(c, { amount: 100.5 })).toThrow(/whole naira/);
    expect(() => fees.quote(c, { amount: 'abc' })).toThrow(/Enter an amount/);
  });

  it('refuses a deducted fee that would consume the deposit', () => {
    expect(() => fees.quote(cfg([rule({ mode: 'deducted', flatFee: 200 })]), { amount: 150 })).toThrow(/more than the amount/);
  });

  it('uses the unmatched policy outside every range', () => {
    const r = rule({ minAmount: 1000, maxAmount: 5000, flatFee: 50 });
    expect(fees.quote(cfg([r]), { amount: 500 }).totalFee).toBe(0);
    expect(() => fees.quote(cfg([r], { unmatchedPolicy: 'reject' }), { amount: 500 })).toThrow(/not available/);
  });

  it('charges nothing when fees are disabled', () => {
    expect(fees.quote(cfg([rule({ flatFee: 50 })], { enabled: false }), { amount: 1000 }).charge).toBe(1000);
  });
});

describe('fee analysis', () => {
  it('detects overlapping ranges for the same method', () => {
    const r = fees.analyse(cfg([rule({ name: 'A', minAmount: 100, maxAmount: 5000 }), rule({ name: 'B', minAmount: 5000, maxAmount: 10000 })]));
    expect(r.ok).toBe(false);
    expect(codes(r.errors)).toContain('RANGE_OVERLAP');
    expect(r.errors.find((e) => e.code === 'RANGE_OVERLAP')).toMatchObject({ from: 5000, to: 5000 });
  });

  it('treats an open-ended rule as overlapping everything above it', () => {
    const r = fees.analyse(cfg([rule({ name: 'A', minAmount: 100, maxAmount: null }), rule({ name: 'B', minAmount: 900000, maxAmount: 950000 })]));
    expect(codes(r.errors)).toContain('RANGE_OVERLAP');
  });

  it('does not treat "any" vs a specific method as a clash, but reports the shadowing', () => {
    const r = fees.analyse(cfg([rule({ name: 'A' }), rule({ name: 'B', method: 'card' })]));
    expect(codes(r.errors)).not.toContain('RANGE_OVERLAP');
    expect(codes(r.warnings)).toContain('RANGE_SHADOWED');
  });

  it('ignores inactive rules when checking for clashes', () => {
    const r = fees.analyse(cfg([rule({ name: 'A' }), rule({ name: 'B', active: false })]));
    expect(codes(r.errors)).not.toContain('RANGE_OVERLAP');
  });

  it('reports gaps between ranges, as errors when unmatched deposits are refused', () => {
    const rules = [rule({ name: 'A', minAmount: 100, maxAmount: 5000, flatFee: 10 }), rule({ name: 'B', minAmount: 6000, maxAmount: null, flatFee: 10 })];
    const soft = fees.analyse(cfg(rules));
    expect(soft.warnings.find((w) => w.code === 'RANGE_GAP')).toMatchObject({ from: 5001, to: 5999 });
    expect(codes(fees.analyse(cfg(rules, { unmatchedPolicy: 'reject' })).errors)).toContain('RANGE_GAP');
  });

  it('flags deducted fees that swallow the smallest deposit', () => {
    const r = fees.analyse(cfg([rule({ mode: 'deducted', flatFee: 150 })]));
    expect(codes(r.errors)).toContain('FEE_EXCEEDS_AMOUNT');
  });

  it('flags a credit cliff where adding ₦1 more credits less', () => {
    const r = fees.analyse(cfg([
      rule({ name: 'low', mode: 'deducted', minAmount: 100, maxAmount: 2499, flatFee: 0, percentFee: 0 , minFee: 1}),
      rule({ name: 'high', mode: 'deducted', minAmount: 2500, maxAmount: null, flatFee: 100 }),
    ]));
    expect(codes(r.warnings)).toContain('CREDIT_CLIFF');
  });

  it('flags rules outside the deposit limits', () => {
    const r = fees.analyse(cfg([rule({ name: 'big', minAmount: 2000000, maxAmount: 3000000, flatFee: 5 })], { maxDeposit: 1000000 }));
    expect(codes(r.warnings)).toContain('RULE_UNREACHABLE');
  });

  it('collects field errors for invalid rules', () => {
    const r = fees.analyse(cfg([{ name: '', minAmount: 500, maxAmount: 100, percentFee: 120, minFee: 50, capAmount: 10 }]));
    const msgs = r.errors.map((e) => e.message).join(' | ');
    expect(msgs).toMatch(/name/);
    expect(msgs).toMatch(/cannot be lower than the minimum amount/);
    expect(msgs).toMatch(/between 0 and 100/);
    expect(msgs).toMatch(/cap cannot be lower than the minimum fee/);
  });

  it('rejects invalid deposit limits', () => {
    expect(codes(fees.analyse(cfg([], { minDeposit: 5000, maxDeposit: 100 })).errors)).toContain('INVALID_SETTING');
  });

  it('accepts the Paystack preset as a clean configuration', () => {
    const r = fees.analyse(cfg(fees.PRESETS.paystack_local.map((x) => fees.normalizeRule(x).rule)));
    expect(r.errors).toEqual([]);
  });
});

describe('creditForPaid (payment without a quote)', () => {
  it('never credits more than was paid for on-top rules', () => {
    const c = cfg([rule({ flatFee: 50, percentFee: 1 })]);
    const q = fees.quote(c, { amount: 1000 });
    const r = fees.creditForPaid(c, { paidKobo: q.chargeKobo });
    expect(r.creditKobo).toBe(100000);
  });

  it('applies the deducted fee to the paid amount', () => {
    const c = cfg([rule({ mode: 'deducted', percentFee: 2 })]);
    expect(fees.creditForPaid(c, { paidKobo: 500000 }).creditKobo).toBe(490000);
  });

  it('credits the full amount when no fees are configured', () => {
    expect(fees.creditForPaid(cfg([]), { paidKobo: 123400 }).creditKobo).toBe(123400);
  });
});

describe('fee analysis noise control', () => {
  it('reports a cliff once when every method shares the same rules', () => {
    const r = fees.analyse(cfg([
      rule({ name: 'low', mode: 'deducted', minAmount: 100, maxAmount: 2499, minFee: 1 }),
      rule({ name: 'high', mode: 'deducted', minAmount: 2500, maxAmount: null, flatFee: 100 }),
    ]));
    const cliffs = r.warnings.filter((w) => w.code === 'CREDIT_CLIFF');
    expect(cliffs).toHaveLength(1);
    expect(cliffs[0].message).toMatch(/^every method/);
  });

  it('does not call an open-ended rule partly unreachable', () => {
    const r = fees.analyse(cfg([rule({ name: 'open', minAmount: 100, maxAmount: null, flatFee: 10 })]));
    expect(codes(r.warnings)).not.toContain('RULE_PARTLY_UNREACHABLE');
  });

  it('treats the Paystack preset as fully clean', () => {
    const r = fees.analyse(cfg(fees.PRESETS.paystack_local.map((x) => fees.normalizeRule(x).rule)));
    expect(r.warnings).toEqual([]);
  });
});
