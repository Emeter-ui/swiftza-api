import { describe, it, expect } from 'vitest';

const P = require('../../src/presenters');
const { purchaseReference, paystackReference } = require('../../src/models/reference');
const { TRANSREF_PATTERN } = require('../../src/models/purchase');

describe('presenters', () => {
  it('converts a Firestore-shaped timestamp to ISO', () => {
    expect(P.toIso({ seconds: 1788249600, nanoseconds: 500000000 }))
      .toBe('2026-09-01T08:00:00.500Z');
  });

  it('passes a Date and a string through toIso', () => {
    expect(P.toIso(new Date(1788249600000))).toBe('2026-09-01T08:00:00.000Z');
    expect(P.toIso('2026-09-01T08:00:00.000Z')).toBe('2026-09-01T08:00:00.000Z');
    expect(P.toIso(null)).toBeNull();
  });

  it('maps a data plan and parses the display price to a number', () => {
    expect(P.dataPlan({
      docid: 'a1', Network: 'MTN', planType: 'SME', Size: '1.0 GB',
      Validity: '30 days', Amount: '₦280.0', active: true,
    })).toEqual({
      id: 'a1', network: 'MTN', type: 'SME', size: '1.0 GB',
      validity: '30 days', amount: 280, active: true,
    });
  });

  it('maps an exam type to unitPrice, which is what resultchecker.vue reads', () => {
    expect(P.examType({ docid: 'e1', examName: 'WAEC', amount: 2500, img: 'i', active: true }))
      .toEqual({ id: 'e1', name: 'WAEC', unitPrice: 2500, image: 'i', active: true });
  });

  it('maps an ATC network to a commissionRate FRACTION and payoutNumber', () => {
    // airtime-to-cash.vue computes `1 - network.commissionRate`, so 10 percent
    // must arrive as 0.1, not 10.
    expect(P.atcNetwork({ docid: 'n1', network: 'MTN', number: '08000000000', percent: 10, active: true }))
      .toEqual({ id: 'n1', network: 'MTN', payoutNumber: '08000000000', commissionRate: 0.1, active: true });
  });

  it('maps a cable provider and a cable plan with an injected providerId', () => {
    expect(P.cableProvider({ docid: 'c1', CableName: 'GOTV', img: 'i', active: true }))
      .toEqual({ id: 'c1', name: 'GOTV', image: 'i', active: true });
    // buy-cable.vue reads `plan.price` (four sites, including its
    // wallet-balance guard), not `plan.amount` — an exact toEqual here fails
    // if the key ever reverts to `amount`.
    expect(P.cablePlan({ docid: 'p1', CableplanName: 'GOtv Max', amount: 4150, active: true }, 'c1'))
      .toEqual({ id: 'p1', providerId: 'c1', name: 'GOtv Max', price: 4150, active: true });
    expect(P.cablePlan({ docid: 'p1', CableplanName: 'X', amount: 1 }, null).providerId).toBeNull();
  });

  it('maps a disco', () => {
    expect(P.disco({ docid: 'd1', Disconame: 'Ikeja Electric', img: 'i', active: true }))
      .toEqual({ id: 'd1', name: 'Ikeja Electric', image: 'i', active: true });
  });

  it('maps a transaction with an ISO createdAt', () => {
    const out = P.transaction({
      docid: 'T1', transType: 'Data', amount: 280, status: 'success',
      message: 'ok', transref: 'T1', CreatedAt: { seconds: 1788249600, nanoseconds: 0 },
    });
    expect(out).toEqual({
      id: 'T1', type: 'Data', kind: 'data', label: 'Data', amount: 280, status: 'success',
      message: 'ok', reference: 'T1', createdAt: '2026-09-01T08:00:00.000Z',
    });
  });

  it('strips the -Reversed / -Pending suffix from kind so it matches transactions.vue\'s tab values', () => {
    // transactions.vue's tabs are 'airtime' | 'data' | 'cable' | 'electricity'
    // | 'epin' | 'wallet' — models/purchase.js writes transType as
    // 'Data-Reversed' and 'Data-Pending' for the failure/pending cases, so a
    // raw passthrough would never match the 'data' tab.
    expect(P.transaction({ docid: 'T2', transType: 'Data-Reversed' }).kind).toBe('data');
    expect(P.transaction({ docid: 'T3', transType: 'Data-Pending' }).kind).toBe('data');
    expect(P.transaction({ docid: 'T4', transType: 'Epin' }).kind).toBe('epin');
    expect(P.transaction({ docid: 'T5', transType: null }).kind).toBeNull();
  });

  it('maps a wallet entry', () => {
    expect(P.walletEntry({
      docid: 'W1', mode: 'debit', amount: 280, prevBal: 500, newBal: 220,
      status: 'success', channel: 'Data', CreatedAt: { seconds: 1788249600, nanoseconds: 0 },
    })).toEqual({
      id: 'W1', mode: 'debit', type: 'debit', reversed: false, amount: 280, prevBal: 500, newBal: 220,
      status: 'success', channel: 'Data', createdAt: '2026-09-01T08:00:00.000Z',
    });
  });

  it('emits `type` alongside `mode` so wallet-summary.vue\'s isCredit check works, and flags reversed rows', () => {
    // wallet-summary.vue computes isCredit = entry.type === 'credit' ||
    // entry.amount > 0, and filters entries on `!entry.reversed`.
    expect(P.walletEntry({ docid: 'W2', mode: 'credit', amount: 500, status: 'success' }))
      .toMatchObject({ mode: 'credit', type: 'credit', reversed: false });
    // type is derived from CREDIT_MODES, not passed through raw, so a
    // credit-reversal (money moving back in) reports type 'credit'.
    expect(P.walletEntry({ docid: 'W3', mode: 'credit-reversal', amount: 280, status: 'reversed' }))
      .toMatchObject({ mode: 'credit-reversal', type: 'credit', reversed: true });
  });

  it('derives an admin credit as a credit and an admin debit as a debit', () => {
    expect(P.walletEntry({ mode: 'admin-credit', amount: 500 }).type).toBe('credit');
    expect(P.walletEntry({ mode: 'admin-debit', amount: 500 }).type).toBe('debit');
    // the raw mode is still available for anything that needs the distinction
    expect(P.walletEntry({ mode: 'admin-credit' }).mode).toBe('admin-credit');
  });

  it('presents an atc credit as a credit, not a debit', () => {
    // The regression this guards: a new mode added without extending CREDIT_MODES
    // once rendered a customer's credit as a red debit while their balance rose.
    expect(P.walletEntry({ mode: 'atc-credit', amount: 4000 }).type).toBe('credit');
  });

  it('maps a user to wallet/role and never leaks secrets', () => {
    const out = P.user({
      docid: 'u1', username: 'sam', fullname: 'Sam U', email: 'u@x.com', phone: '0800',
      balance: 500, account: 'ADMIN', bankName: 'GTB', accountName: 'S U', accountNumber: '012',
      passwd: 'leak', paystacksecretkey: 'sk_leak',
    });
    expect(out.wallet).toBe(500);
    expect(out.role).toBe('ADMIN');
    expect(out.id).toBe('u1');
    expect(out.passwd).toBeUndefined();
    expect(out.paystacksecretkey).toBeUndefined();
  });
});

describe('reference generation', () => {
  it('namespaces purchase references and satisfies TRANSREF_PATTERN', () => {
    const ref = purchaseReference();
    expect(ref.startsWith('pur_')).toBe(true);
    expect(TRANSREF_PATTERN.test(ref)).toBe(true);
  });

  it('generates distinct references', () => {
    const set = new Set(Array.from({ length: 200 }, () => purchaseReference()));
    expect(set.size).toBe(200);
  });

  it('namespaces paystack references so they cannot collide with purchases', () => {
    // This is what closes the silent-dropped-payment bug: a Paystack reference
    // can no longer equal a settled purchase reference.
    expect(paystackReference('T123456')).toBe('ps_T123456');
    expect(paystackReference('abc/def')).toBe('ps_abc-def');
    expect(TRANSREF_PATTERN.test(paystackReference('T123456'))).toBe(true);
  });

  it('replaces invalid characters rather than stripping them, so distinct inputs stay distinct', () => {
    // Stripping instead of replacing would map 'abc.def' and 'abcdef' to the
    // same key. That key is the MongoDB _id used for payment idempotency, so
    // a collision would silently drop a real payment.
    expect(paystackReference('abc.def')).not.toBe(paystackReference('abcdef'));
  });
});
