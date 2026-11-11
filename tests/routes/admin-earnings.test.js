import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const request = require('supertest');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');
const { collection } = require('../../src/services/mongo');
const { finance } = require('../../src/models/finance');
const app = require('../../src/app');
const jwt = require('jsonwebtoken');

const asAdmin = () => `Bearer ${jwt.sign({ uid: 'admin-1', account: 'ADMIN' }, process.env.JWT_SECRET || 'test-secret')}`;
const asUser  = () => `Bearer ${jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET || 'test-secret')}`;

// Rows are written through finance.recordTransaction, the real producer, so
// the aggregation is tested against the exact document shape production
// writes. A hand-inserted TRANSACTIONS document would let a field-name typo in
// recordTransaction pass unnoticed here.
async function record(transref, { transType, amount, earning, status = 'success' }) {
  await finance.recordTransaction({
    uid: 'user-1', transref, transType, amount,
    result: { status, message: 'ok', provider: 'vtpass', earning, raw: {} },
  });
}

const rate = (over) => ({
  provider: 'vtpass', serviceLabel: 'MTN Airtime VTU', matchesTransType: 'airtime',
  expectedRate: 3, cappedAt: null, active: true, CreatedAt: new Date(), ...over,
});

describe('/admin/earnings', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await collection('USERS').insertMany([
      { _id: 'admin-1', account: 'ADMIN', setUpProcess: true, balance: 0 },
      { _id: 'user-1', account: 'USER', balance: 0 },
    ]);
  });

  it('refuses a non-admin', async () => {
    expect((await request(app).get('/admin/earnings').set('Authorization', asUser())).status).toBe(403);
  });

  it('totals what the provider actually paid, per service', async () => {
    await collection('PROVIDERRATES').insertOne(rate());
    for (const n of [1, 2, 3]) {
      await record(`e${n}`, {
        transType: 'Airtime', amount: 100,
        earning: { earning: 3.5, rate: 3.5, amountCharged: 96.5, reportedEarning: 4 },
      });
    }

    const res = await request(app).get('/admin/earnings').set('Authorization', asAdmin());
    expect(res.status).toBe(200);

    const row = res.body.rows.find((r) => r.kind === 'airtime');
    expect(row.count).toBe(3);
    expect(row.totalCharged).toBe(300);
    expect(row.totalEarned).toBe(10.5);
    expect(row.effectiveRate).toBe(3.5);
  });

  // The claimed figure is reported alongside, never folded into the total. A
  // persistent gap between them is itself a finding.
  it('reports the provider-claimed total separately from the earned total', async () => {
    await collection('PROVIDERRATES').insertOne(rate());
    await record('e1', {
      transType: 'Airtime', amount: 100,
      earning: { earning: 3.5, rate: 3.5, amountCharged: 96.5, reportedEarning: 4 },
    });

    const res = await request(app).get('/admin/earnings').set('Authorization', asAdmin());
    const row = res.body.rows.find((r) => r.kind === 'airtime');

    expect(row.totalEarned).toBe(3.5);
    expect(row.totalReported).toBe(4);
    expect(row.reportedGap).toBe(0.5);
  });

  it('flags a service earning below its expected rate, with the count', async () => {
    await collection('PROVIDERRATES').insertOne(rate({ expectedRate: 3 }));
    // Two at 1% (below 3%), one at 3.5% (above).
    await record('e1', { transType: 'Airtime', amount: 100, earning: { earning: 1, rate: 1, amountCharged: 99, reportedEarning: 1 } });
    await record('e2', { transType: 'Airtime', amount: 100, earning: { earning: 1, rate: 1, amountCharged: 99, reportedEarning: 1 } });
    await record('e3', { transType: 'Airtime', amount: 100, earning: { earning: 3.5, rate: 3.5, amountCharged: 96.5, reportedEarning: 4 } });

    const res = await request(app).get('/admin/earnings').set('Authorization', asAdmin());
    const row = res.body.rows.find((r) => r.kind === 'airtime');

    expect(row.expectedRate).toBe(3);
    expect(row.expectedEarned).toBe(9);      // 3 x 100 x 3%
    expect(row.totalEarned).toBe(5.5);
    expect(row.belowExpected).toBe(true);
    expect(row.belowExpectedCount).toBe(2);  // the two that individually fell short
  });

  it('stops expected earning at the cap', async () => {
    // 5% of 10000 is 500, but the rate is capped at 100 naira per transaction.
    await collection('PROVIDERRATES').insertOne(
      rate({ matchesTransType: 'data', expectedRate: 5, cappedAt: 100, serviceLabel: 'MTN Data' })
    );
    await record('e1', {
      transType: 'Data', amount: 10000,
      earning: { earning: 100, rate: 1, amountCharged: 9900, reportedEarning: 100 },
    });

    const res = await request(app).get('/admin/earnings').set('Authorization', asAdmin());
    const row = res.body.rows.find((r) => r.kind === 'data');

    expect(row.cappedAt).toBe(100);
    expect(row.expectedEarned).toBe(100);
    // Without the cap this would expect 500 and wrongly flag a shortfall.
    expect(row.belowExpected).toBe(false);
  });

  // The aggregation cannot run over history recorded before Task 3, so it must
  // not present a total that silently excludes it.
  it('excludes transactions with no structured commission and reports its window', async () => {
    await collection('PROVIDERRATES').insertOne(rate());
    await record('old', { transType: 'Airtime', amount: 100, earning: undefined });
    await record('new', {
      transType: 'Airtime', amount: 100,
      earning: { earning: 3.5, rate: 3.5, amountCharged: 96.5, reportedEarning: 4 },
    });

    const res = await request(app).get('/admin/earnings').set('Authorization', asAdmin());
    const row = res.body.rows.find((r) => r.kind === 'airtime');

    expect(row.count).toBe(1);
    expect(row.totalCharged).toBe(100);
    expect(res.body.coverage.transactions).toBe(1);
    expect(res.body.coverage.since).not.toBeNull();
    expect(new Date(res.body.coverage.since).toString()).not.toBe('Invalid Date');
  });

  it('reports a null coverage window when nothing has structured data yet', async () => {
    const res = await request(app).get('/admin/earnings').set('Authorization', asAdmin());
    expect(res.body.coverage.since).toBeNull();
    expect(res.body.coverage.transactions).toBe(0);
    expect(res.body.rows).toHaveLength(0);
  });

  it('counts only successful purchases', async () => {
    await collection('PROVIDERRATES').insertOne(rate());
    await record('e1', {
      transType: 'Airtime-Reversed', amount: 100, status: 'failed',
      earning: { earning: 3.5, rate: 3.5, amountCharged: 96.5, reportedEarning: 4 },
    });

    const res = await request(app).get('/admin/earnings').set('Authorization', asAdmin());
    expect(res.body.rows).toHaveLength(0);
  });

  // A stale or missing rate must be visible, not silent.
  it('lists a service with no rate as unrated rather than flagging it', async () => {
    await record('e1', {
      transType: 'Data', amount: 1000,
      earning: { earning: 10, rate: 1, amountCharged: 990, reportedEarning: 10 },
    });

    const res = await request(app).get('/admin/earnings').set('Authorization', asAdmin());
    const row = res.body.rows.find((r) => r.kind === 'data');

    expect(row.expectedRate).toBeNull();
    expect(row.belowExpected).toBe(false);
    expect(res.body.unrated).toContainEqual({ provider: 'vtpass', kind: 'data' });
  });

  // Hand-seeded rates bypass the presenter's validation, so a garbage
  // expectedRate is a realistic input, not a hypothetical. Number('abc') is
  // NaN, which must not silently pass as "rated" -- the row has to surface
  // in `unrated` exactly like a missing rate, not render a `null` that looks
  // identical to one while hiding from the list that flags it.
  it('treats a malformed rate as unrated rather than silently passing NaN through', async () => {
    await collection('PROVIDERRATES').insertOne(rate({ expectedRate: 'abc' }));
    await record('e1', {
      transType: 'Airtime', amount: 100,
      earning: { earning: 3.5, rate: 3.5, amountCharged: 96.5, reportedEarning: 4 },
    });

    const res = await request(app).get('/admin/earnings').set('Authorization', asAdmin());
    const row = res.body.rows.find((r) => r.kind === 'airtime');

    expect(row.expectedRate).toBeNull();
    expect(row.belowExpected).toBe(false);
    expect(res.body.unrated).toContainEqual({ provider: 'vtpass', kind: 'airtime' });
  });

  it('honours the from and to range', async () => {
    await collection('PROVIDERRATES').insertOne(rate());
    await record('e1', {
      transType: 'Airtime', amount: 100,
      earning: { earning: 3.5, rate: 3.5, amountCharged: 96.5, reportedEarning: 4 },
    });
    await collection('TRANSACTIONS').updateOne(
      { _id: 'e1' }, { $set: { CreatedAt: new Date('2020-01-01T00:00:00Z') } }
    );

    const inRange = await request(app)
      .get('/admin/earnings?from=2019-12-01&to=2020-02-01').set('Authorization', asAdmin());
    expect(inRange.body.rows).toHaveLength(1);

    const outOfRange = await request(app)
      .get('/admin/earnings?from=2021-01-01&to=2021-02-01').set('Authorization', asAdmin());
    expect(outOfRange.body.rows).toHaveLength(0);
    // Coverage is a property of the data, not of the window asked for.
    expect(outOfRange.body.coverage.transactions).toBe(1);
  });

  // The console's <input type="date"> submits a bare "2026-09-30". Parsed
  // literally that lands at 2026-09-30T00:00:00.000Z, and $lte against that
  // midnight would silently drop the rest of the final day. A date-only `to`
  // must mean the whole day.
  it('includes a transaction recorded later on the final day of the range', async () => {
    await collection('PROVIDERRATES').insertOne(rate());
    await record('e1', {
      transType: 'Airtime', amount: 100,
      earning: { earning: 3.5, rate: 3.5, amountCharged: 96.5, reportedEarning: 4 },
    });
    await collection('TRANSACTIONS').updateOne(
      { _id: 'e1' }, { $set: { CreatedAt: new Date('2020-01-31T18:00:00Z') } }
    );

    const res = await request(app)
      .get('/admin/earnings?from=2020-01-01&to=2020-01-31').set('Authorization', asAdmin());
    expect(res.body.rows).toHaveLength(1);
  });

  it('rejects an unparseable date', async () => {
    const res = await request(app).get('/admin/earnings?from=yesterday').set('Authorization', asAdmin());
    expect(res.status).toBe(422);
  });

  // 'Epins' and 'Epin' are both written by live routes and must fold together,
  // exactly as the transactions feed already folds them.
  it('folds transType variants to one kind', async () => {
    await record('e1', {
      transType: 'Epins', amount: 100,
      earning: { earning: 2, rate: 2, amountCharged: 98, reportedEarning: 2 },
    });
    await record('e2', {
      transType: 'Epin', amount: 100,
      earning: { earning: 2, rate: 2, amountCharged: 98, reportedEarning: 2 },
    });

    const res = await request(app).get('/admin/earnings').set('Authorization', asAdmin());
    expect(res.body.rows.filter((r) => r.kind === 'epin')).toHaveLength(1);
    expect(res.body.rows.find((r) => r.kind === 'epin').count).toBe(2);
  });
});
