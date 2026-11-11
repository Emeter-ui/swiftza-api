import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const request = require('supertest');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const { authfunc } = require('../../src/services/index');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

// `vi.mock('../../src/services/index', ...)` cannot intercept the module as
// consumed by app.js: every file under src/ is authored in CommonJS, and
// Vitest's mock registry only intercepts static ESM `import` statements, not
// `require()` calls made from within already-loaded CommonJS modules
// (verified directly: the mock factory is never invoked when the module is
// reached through app.js's require chain, regardless of pool). `authfunc` is
// a singleton object shared through Node's require cache, so its methods are
// stubbed in place instead — the route files hold a reference to this exact
// object.
function stubAuthfunc() {
  vi.spyOn(authfunc, 'signup').mockImplementation(async (email) => ({ user: { uid: `uid-for-${email}` } }));
  vi.spyOn(authfunc, 'login').mockImplementation(async (email) => ({ user: { uid: `uid-for-${email}` } }));
  vi.spyOn(authfunc, 'signout').mockImplementation(async () => {});
  vi.spyOn(authfunc, 'reset').mockImplementation(async () => {});
}

describe('signup / login / userData', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    stubAuthfunc();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a user document without storing the password', async () => {
    const res = await request(app)
      .post('/signup')
      .send({ email: 'a@b.c', passwd: 'secret123', fullname: 'A Person' });

    expect(res.status).toBe(201);
    const user = await users.findByUid('uid-for-a@b.c');
    expect(user).toMatchObject({ email: 'a@b.c', account: 'USER', balance: 0, fullname: 'A Person' });
    expect(user.passwd).toBeUndefined();
  });

  it('issues a session token on login', async () => {
    await users.create('uid-for-a@b.c', { email: 'a@b.c', account: 'USER', balance: 0 });

    const res = await request(app).post('/login').send({ email: 'a@b.c', passwd: 'secret123' });

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.data).toEqual({ uid: 'uid-for-a@b.c', account: 'USER' });
  });

  it('returns the profile with an id field and no sensitive fields', async () => {
    // The stubbed authfunc maps an email to `uid-for-<email>`, so the seeded
    // uid must match what /login will resolve.
    await users.create('uid-for-a@b.c', {
      email: 'a@b.c', account: 'USER', balance: 500,
      passwd: 'leaked', paystacksecretkey: 'sk_live_leaked',
    });
    const login = await request(app).post('/login').send({ email: 'a@b.c', passwd: 'x' });

    const res = await request(app)
      .post('/userData')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('uid-for-a@b.c');
    expect(res.body.balance).toBe(500);
    expect(res.body.passwd).toBeUndefined();
    expect(res.body.paystacksecretkey).toBeUndefined();
    // /userData has always returned the id as `id`, never `docid`.
    expect(res.body.docid).toBeUndefined();
  });

  it('rejects userData without a session', async () => {
    expect((await request(app).post('/userData').send({})).status).toBe(401);
  });

  it('returns a 500 AppError instead of user: null when the credential verifies but no USERS document exists', async () => {
    // Simulates signup's Firebase write succeeding while its Mongo write did
    // not (the two are not transactional) — no users.create() call here.
    // Previously this fell through to a 200 with user: null, which the Nuxt
    // store reads as a normal (if incomplete) login, so the account was
    // silently locked out forever with no visible error.
    const res = await request(app).post('/login').send({ email: 'ghost@x.com', passwd: 'whatever' });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('error');
    expect(res.body.user).toBeUndefined();
  });
});
