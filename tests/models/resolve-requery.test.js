import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');
const { collection } = require('../../src/services/mongo');
const { finance } = require('../../src/models/finance');

const heldRow = (over = {}) => ({
  _id: 'pur_h', transref: 'pur_h', uid: 'user-1', amount: 500,
  status: 'requery', requeryReason: 'timeout', prevBal: 1500, newBal: 1000,
  CreatedAt: new Date(), ...over,
});

describe('finance.resolveRequery', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await collection('USERS').insertOne({ _id: 'user-1', balance: 1000, account: 'USER' });
  });

  it('settles a held row: the debit stands and the balance does not move', async () => {
    await collection('WALLETTRANSACTIONS').insertOne(heldRow());
    const out = await finance.resolveRequery({
      transref: 'pur_h', decision: 'settle', adminUid: 'admin-1', reason: 'confirmed delivered',
    });
    expect(out.changed).toBe(true);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1000);
    expect((await collection('WALLETTRANSACTIONS').findOne({ _id: 'pur_h' })).status).toBe('success');
  });

  it('reverses a held row: the exact debited amount comes back', async () => {
    await collection('WALLETTRANSACTIONS').insertOne(heldRow());
    const out = await finance.resolveRequery({
      transref: 'pur_h', decision: 'reverse', adminUid: 'admin-1', reason: 'never delivered',
    });
    expect(out.changed).toBe(true);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1500);
    const row = await collection('WALLETTRANSACTIONS').findOne({ _id: 'pur_h' });
    expect(row.status).toBe('reversed');
    expect(row.mode).toBe('credit-reversal');
  });

  it('writes an audit row in the same transaction', async () => {
    await collection('WALLETTRANSACTIONS').insertOne(heldRow());
    await finance.resolveRequery({
      transref: 'pur_h', decision: 'settle', adminUid: 'admin-1', reason: 'confirmed',
    });
    const entry = await collection('AUDITLOG').findOne({ action: 'requery.resolve' });
    expect(entry).toMatchObject({ adminUid: 'admin-1', decision: 'settle', transref: 'pur_h' });
  });

  it('writes an audit row for the reverse decision recording the amount', async () => {
    await collection('WALLETTRANSACTIONS').insertOne(heldRow());
    await finance.resolveRequery({
      transref: 'pur_h', decision: 'reverse', adminUid: 'admin-1', reason: 'never delivered',
    });
    const entry = await collection('AUDITLOG').findOne({ action: 'requery.resolve', decision: 'reverse' });
    expect(entry).toMatchObject({
      adminUid: 'admin-1', decision: 'reverse', transref: 'pur_h', amount: 500,
    });
  });

  it('refuses a row that is not held, and writes nothing at all', async () => {
    for (const status of ['pending', 'success', 'reversed']) {
      await clearTestMongo();
      await collection('USERS').insertOne({ _id: 'user-1', balance: 1000, account: 'USER' });
      await collection('WALLETTRANSACTIONS').insertOne(heldRow({ status }));
      const before = await collection('WALLETTRANSACTIONS').findOne({ _id: 'pur_h' });

      const out = await finance.resolveRequery({
        transref: 'pur_h', decision: 'reverse', adminUid: 'admin-1', reason: 'x',
      });
      expect(out.changed).toBe(false);
      expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1000);
      expect(await collection('AUDITLOG').countDocuments()).toBe(0);

      // Whole-document comparison, not field-by-field: a field-by-field check
      // only catches the fields the test author thought of. Any write at all
      // to this row -- settledAt, resolvedReason, whatever -- must show up here.
      const after = await collection('WALLETTRANSACTIONS').findOne({ _id: 'pur_h' });
      expect(after).toEqual(before);
    }
  });

  it('requires a reason and a decision it understands', async () => {
    await collection('WALLETTRANSACTIONS').insertOne(heldRow());
    await expect(finance.resolveRequery({
      transref: 'pur_h', decision: 'settle', adminUid: 'admin-1', reason: '   ',
    })).rejects.toThrow(/reason/i);
    await expect(finance.resolveRequery({
      transref: 'pur_h', decision: 'delete', adminUid: 'admin-1', reason: 'x',
    })).rejects.toThrow(/decision/i);
    expect(await collection('AUDITLOG').countDocuments()).toBe(0);
  });

  it('requires a non-blank adminUid, and writes nothing', async () => {
    await collection('WALLETTRANSACTIONS').insertOne(heldRow());
    const before = await collection('WALLETTRANSACTIONS').findOne({ _id: 'pur_h' });

    await expect(finance.resolveRequery({
      transref: 'pur_h', decision: 'settle', adminUid: '   ', reason: 'x',
    })).rejects.toThrow(/admin/i);
    await expect(finance.resolveRequery({
      transref: 'pur_h', decision: 'settle', reason: 'x',
    })).rejects.toThrow(/admin/i);

    expect(await collection('AUDITLOG').countDocuments()).toBe(0);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1000);
    expect(await collection('WALLETTRANSACTIONS').findOne({ _id: 'pur_h' })).toEqual(before);
  });

  it('returns changed: false for an unknown transref, without throwing', async () => {
    const out = await finance.resolveRequery({
      transref: 'no-such-ref', decision: 'reverse', adminUid: 'admin-1', reason: 'x',
    });
    expect(out).toEqual({ changed: false, reason: 'not-found' });
    expect(await collection('AUDITLOG').countDocuments()).toBe(0);
  });

  it('resolving twice resolves once', async () => {
    await collection('WALLETTRANSACTIONS').insertOne(heldRow());
    const a = await finance.resolveRequery({ transref: 'pur_h', decision: 'reverse', adminUid: 'admin-1', reason: 'x' });
    const b = await finance.resolveRequery({ transref: 'pur_h', decision: 'reverse', adminUid: 'admin-1', reason: 'x' });
    expect(a.changed).toBe(true);
    expect(b.changed).toBe(false);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1500);
  });

  it('races two reverse resolutions of the same held row: exactly one refund lands', async () => {
    await collection('WALLETTRANSACTIONS').insertOne(heldRow());
    // Both transactions read the REQUERY row; whichever commits first flips it
    // to REVERSED, the loser's write conflicts, withTransaction retries the
    // loser's callback, and the retry re-reads a row that is no longer held.
    const results = await Promise.allSettled([
      finance.resolveRequery({ transref: 'pur_h', decision: 'reverse', adminUid: 'admin-1', reason: 'a' }),
      finance.resolveRequery({ transref: 'pur_h', decision: 'reverse', adminUid: 'admin-2', reason: 'b' }),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const changedCount = results.filter((r) => r.value.changed === true).length;
    expect(changedCount).toBe(1);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1500);
    expect(await collection('AUDITLOG').countDocuments({ action: 'requery.resolve' })).toBe(1);
  });

  it('races two settle resolutions of the same held row: balance never moves, one audit row', async () => {
    await collection('WALLETTRANSACTIONS').insertOne(heldRow());
    const results = await Promise.allSettled([
      finance.resolveRequery({ transref: 'pur_h', decision: 'settle', adminUid: 'admin-1', reason: 'a' }),
      finance.resolveRequery({ transref: 'pur_h', decision: 'settle', adminUid: 'admin-2', reason: 'b' }),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const changedCount = results.filter((r) => r.value.changed === true).length;
    expect(changedCount).toBe(1);
    expect((await collection('USERS').findOne({ _id: 'user-1' })).balance).toBe(1000);
    expect(await collection('AUDITLOG').countDocuments({ action: 'requery.resolve' })).toBe(1);
  });
});
