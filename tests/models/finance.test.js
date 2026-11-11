import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const { finance, STATUS } = require('../../src/models/finance');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const UID = 'user-1';

async function seedUser(balance) {
  await collection('USERS').insertOne({ _id: UID, email: 'a@b.c', balance });
}

const wallet = (transref) => collection('WALLETTRANSACTIONS').findOne({ _id: transref });
const balance = async () => (await collection('USERS').findOne({ _id: UID })).balance;

describe('finance.reserveFunds', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(clearTestMongo);

  it('deducts the amount and writes a pending debit', async () => {
    await seedUser(1000);
    const out = await finance.reserveFunds({ uid: UID, amount: 400, transref: 'ref-1', channel: 'Data' });

    expect(out).toMatchObject({ prevBal: 1000, newBal: 600 });
    expect(await balance()).toBe(600);
    expect(await wallet('ref-1')).toMatchObject({ status: STATUS.PENDING, mode: 'debit', amount: 400 });
  });

  it('rejects when the balance is too low and does not deduct', async () => {
    await seedUser(100);
    await expect(
      finance.reserveFunds({ uid: UID, amount: 400, transref: 'ref-1', channel: 'Data' })
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });

    expect(await balance()).toBe(100);
    expect(await wallet('ref-1')).toBeNull();
  });

  it('rejects a duplicate transref', async () => {
    await seedUser(1000);
    await finance.reserveFunds({ uid: UID, amount: 100, transref: 'ref-1', channel: 'Data' });
    await expect(
      finance.reserveFunds({ uid: UID, amount: 100, transref: 'ref-1', channel: 'Data' })
    ).rejects.toMatchObject({ code: 'DUPLICATE_TRANSACTION' });

    expect(await balance()).toBe(900);
  });

  it('rejects an unknown user', async () => {
    await expect(
      finance.reserveFunds({ uid: 'ghost', amount: 100, transref: 'ref-1', channel: 'Data' })
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('cannot be made to overdraw by concurrent requests', async () => {
    await seedUser(1000);
    // Six concurrent 200-naira purchases against a 1000 balance: at most five
    // can succeed. Before the transaction port this was a read-modify-write
    // race and all six could pass the balance check.
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        finance.reserveFunds({ uid: UID, amount: 200, transref: `ref-${i}`, channel: 'Data' })
      )
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    expect(succeeded).toBe(5);
    expect(await balance()).toBe(0);
  });
});

describe('finance.settle', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(clearTestMongo);

  it('marks a pending debit settled', async () => {
    await seedUser(1000);
    await finance.reserveFunds({ uid: UID, amount: 200, transref: 'ref-1', channel: 'Data' });

    expect(await finance.settle({ transref: 'ref-1' })).toEqual({ changed: true });
    expect((await wallet('ref-1')).status).toBe(STATUS.SUCCESS);
  });

  it('is a no-op on an already settled transaction', async () => {
    await seedUser(1000);
    await finance.reserveFunds({ uid: UID, amount: 200, transref: 'ref-1', channel: 'Data' });
    await finance.settle({ transref: 'ref-1' });

    expect(await finance.settle({ transref: 'ref-1' })).toEqual({ changed: false, reason: 'already-settled' });
  });

  it('reports not-found for an unknown transref', async () => {
    expect(await finance.settle({ transref: 'nope' })).toEqual({ changed: false, reason: 'not-found' });
  });
});

describe('finance.reverse', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(clearTestMongo);

  it('refunds a pending debit', async () => {
    await seedUser(1000);
    await finance.reserveFunds({ uid: UID, amount: 200, transref: 'ref-1', channel: 'Data' });

    const out = await finance.reverse({ uid: UID, transref: 'ref-1', reason: 'provider declined' });
    expect(out).toMatchObject({ changed: true, restored: 1000 });
    expect(await balance()).toBe(1000);
    expect((await wallet('ref-1')).status).toBe(STATUS.REVERSED);
  });

  it('does not double-refund on a second call', async () => {
    await seedUser(1000);
    await finance.reserveFunds({ uid: UID, amount: 200, transref: 'ref-1', channel: 'Data' });
    await finance.reverse({ uid: UID, transref: 'ref-1' });
    await finance.reverse({ uid: UID, transref: 'ref-1' });

    expect(await balance()).toBe(1000);
  });

  it('will not reverse an already settled transaction', async () => {
    await seedUser(1000);
    await finance.reserveFunds({ uid: UID, amount: 200, transref: 'ref-1', channel: 'Data' });
    await finance.settle({ transref: 'ref-1' });

    expect(await finance.reverse({ uid: UID, transref: 'ref-1' }))
      .toEqual({ changed: false, reason: 'not-reversible' });
    expect(await balance()).toBe(800);
  });
});

