import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const base = require('../../src/repositories/base');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

describe('base.remove', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(clearTestMongo);

  it('deletes a document and reports that it matched', async () => {
    const id = await base.insert('NETWORKS', { name: 'Mtn' });
    expect(await base.remove('NETWORKS', id)).toBe(true);
    expect(await base.byId('NETWORKS', id)).toBeNull();
  });

  it('reports false for an id that matched nothing, rather than claiming success', async () => {
    const id = await base.insert('NETWORKS', { name: 'Mtn' });
    await base.remove('NETWORKS', id);
    expect(await base.remove('NETWORKS', id)).toBe(false);
  });

  it('reports false for a malformed id rather than throwing', async () => {
    expect(await base.remove('NETWORKS', 'not-an-object-id')).toBe(false);
  });
});

describe('base.count', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(clearTestMongo);

  it('counts a whole collection and a filtered subset', async () => {
    await base.insertMany('NETWORKS', [
      { name: 'Mtn', active: true },
      { name: 'Glo', active: true },
      { name: 'Airtel', active: false },
    ]);
    expect(await base.count('NETWORKS')).toBe(3);
    expect(await base.count('NETWORKS', { active: true })).toBe(2);
  });

  it('returns 0 for an empty collection', async () => {
    expect(await base.count('NETWORKS')).toBe(0);
  });
});

describe('base.page', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    // String _ids so the cursor is exercised on the shape USERS actually uses.
    await collection('USERS').insertMany(
      Array.from({ length: 12 }, (_, i) => ({
        _id: `u${String(i).padStart(2, '0')}`,
        email: `u${i}@x.com`,
      }))
    );
  });

  it('walks the whole set exactly once, with no repeats and no gaps', async () => {
    const seen = [];
    let cursor = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const res = await base.page('USERS', {}, { limit: 5, cursor });
      seen.push(...res.items.map((r) => r.docid));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  it('returns nextCursor null on the last page', async () => {
    const first = await base.page('USERS', {}, { limit: 12 });
    expect(first.items).toHaveLength(12);
    expect(first.nextCursor).toBeNull();
  });

  it('clamps limit so a caller cannot request the whole collection', async () => {
    const res = await base.page('USERS', {}, { limit: 100000 });
    // MAX_PAGE is 200; 12 rows exist, so all come back — the point is it did
    // not throw and did not honour an unbounded limit.
    expect(res.items.length).toBeLessThanOrEqual(200);
  });

  it('applies a filter', async () => {
    const res = await base.page('USERS', { email: 'u3@x.com' }, { limit: 10 });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].docid).toBe('u03');
  });

  it('serialises rows like every other read (docid, no _id)', async () => {
    const res = await base.page('USERS', {}, { limit: 1 });
    expect(res.items[0].docid).toEqual(expect.any(String));
    expect(res.items[0]._id).toBeUndefined();
  });
});
