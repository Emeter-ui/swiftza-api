import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const { ObjectId } = require('mongodb');
const base = require('../../src/repositories/base');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

describe('repositories/base serialiser', () => {
  it('converts a Date to the Firestore Timestamp wire shape', () => {
    // 2026-09-01T00:00:00.500Z
    const date = new Date(1788307200500);
    expect(base.toWireTimestamp(date)).toEqual({
      seconds: 1788307200,
      nanoseconds: 500000000,
    });
  });

  it('maps _id to docid and removes _id', () => {
    const out = base.serializeDoc({ _id: 'abc', name: 'MTN' });
    expect(out).toEqual({ docid: 'abc', name: 'MTN' });
    expect(out._id).toBeUndefined();
  });

  it('stringifies an ObjectId _id', () => {
    const oid = new ObjectId();
    expect(base.serializeDoc({ _id: oid, n: 1 }).docid).toBe(oid.toHexString());
  });

  it('converts nested and array Dates', () => {
    const date = new Date(1788307200000);
    const out = base.serializeDoc({ _id: 'x', meta: { at: date }, list: [{ at: date }] });
    expect(out.meta.at).toEqual({ seconds: 1788307200, nanoseconds: 0 });
    expect(out.list[0].at).toEqual({ seconds: 1788307200, nanoseconds: 0 });
  });

  it('returns null for a missing document', () => {
    expect(base.serializeDoc(null)).toBeNull();
  });

  it('preserves null values rather than dropping them', () => {
    expect(base.serializeDoc({ _id: 'x', email: null })).toEqual({ docid: 'x', email: null });
  });
});

describe('repositories/base queries', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(clearTestMongo);

  it('inserts and reads back with docid, sorted by CreatedAt', async () => {
    await base.insert('DATAPACKS', { Network: 'MTN', dataId: 1 });
    await base.insert('DATAPACKS', { Network: 'GLO', dataId: 2 });

    const asc = await base.all('DATAPACKS', 'asc');
    expect(asc.map((d) => d.Network)).toEqual(['MTN', 'GLO']);

    const desc = await base.all('DATAPACKS', 'desc');
    expect(desc.map((d) => d.Network)).toEqual(['GLO', 'MTN']);
    expect(asc[0].docid).toEqual(expect.any(String));
  });

  it('stamps CreatedAt on insert and serialises it as a timestamp', async () => {
    await base.insert('DATAPACKS', { Network: 'MTN' });
    const [doc] = await base.all('DATAPACKS');
    expect(doc.CreatedAt).toEqual({
      seconds: expect.any(Number),
      nanoseconds: expect.any(Number),
    });
  });

  it('returns null from byId for a malformed ObjectId instead of throwing', async () => {
    expect(await base.byId('DATAPACKS', 'not-a-valid-object-id')).toBeNull();
  });

  it('finds a document by an arbitrary field', async () => {
    await base.insert('DATAPACKS', { dataId: 42, Network: 'MTN' });
    expect((await base.findBy('DATAPACKS', 'dataId', 42)).Network).toBe('MTN');
    expect(await base.findBy('DATAPACKS', 'dataId', 99)).toBeNull();
  });

  it('round-trips a string _id through byId', async () => {
    await base.insertMany('USERS', [{ _id: 'uid-1', email: 'a@b.c' }]);
    expect((await base.byId('USERS', 'uid-1')).email).toBe('a@b.c');
  });

  it('updates by id', async () => {
    await base.insertMany('USERS', [{ _id: 'uid-1', balance: 0 }]);
    await base.update('USERS', 'uid-1', { balance: 500 });
    expect((await base.byId('USERS', 'uid-1')).balance).toBe(500);
  });
});
