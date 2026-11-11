import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
const request = require('supertest');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');
const { collection } = require('../../src/services/mongo');
const app = require('../../src/app');
const jwt = require('jsonwebtoken');

const asAdmin = () => `Bearer ${jwt.sign({ uid: 'admin-1', account: 'ADMIN' }, process.env.JWT_SECRET || 'test-secret')}`;
const asUser  = () => `Bearer ${jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET || 'test-secret')}`;

const post = (body) =>
  request(app).post('/admin/import/apply').set('Authorization', asAdmin()).send(body);

const created = (over = {}) => ({
  action: 'create',
  fields: { network: 'MTN', size: '1GB', validity: '30 days', amount: 1150, vtpassCode: 'mtn-1gb-3500', ...over },
});

beforeAll(startTestMongo);
afterAll(stopTestMongo);
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await clearTestMongo();
  await collection('USERS').insertMany([
    { _id: 'admin-1', account: 'ADMIN', setUpProcess: true, balance: 0 },
    { _id: 'user-1', account: 'USER', balance: 0 },
  ]);
});

describe('POST /admin/import/apply', () => {
  it('refuses a non-admin', async () => {
    const res = await request(app).post('/admin/import/apply').set('Authorization', asUser())
      .send({ collection: 'data-plans', decisions: [] });
    expect(res.status).toBe(403);
  });

  it('creates the rows it is given', async () => {
    const res = await post({ collection: 'data-plans', decisions: [created()] });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    const row = await collection('DATAPACKS').findOne({ vtpassCode: 'mtn-1gb-3500' });
    expect(row.Network).toBe('MTN');
    expect(row.Amount).toBe('₦1150.0');
  });

  // The guarantee. A created row is never sellable until a human says so, no
  // matter what the payload asks for.
  it('forces every created row inactive, even when the payload says otherwise', async () => {
    await post({ collection: 'data-plans', decisions: [created({ active: true })] });
    const row = await collection('DATAPACKS').findOne({ vtpassCode: 'mtn-1gb-3500' });
    expect(row.active).toBe(false);
  });

  // The other guarantee. The write request carries values, never a provider
  // reference, so nothing here can reach upstream.
  it('never contacts the provider', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await post({ collection: 'data-plans', decisions: [created()] });
    expect(spy).not.toHaveBeenCalled();
  });

  it('attaches a code to an existing row and changes nothing else about it', async () => {
    const id = String((await collection('DATAPACKS').insertOne({
      Network: 'MTN', Size: '1GB', Validity: '30 days', Amount: '₦280.0',
      dataId: 7, planType: 'SME', active: true, CreatedAt: new Date(),
    })).insertedId);

    const before = await collection('DATAPACKS').findOne({});
    const res = await post({
      collection: 'data-plans',
      decisions: [{ action: 'attach', id, fields: { vtpassCode: 'mtn-1gb-3500' } }],
    });

    expect(res.status).toBe(200);
    expect(res.body.attached).toBe(1);

    const after = await collection('DATAPACKS').findOne({});
    expect(after.vtpassCode).toBe('mtn-1gb-3500');
    // Every other field byte-identical: the price a customer pays, the name,
    // and whether it is sellable are all untouched by an attach.
    expect({ ...after, vtpassCode: null }).toEqual({ ...before, vtpassCode: null });
  });

  // An attach that could rewrite price or active would be a second, silent way
  // for provider data to change what a customer is charged.
  it('ignores any field on an attach that is not the provider identifier', async () => {
    const id = String((await collection('DATAPACKS').insertOne({
      Network: 'MTN', Size: '1GB', Amount: '₦280.0', dataId: 7, active: true, CreatedAt: new Date(),
    })).insertedId);

    await post({
      collection: 'data-plans',
      decisions: [{ action: 'attach', id, fields: { vtpassCode: 'mtn-1gb-3500', amount: 9999, active: false } }],
    });

    const after = await collection('DATAPACKS').findOne({});
    expect(after.Amount).toBe('₦280.0');
    expect(after.active).toBe(true);
  });

  it('reports a failed decision without aborting the batch', async () => {
    const res = await post({
      collection: 'data-plans',
      decisions: [
        created(),
        { action: 'create', fields: { network: 'MTN', size: '2GB' } }, // no amount, no identifier
        created({ vtpassCode: 'mtn-2gb-1000' }),
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
    expect(res.body.failed).toBe(1);
    expect(res.body.results[1].ok).toBe(false);
    expect(res.body.results[1].error).toBeTruthy();
    expect(await collection('DATAPACKS').countDocuments({})).toBe(2);
  });

  it('rejects a collection that cannot be imported into', async () => {
    const res = await post({ collection: 'atc', decisions: [created()] });
    expect(res.status).toBe(422);
  });

  it('refuses more decisions than the cap', async () => {
    const decisions = Array.from({ length: 201 }, (_, i) => created({ vtpassCode: `mtn-${i}` }));
    const res = await post({ collection: 'data-plans', decisions });
    expect(res.status).toBe(422);
    expect(await collection('DATAPACKS').countDocuments({})).toBe(0);
  });

  it('fails only the decision whose row does not exist', async () => {
    const res = await post({
      collection: 'data-plans',
      decisions: [{ action: 'attach', id: '507f1f77bcf86cd799439011', fields: { vtpassCode: 'x' } }, created()],
    });
    expect(res.body.failed).toBe(1);
    expect(res.body.created).toBe(1);
  });

  // Fix round 1. CABLESPLAN has no provider-id column of its own -- it links
  // to CABLES through a lowercase `category` string, and only
  // cableContextForWrite (shared with ordinary CRUD) can derive it.
  it('links an imported cable plan to its provider', async () => {
    const providerId = String((await collection('CABLES').insertOne({
      CableName: 'GOTV', img: 'g.png', CableID: 1, active: true, CreatedAt: new Date(),
    })).insertedId);

    const res = await post({
      collection: 'cable-plans',
      decisions: [{
        action: 'create',
        fields: { name: 'GOtv Max', price: 4150, providerId, vtpassCode: 'dstv-padi' },
      }],
    });

    expect(res.body.created).toBe(1);
    const stored = await collection('CABLESPLAN').findOne({});
    expect(stored.category).toBe('gotv');
  });

  it('fails a cable-plan create whose providerId matches no provider', async () => {
    const res = await post({
      collection: 'cable-plans',
      decisions: [{
        action: 'create',
        fields: { name: 'X', price: 1, providerId: '507f1f77bcf86cd799439011', vtpassCode: 'x' },
      }],
    });

    expect(res.body.created).toBe(0);
    expect(res.body.failed).toBe(1);
    expect(await collection('CABLESPLAN').countDocuments({})).toBe(0);
  });

  // Fix round 1. A typo or missing action must not silently become the most
  // consequential branch (create).
  it('fails a decision whose action is not recognised, without aborting the batch', async () => {
    // Fields are a fully valid create payload on purpose: if an unrecognised
    // action silently fell through to create, this row would succeed and the
    // counts below would not catch it.
    const res = await post({
      collection: 'data-plans',
      decisions: [{ action: 'bogus', fields: created({ vtpassCode: 'mtn-bogus' }).fields }, created()],
    });

    expect(res.body.failed).toBe(1);
    expect(res.body.created).toBe(1);
    expect(res.body.results[0].ok).toBe(false);
    expect(await collection('DATAPACKS').countDocuments({})).toBe(1);
  });

  // Fix round 1. The write itself, not the console's stale hint, is what must
  // stop a provider code from ending up on two rows.
  it('refuses to write a provider code that already sits on another row', async () => {
    const res = await post({ collection: 'data-plans', decisions: [created(), created()] });
    expect(res.body.created).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(await collection('DATAPACKS').countDocuments({})).toBe(1);
  });

  it('refuses an attach whose code sits on a different row', async () => {
    await post({ collection: 'data-plans', decisions: [created()] }); // owns mtn-1gb-3500
    const otherId = String((await collection('DATAPACKS').insertOne({
      Network: 'MTN', Size: '2GB', Amount: '₦280.0', dataId: 9, active: true, CreatedAt: new Date(),
    })).insertedId);

    const res = await post({
      collection: 'data-plans',
      decisions: [{ action: 'attach', id: otherId, fields: { vtpassCode: 'mtn-1gb-3500' } }],
    });

    expect(res.body.failed).toBe(1);
    const other = await collection('DATAPACKS').findOne({ dataId: 9 });
    expect(other.vtpassCode).toBeUndefined();
  });

  // Final review C1. An attach fills an empty provider code and never replaces
  // one: a stale preview, or an earlier decision in the same batch, must not
  // be able to repoint a plan a customer can already buy.
  it('refuses an attach that would overwrite a different code already on the row', async () => {
    const id = String((await collection('DATAPACKS').insertOne({
      Network: 'MTN', Size: '3GB', Amount: '₦1000.0', dataId: 11, vtpassCode: 'mtn-code-a',
      active: true, CreatedAt: new Date(),
    })).insertedId);

    const res = await post({
      collection: 'data-plans',
      decisions: [{ action: 'attach', id, fields: { vtpassCode: 'mtn-code-b' } }],
    });

    expect(res.body.attached).toBe(0);
    expect(res.body.failed).toBe(1);
    expect(res.body.results[0].ok).toBe(false);
    expect((await collection('DATAPACKS').findOne({})).vtpassCode).toBe('mtn-code-a');
  });

  // Also the C1 guard's other half: re-confirming the code a row already holds
  // is not a change, so the guard must not refuse it.
  it('allows an attach that writes the same code back onto the row that already holds it', async () => {
    await post({ collection: 'data-plans', decisions: [created()] });
    const row = await collection('DATAPACKS').findOne({ vtpassCode: 'mtn-1gb-3500' });

    const res = await post({
      collection: 'data-plans',
      decisions: [{ action: 'attach', id: String(row._id), fields: { vtpassCode: 'mtn-1gb-3500' } }],
    });

    expect(res.body.attached).toBe(1);
    expect(res.body.failed).toBe(0);
  });
});
