// smazeeapis/tests/providers/vtpass-earning.test.js
import { describe, it, expect, vi, afterEach } from 'vitest';
const vtpass = require('../../src/providers/vtpass');
const captured = require('../fixtures/vtpass/airtime-success.json');

const txnOf = (body) => body.content.transactions;

describe('vtpass.extractEarning', () => {
  afterEach(() => vi.restoreAllMocks());

  // Derived from the captured wire body, never from numbers typed here: the
  // expectation is recomputed from the same document the code reads, so a test
  // written from a misunderstanding of the shape cannot certify the same
  // misunderstanding in the code.
  it('derives earning from amount - total_amount on the real captured response', () => {
    const txn = txnOf(captured);
    const expected = Math.round((Number(txn.amount) - Number(txn.total_amount)) * 100) / 100;

    const out = vtpass.extractEarning(txn);

    expect(out.earning).toBe(expected);
    expect(out.amountCharged).toBe(Number(txn.total_amount));
  });

  // The central money fact: VTpass's own commission field disagrees with its
  // own ledger movement. Summing the claimed figure would report earnings the
  // wallet never received, so the two are kept apart and never conflated.
  it('keeps the provider-claimed commission separate from the derived earning', () => {
    const txn = txnOf(captured);
    const out = vtpass.extractEarning(txn);

    expect(out.reportedEarning).toBe(Number(txn.commission));
    // Both are present and independently sourced. If the provider ever agrees
    // with itself they may be equal; they must never be the same expression.
    expect(out.reportedEarning).not.toBeNull();
    expect(out.earning).not.toBeNull();
  });

  it('parses the reported rate, which arrives as a string', () => {
    const txn = txnOf(captured);
    const out = vtpass.extractEarning(txn);
    expect(out.rate).toBe(Number(txn.commission_details.rate));
    expect(typeof out.rate).toBe('number');
  });

  // Absent is not zero. Zero is a real earning rate -- a service that pays
  // nothing -- and storing it for "we were not told" would make a
  // never-reported service indistinguishable from an unprofitable one.
  it('returns null, not zero, for a response with no commission block', () => {
    const out = vtpass.extractEarning({ status: 'delivered', amount: 100 });
    expect(out).not.toBeNull();
    expect(out.earning).toBeNull();
    expect(out.rate).toBeNull();
    expect(out.reportedEarning).toBeNull();
    expect(out.amountCharged).toBeNull();
  });

  it('returns null for a non-numeric commission rather than NaN', () => {
    const out = vtpass.extractEarning({ amount: '', total_amount: 'n/a', commission: 'x' });
    expect(out.earning).toBeNull();
    expect(out.reportedEarning).toBeNull();
  });

  it('returns null when there is no transaction object at all', () => {
    expect(vtpass.extractEarning(null)).toBeNull();
    expect(vtpass.extractEarning('nope')).toBeNull();
  });
});

describe('vtpass attaches earning to results', () => {
  afterEach(() => vi.restoreAllMocks());

  it('attaches earning to a successful buy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(captured), { status: 200 })
    );
    const res = await vtpass.create({}).buyAirtime({
      networkId: 'mtn', phone: '08011111111', amount: 100, transref: 'pur_e1',
    });

    expect(res.status).toBe('success');
    const txn = txnOf(captured);
    expect(res.earning.earning).toBe(
      Math.round((Number(txn.amount) - Number(txn.total_amount)) * 100) / 100
    );
  });

  it('attaches earning to a confirmed requery', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(captured), { status: 200 })
    );
    const res = await vtpass.create({}).requery('202609091200purE1');

    expect(res.status).toBe('success');
    expect(res.earning).not.toBeNull();
    expect(res.earning.amountCharged).toBe(Number(txnOf(captured).total_amount));
  });

  // A failed or pending purchase earned nothing and must not carry a figure
  // that could be summed into a report.
  it('carries a null earning on a pending outcome', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: '099', response_description: 'PROCESSING' }), { status: 200 })
    );
    const res = await vtpass.create({}).buyAirtime({
      networkId: 'mtn', phone: '08011111111', amount: 100, transref: 'pur_e2',
    });
    expect(res.status).toBe('pending');
    expect(res.earning ?? null).toBeNull();
  });
});
