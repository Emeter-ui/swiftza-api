import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
const crypto = require('crypto');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');
const { collection } = require('../../src/services/mongo');
const { finance } = require('../../src/models/finance');

// Mirrors the exact expression the order's own quote is computed with in
// routes/atoc.js and routes/orders.js: percent is the COMMISSION WITHHELD,
// not the payout share. Fixtures are built through this so `reciveAmount`
// can never silently drift from what a real order would have quoted.
const quote = (value, percent) => Math.round(value - (percent / 100) * value);

const order = (over = {}) => {
  const amount = over.amount ?? 5000;
  const percent = over.percent ?? 80;
  return {
    _id: 'atc_1', transref: 'atc_1', uid: 'user-1', channel: 'AirtimeToCash',
    network: 'MTN', atcNumber: '08030000000', percent,
    amount, reciveAmount: quote(amount, percent), status: 'pending', validate: false,
    CreatedAt: new Date(), ...over,
  };
};

describe('ATC order decisions', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await collection('USERS').insertOne({ _id: 'user-1', balance: 1000, account: 'USER' });
    await collection('ATCORDERS').insertOne(order());
  });

  it('credits from the amount that ACTUALLY arrived, not the claim', async () => {
    // Customer claimed 5000 at 80% commission; only 4800 landed. The payout
    // share is 20%, so 4800 pays 960, not the 4000 the claim would have paid.
    const out = await finance.approveAtcOrder({
      orderId: 'atc_1', receivedAmount: 4800, adminUid: 'admin-1', reason: 'confirmed on the payout line',
    });
    expect(out.credited).toBe(960);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1960);

    const row = await collection('ATCORDERS').findOne({ _id: 'atc_1' });
    expect(row.status).toBe('success');
    expect(row.receivedAmount).toBe(4800);
    expect(row.amount).toBe(5000); // the original claim is preserved
  });

  it('credits exactly the order\'s own quoted amount when the full claim arrives', async () => {
    // The invariant that catches a formula regression immediately: when what
    // arrived equals what was claimed, the payout must equal the number the
    // customer was actually promised at order time (reciveAmount, computed
    // by `quote` with the real expression), not any formula re-derived here.
    const row = await collection('ATCORDERS').findOne({ _id: 'atc_1' });
    const out = await finance.approveAtcOrder({
      orderId: 'atc_1', receivedAmount: row.amount, adminUid: 'admin-1', reason: 'ok',
    });
    expect(out.credited).toBe(row.reciveAmount);
  });

  it('rounds the credited amount to the nearest naira', async () => {
    // 15% commission on 15 received: 15 * 0.15 = 2.25, so the payout is
    // 15 - 2.25 = 12.75, a genuine fraction that only rounds (rather than
    // divides evenly) under the corrected formula.
    await collection('ATCORDERS').updateOne(
      { _id: 'atc_1' },
      { $set: { percent: 15 } }
    );
    const out = await finance.approveAtcOrder({
      orderId: 'atc_1', receivedAmount: 15, adminUid: 'admin-1', reason: 'ok',
    });
    expect(out.credited).toBe(13);
  });

  it('writes a wallet row the customer can see, with its own mode', async () => {
    await finance.approveAtcOrder({
      orderId: 'atc_1', receivedAmount: 5000, adminUid: 'admin-1', reason: 'ok',
    });
    const wallet = await collection('WALLETTRANSACTIONS').findOne({ uid: 'user-1' });
    expect(wallet.mode).toBe('atc-credit');
    expect(wallet.status).toBe('success');
    expect(wallet.amount).toBe(1000);
  });

  it('audits the decision', async () => {
    await finance.approveAtcOrder({ orderId: 'atc_1', receivedAmount: 5000, adminUid: 'admin-1', reason: 'ok' });
    const entry = await collection('AUDITLOG').findOne({ action: 'atc.approve' });
    expect(entry).toMatchObject({ adminUid: 'admin-1', targetUid: 'user-1' });
  });

  it('approving twice pays once', async () => {
    const a = await finance.approveAtcOrder({ orderId: 'atc_1', receivedAmount: 5000, adminUid: 'admin-1', reason: 'ok' });
    const b = await finance.approveAtcOrder({ orderId: 'atc_1', receivedAmount: 5000, adminUid: 'admin-1', reason: 'ok' });
    expect(a.changed).toBe(true);
    expect(b.changed).toBe(false);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(2000);
  });

  it('cannot be made to pay twice by a concurrent double-submit', async () => {
    // A true race, not two sequential awaits: both requests start against the
    // same pending row before either commits. Modelled on
    // finance.test.js's reserveFunds/creditWallet concurrency tests.
    const results = await Promise.allSettled([
      finance.approveAtcOrder({ orderId: 'atc_1', receivedAmount: 5000, adminUid: 'admin-1', reason: 'ok' }),
      finance.approveAtcOrder({ orderId: 'atc_1', receivedAmount: 5000, adminUid: 'admin-1', reason: 'ok' }),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const changedCount = results.filter((r) => r.value.changed === true).length;
    expect(changedCount).toBe(1);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(2000);
    expect(await collection('AUDITLOG').countDocuments({ action: 'atc.approve' })).toBe(1);
  });

  it('rejects an order without moving money', async () => {
    const out = await finance.rejectAtcOrder({ orderId: 'atc_1', adminUid: 'admin-1', reason: 'airtime never arrived' });
    expect(out.changed).toBe(true);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1000);
    expect(await collection('WALLETTRANSACTIONS').countDocuments()).toBe(0);
    const row = await collection('ATCORDERS').findOne({ _id: 'atc_1' });
    expect(row.status).toBe('rejected');
    expect(row.rejectionReason).toBe('airtime never arrived');
  });

  it('refuses a received amount of zero or less, and a missing reason', async () => {
    await expect(finance.approveAtcOrder({
      orderId: 'atc_1', receivedAmount: 0, adminUid: 'admin-1', reason: 'ok',
    })).rejects.toThrow(/amount/i);
    await expect(finance.rejectAtcOrder({
      orderId: 'atc_1', adminUid: 'admin-1', reason: '  ',
    })).rejects.toThrow(/reason/i);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1000);
    expect(await collection('AUDITLOG').countDocuments()).toBe(0);
  });

  it('refuses an approval with a blank reason and writes nothing', async () => {
    await expect(finance.approveAtcOrder({
      orderId: 'atc_1', receivedAmount: 1000, adminUid: 'admin-1', reason: '   ',
    })).rejects.toThrow(/reason/i);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1000);
    expect(await collection('AUDITLOG').countDocuments()).toBe(0);
    expect((await collection('ATCORDERS').findOne({ _id: 'atc_1' })).status).toBe('pending');
  });

  it('refuses an approval with a missing adminUid and writes nothing', async () => {
    await expect(finance.approveAtcOrder({
      orderId: 'atc_1', receivedAmount: 1000, adminUid: '   ', reason: 'ok',
    })).rejects.toThrow(/admin/i);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1000);
    expect(await collection('AUDITLOG').countDocuments()).toBe(0);
    expect((await collection('ATCORDERS').findOne({ _id: 'atc_1' })).status).toBe('pending');
  });

  it('refuses a rejection with a missing adminUid and writes nothing', async () => {
    await expect(finance.rejectAtcOrder({
      orderId: 'atc_1', adminUid: '', reason: 'airtime never arrived',
    })).rejects.toThrow(/admin/i);
    expect(await collection('AUDITLOG').countDocuments()).toBe(0);
    expect((await collection('ATCORDERS').findOne({ _id: 'atc_1' })).status).toBe('pending');
  });

  it('refuses to credit against an order with a corrupt commission percent', async () => {
    await collection('ATCORDERS').updateOne(
      { _id: 'atc_1' },
      { $unset: { percent: '' } }
    );
    await expect(finance.approveAtcOrder({
      orderId: 'atc_1', receivedAmount: 1000, adminUid: 'admin-1', reason: 'ok',
    })).rejects.toThrow(/percent/i);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1000);
    expect(await collection('AUDITLOG').countDocuments()).toBe(0);
  });

  // I5: percent is only validated in [0, 100) at a different time, against a
  // different collection (the ATC catalog's getAtcRate), than the order row
  // this reads. A Firestore-migrated order (or any other corrupt row) with
  // percent >= 100 would otherwise make `credited` negative, and unlike
  // adjustBalance this path had no floor -- an "approval" could silently
  // DEBIT the customer. Both refusals below must write nothing at all.
  it('refuses an order with a commission percent of 100 or more, and writes nothing', async () => {
    await collection('ATCORDERS').updateOne(
      { _id: 'atc_1' },
      { $set: { percent: 150 } }
    );
    await expect(finance.approveAtcOrder({
      orderId: 'atc_1', receivedAmount: 1000, adminUid: 'admin-1', reason: 'ok',
    })).rejects.toThrow(/percent/i);

    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1000);
    expect(await collection('WALLETTRANSACTIONS').countDocuments()).toBe(0);
    expect(await collection('AUDITLOG').countDocuments()).toBe(0);
    expect((await collection('ATCORDERS').findOne({ _id: 'atc_1' })).status).toBe('pending');
  });

  it('refuses an approval that would take the balance negative, and writes nothing', async () => {
    // A corrupt/negative starting balance from some other path: even a tiny
    // positive credit must not be allowed to compound it further while it
    // stays negative overall.
    await collection('USERS').updateOne({ _id: 'user-1' }, { $set: { balance: -100 } });
    await collection('ATCORDERS').updateOne({ _id: 'atc_1' }, { $set: { percent: 99 } });

    await expect(finance.approveAtcOrder({
      orderId: 'atc_1', receivedAmount: 1, adminUid: 'admin-1', reason: 'ok',
    })).rejects.toThrow(/negative/i);

    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(-100);
    expect(await collection('WALLETTRANSACTIONS').countDocuments()).toBe(0);
    expect(await collection('AUDITLOG').countDocuments()).toBe(0);
    expect((await collection('ATCORDERS').findOne({ _id: 'atc_1' })).status).toBe('pending');
  });

  // I4: a legacy /place-order order's transref is client-chosen, so the old
  // deterministic `atc_credit_<transref>` wallet id was predictable and could
  // be claimed first through reserveFunds (TRANSREF_PATTERN spans the same
  // character class). atcCreditReference() now salts with random hex, but the
  // insert must still be guarded rather than left to throw a raw E11000 that
  // 500s the route with no clue why the order can never be approved.
  // crypto.randomBytes is mocked deterministically so this test can predict
  // the exact reference finance.js is about to insert and pre-claim it.
  it('refuses with a named error (not a 500) when the wallet credit reference collides', async () => {
    const fixedBytes = Buffer.from('0102030405060708090a0b', 'hex').subarray(0, 6);
    vi.spyOn(crypto, 'randomBytes').mockReturnValue(fixedBytes);
    try {
      const { atcCreditReference } = require('../../src/models/reference');
      const collidingRef = atcCreditReference('atc_1');
      await collection('WALLETTRANSACTIONS').insertOne({
        _id: collidingRef, transref: collidingRef, uid: 'someone-else',
        amount: 1, status: 'success', mode: 'debit', CreatedAt: new Date(),
      });

      await expect(finance.approveAtcOrder({
        orderId: 'atc_1', receivedAmount: 1000, adminUid: 'admin-1', reason: 'ok',
      })).rejects.toMatchObject({ code: 'ATC_CREDIT_COLLISION' });

      expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1000);
      expect(await collection('AUDITLOG').countDocuments()).toBe(0);
      expect((await collection('ATCORDERS').findOne({ _id: 'atc_1' })).status).toBe('pending');
    } finally {
      vi.restoreAllMocks();
    }
  });
});