describe('finance.holdForRequery', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(clearTestMongo);

  it('flags for reconciliation WITHOUT refunding', async () => {
    await seedUser(1000);
    await finance.reserveFunds({ uid: UID, amount: 200, transref: 'ref-1', channel: 'Data' });

    await finance.holdForRequery({ transref: 'ref-1', reason: 'timeout', raw: { any: 'thing' } });

    // The core invariant: the provider may have fulfilled the order, so
    // refunding here risks paying the provider AND crediting the user back.
    expect(await balance()).toBe(800);
    expect(await wallet('ref-1')).toMatchObject({ status: STATUS.REQUERY, validate: false, requeryReason: 'timeout' });
  });

  it('truncates a large provider response', async () => {
    await seedUser(1000);
    await finance.reserveFunds({ uid: UID, amount: 200, transref: 'ref-1', channel: 'Data' });
    await finance.holdForRequery({ transref: 'ref-1', reason: 'x', raw: { blob: 'y'.repeat(5000) } });

    expect((await wallet('ref-1')).providerResponse.length).toBeLessThanOrEqual(1500);
  });
});

describe('finance.sweepStalePending', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(clearTestMongo);

  const pendingRow = (transref, ageMs, over = {}) => ({
    _id: transref,
    transref,
    uid: UID,
    amount: 200,
    channel: 'Data',
    status: STATUS.PENDING,
    validate: false,
    mode: 'debit',
    CreatedAt: new Date(Date.now() - ageMs),
    ...over,
  });

  it('ages a row older than the cutoff into REQUERY with a distinguishing reason', async () => {
    await collection('WALLETTRANSACTIONS').insertOne(pendingRow('ref-old', 2 * 60 * 60 * 1000));

    const out = await finance.sweepStalePending({ olderThanMs: 60 * 60 * 1000 });

    expect(out).toEqual({ swept: 1, found: 1 });
    expect(await wallet('ref-old')).toMatchObject({
      status: STATUS.REQUERY,
      requeryReason: 'stale-pending',
    });
  });

  it('leaves a row newer than the cutoff untouched', async () => {
    await collection('WALLETTRANSACTIONS').insertOne(pendingRow('ref-new', 5 * 60 * 1000));

    const out = await finance.sweepStalePending({ olderThanMs: 60 * 60 * 1000 });

    expect(out).toEqual({ swept: 0, found: 0 });
    expect(await wallet('ref-new')).toMatchObject({ status: STATUS.PENDING });
  });

  it('leaves rows already success, reversed or requery untouched', async () => {
    for (const status of [STATUS.SUCCESS, STATUS.REVERSED, STATUS.REQUERY]) {
      await collection('WALLETTRANSACTIONS').insertOne(
        pendingRow(`ref-${status}`, 2 * 60 * 60 * 1000, { status })
      );
    }

    const out = await finance.sweepStalePending({ olderThanMs: 60 * 60 * 1000 });

    expect(out).toEqual({ swept: 0, found: 0 });
    for (const status of [STATUS.SUCCESS, STATUS.REVERSED, STATUS.REQUERY]) {
      expect(await wallet(`ref-${status}`)).toMatchObject({ status });
    }
  });

  it('is idempotent when run twice', async () => {
    await collection('WALLETTRANSACTIONS').insertOne(pendingRow('ref-old', 2 * 60 * 60 * 1000));

    const first = await finance.sweepStalePending({ olderThanMs: 60 * 60 * 1000 });
    const second = await finance.sweepStalePending({ olderThanMs: 60 * 60 * 1000 });

    expect(first).toEqual({ swept: 1, found: 1 });
    expect(second).toEqual({ swept: 0, found: 0 });
    expect(await wallet('ref-old')).toMatchObject({ status: STATUS.REQUERY });
  });
});

describe('finance.creditWallet', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(clearTestMongo);

  it('credits the wallet', async () => {
    await seedUser(500);
    const out = await finance.creditWallet({ uid: UID, amount: 1000, transref: 'pay-1', meta: { channel: 'Wallet' } });

    expect(out).toMatchObject({ changed: true, prevBal: 500, newBal: 1500 });
    expect(await balance()).toBe(1500);
  });

  it('credits exactly once when a webhook is replayed', async () => {
    await seedUser(500);
    await finance.creditWallet({ uid: UID, amount: 1000, transref: 'pay-1', meta: {} });
    const second = await finance.creditWallet({ uid: UID, amount: 1000, transref: 'pay-1', meta: {} });

    expect(second).toEqual({ changed: false, reason: 'already-credited' });
    expect(await balance()).toBe(1500);
  });

  it('is safe under a concurrent webhook and verify callback', async () => {
    await seedUser(0);
    const results = await Promise.allSettled([
      finance.creditWallet({ uid: UID, amount: 1000, transref: 'pay-1', meta: { source: 'webhook' } }),
      finance.creditWallet({ uid: UID, amount: 1000, transref: 'pay-1', meta: { source: 'verify' } }),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await balance()).toBe(1000);
  });
});

