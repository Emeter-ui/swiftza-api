import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const request = require('supertest');
const app = require('../../src/app');
const catalogRepo = require('../../src/repositories/catalog');
const { authfunc } = require('../../src/services/index');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

// `vi.mock('../../src/services/index', ...)` cannot intercept the module as
// consumed by app.js: every file under src/ is authored in CommonJS, and
// Vitest's mock registry only intercepts static ESM `import` statements, not
// `require()` calls made from within already-loaded CommonJS modules
// (verified directly in a previous task: the mock factory is never invoked
// when the module is reached through app.js's require chain, regardless of
// pool). `authfunc` is a singleton object shared through Node's require
// cache, so its methods are stubbed in place instead — the route files hold
// a reference to this exact object.
function stubAuthfunc() {
  vi.spyOn(authfunc, 'signup').mockImplementation(async (email) => ({ user: { uid: `uid-for-${email}` } }));
}

describe('installer', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    stubAuthfunc();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports an empty object before installation', async () => {
    const res = await request(app).get('/setup');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('runs createadmin, migrate and finalsetup end to end', async () => {
    const created = await request(app)
      .post('/setup/createadmin')
      .send({ email: 'admin@x.com', passwd: 'secret123', appname: 'Samzee' });

    expect(created.status).toBe(201);
    const uid = created.body.uniqueId;

    const migrated = await request(app).post('/setup/migrate').send({
      collection: 'DATAPACKS',
      data: [{ dataId: 1, Network: 'MTN', Amount: '₦280.0', active: true }],
    });
    expect(migrated.status).toBe(200);
    expect(migrated.body.count).toBe(1);
    expect(await catalogRepo.list('DATAPACKS')).toHaveLength(1);

    const finalised = await request(app)
      .post('/setup/finalsetup')
      .send({ id: uid, setUpProcess: true });
    expect(finalised.status).toBe(200);

    const status = await request(app).get('/setup');
    expect(status.body).toMatchObject({ docid: uid, setUpProcess: true, account: 'ADMIN' });
    // The installer must never leak the admin's stored keys.
    expect(status.body.paystacksecretkey).toBeUndefined();
  });

  it('refuses a second admin once setup has completed', async () => {
    const created = await request(app)
      .post('/setup/createadmin')
      .send({ email: 'admin@x.com', passwd: 'secret123' });
    await request(app).post('/setup/finalsetup').send({ id: created.body.uniqueId, setUpProcess: true });

    const second = await request(app)
      .post('/setup/createadmin')
      .send({ email: 'other@x.com', passwd: 'secret123' });

    expect(second.status).toBe(409);
  });

  it('rejects migrating an unknown collection', async () => {
    const res = await request(app)
      .post('/setup/migrate')
      .send({ collection: 'TRANSACTIONS', data: [{ a: 1 }] });

    expect(res.status).toBe(422);
  });
});
