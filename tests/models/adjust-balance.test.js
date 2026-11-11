import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { finance } = require('../../src/models/finance');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const UID = 'user-1';
const balance = async () => (await collection('USERS').findOne({ _id: UID })).balance;
const seed = (b) => collection('USERS').insertOne({ _id: UID, email: 'u@x.com', balance: b });

describe('finance.adjustBalance', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await seed(1000);
  });

  it('credits and writes a wallet row the customer can see', async () => {
    const out = await finance.adjustBalance({ uid: UID, amount: 500, reason: 'goodwill', adminUid: 'admin-1' });

    expect(out).toMatchObject({ prevBal: 1000, newBal: 1500 });
    expect(await balance()).toBe(1500);

    const row = await collection('WALLETTRANSACTIONS').findOne({ _id: out.transref });
    expect(row).toMatchObject({
      uid: UID, mode: 'admin-credit', amount: 500, prevBal: 1000, newBal: 1500,
      status: 'success', validate: true,
    });
    expect(out.transref.startsWith('adj_')).toBe(true);
  });

  it('debits', async () => {
    const out = await finance.adjustBalance({ uid: UID, amount: -300, reason: 'duplicate credit', adminUid: 'admin-1' });
    expect(out.newBal).toBe(700);
    expect(await balance()).toBe(700);
    expect((await collection('WALLETTRANSACTIONS').findOne({ _id: out.transref })).mode).toBe('admin-debit');
  });

  it('refuses a debit that would take the balance negative, and changes nothing', async () => {
    await expect(
      finance.adjustBalance({ uid: UID, amount: -5000, reason: 'oops', adminUid: 'admin-1' })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(await balance()).toBe(1000);
    expect(await collection('WALLETTRANSACTIONS').countDocuments()).toBe(0);
    expect(await collection('AUDITLOG').countDocuments()).toBe(0);
  });

  it('requires a reason', async () => {
    await expect(
      finance.adjustBalance({ uid: UID, amount: 100, reason: '   ', adminUid: 'admin-1' })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await balance()).toBe(1000);
  });

  it('rejects a zero or fractional adjustment', async () => {
    await expect(finance.adjustBalance({ uid: UID, amount: 0, reason: 'x', adminUid: 'a' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(finance.adjustBalance({ uid: UID, amount: 1.5, reason: 'x', adminUid: 'a' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects an unknown user', async () => {
    await expect(finance.adjustBalance({ uid: 'ghost', amount: 100, reason: 'x', adminUid: 'a' }))
      .rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('refuses an adjustment with no adminUid, and changes nothing', async () => {
    await expect(
      finance.adjustBalance({ uid: UID, amount: 100, reason: 'x', adminUid: undefined })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(await balance()).toBe(1000);
    expect(await collection('WALLETTRANSACTIONS').countDocuments()).toBe(0);
    expect(await collection('AUDITLOG').countDocuments()).toBe(0);
  });

  it('refuses an amount above the cap, and changes nothing', async () => {
    await expect(
      finance.adjustBalance({ uid: UID, amount: 2000000, reason: 'x', adminUid: 'admin-1' })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(await balance()).toBe(1000);
    expect(await collection('WALLETTRANSACTIONS').countDocuments()).toBe(0);
    expect(await collection('AUDITLOG').countDocuments()).toBe(0);
  });

  it('rejects an unsafe integer amount, and changes nothing', async () => {
    await expect(
      finance.adjustBalance({ uid: UID, amount: 1e20, reason: 'x', adminUid: 'admin-1' })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(await balance()).toBe(1000);
    expect(await collection('WALLETTRANSACTIONS').countDocuments()).toBe(0);
    expect(await collection('AUDITLOG').countDocuments()).toBe(0);
  });

  it('writes the audit row in the same transaction as the balance change', async () => {
    const out = await finance.adjustBalance({ uid: UID, amount: 250, reason: 'refund for T123', adminUid: 'admin-9' });

    const entry = await collection('AUDITLOG').findOne({ targetUid: UID });
    expect(entry).toMatchObject({
      action: 'balance.adjust', adminUid: 'admin-9', targetUid: UID,
      amount: 250, reason: 'refund for T123', prevBal: 1000, newBal: 1250,
    });
    expect(entry.transref).toBe(out.transref);
  });

  it('does not lose an update when two adjustments run concurrently', async () => {
    const results = await Promise.allSettled([
      finance.adjustBalance({ uid: UID, amount: 100, reason: 'a', adminUid: 'admin-1' }),
      finance.adjustBalance({ uid: UID, amount: 200, reason: 'b', adminUid: 'admin-1' }),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    // Both applied — neither read a stale balance and clobbered the other.
    expect(await balance()).toBe(1300);
    expect(await collection('WALLETTRANSACTIONS').countDocuments()).toBe(2);

    // The two adjustments must serialise: one row's newBal is the other's
    // prevBal, not two rows racing off the same starting balance.
    const rows = await collection('WALLETTRANSACTIONS').find().toArray();
    const sorted = rows.sort((a, b) => a.prevBal - b.prevBal);
    expect(sorted[0].prevBal).toBe(1000);
    expect(sorted[1].prevBal).toBe(sorted[0].newBal);
    expect(sorted[1].newBal).toBe(1300);
  });
});