describe('finance.getBalance and recordTransaction', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(clearTestMongo);

  it('reads a balance', async () => {
    await seedUser(750);
    expect(await finance.getBalance(UID)).toBe(750);
  });

  it('throws for an unknown user', async () => {
    await expect(finance.getBalance('ghost')).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('writes a ledger row keyed by transref', async () => {
    await finance.recordTransaction({
      uid: UID, transref: 'ref-1', transType: 'Data', amount: 400,
      result: { status: 'success', message: 'ok', reference: 'p-1', provider: 'husmodata', raw: { a: 1 } },
    });

    const row = await collection('TRANSACTIONS').findOne({ _id: 'ref-1' });
    expect(row).toMatchObject({ uid: UID, transType: 'Data', amount: 400, status: 'success', provider: 'husmodata' });
  });

  it('persists the provider earning as structured, queryable fields', async () => {
    await finance.recordTransaction({
      uid: 'user-1', transref: 'pur_earn_1', transType: 'Airtime', amount: 100,
      result: {
        status: 'success', message: 'ok', reference: 'v1', provider: 'vtpass',
        earning: { earning: 3.5, rate: 3.5, amountCharged: 96.5, reportedEarning: 4 },
        raw: { code: '000' },
      },
    });

    const row = await collection('TRANSACTIONS').findOne({ _id: 'pur_earn_1' });
    expect(row.providerEarning).toBe(3.5);
    expect(row.providerEarningRate).toBe(3.5);
    expect(row.providerAmountCharged).toBe(96.5);
    // Stored apart from providerEarning because the two demonstrably disagree.
    // Never summed for reporting; only compared.
    expect(row.providerReportedEarning).toBe(4);
  });

  // The fields must be queryable in their own right -- that is the entire
  // reason they are not left inside `raw`, which is truncated to 1500 chars
  // and would silently drop them on a long response.
  it('stores earning fields outside raw, so a truncated raw cannot lose them', async () => {
    const padded = { code: '000', filler: 'x'.repeat(4000) };
    await finance.recordTransaction({
      uid: 'user-1', transref: 'pur_earn_2', transType: 'Airtime', amount: 100,
      result: {
        status: 'success', message: 'ok', provider: 'vtpass',
        earning: { earning: 3.5, rate: 3.5, amountCharged: 96.5, reportedEarning: 4 },
        raw: padded,
      },
    });

    const row = await collection('TRANSACTIONS').findOne({ _id: 'pur_earn_2' });
    expect(row.raw.length).toBe(1500);
    expect(row.providerEarning).toBe(3.5);
  });

  it('stores null, not zero, when the provider reported no earning', async () => {
    await finance.recordTransaction({
      uid: 'user-1', transref: 'pur_earn_3', transType: 'Airtime', amount: 100,
      result: { status: 'success', message: 'ok', provider: 'husmodata', raw: {} },
    });

    const row = await collection('TRANSACTIONS').findOne({ _id: 'pur_earn_3' });
    expect(row.providerEarning).toBeNull();
    expect(row.providerEarningRate).toBeNull();
    expect(row.providerAmountCharged).toBeNull();
    expect(row.providerReportedEarning).toBeNull();
  });

  // A real earning of zero must survive as zero. If it collapsed to null it
  // would be excluded from the earnings aggregation, which filters on null,
  // and a service that genuinely pays nothing would silently vanish from the
  // report instead of showing up as the problem it is.
  it('distinguishes a genuine zero earning from an absent one', async () => {
    await finance.recordTransaction({
      uid: 'user-1', transref: 'pur_earn_4', transType: 'Airtime', amount: 100,
      result: {
        status: 'success', message: 'ok', provider: 'vtpass',
        earning: { earning: 0, rate: 0, amountCharged: 100, reportedEarning: 0 },
        raw: {},
      },
    });

    const row = await collection('TRANSACTIONS').findOne({ _id: 'pur_earn_4' });
    expect(row.providerEarning).toBe(0);
    expect(row.providerEarning).not.toBeNull();
  });

  it('stores null for a garbage earning value rather than NaN', async () => {
    await finance.recordTransaction({
      uid: 'user-1', transref: 'pur_earn_5', transType: 'Airtime', amount: 100,
      result: {
        status: 'success', message: 'ok', provider: 'vtpass',
        earning: { earning: 'abc', rate: undefined, amountCharged: null, reportedEarning: NaN },
        raw: {},
      },
    });

    const row = await collection('TRANSACTIONS').findOne({ _id: 'pur_earn_5' });
    expect(row.providerEarning).toBeNull();
    expect(row.providerEarningRate).toBeNull();
    expect(row.providerReportedEarning).toBeNull();
  });
});
