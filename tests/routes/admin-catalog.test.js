import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const catalogRepo = require('../../src/repositories/catalog');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const token = (uid, account) => jwt.sign({ uid, account }, process.env.JWT_SECRET, { subject: uid });
const asAdmin = () => `Bearer ${token('admin-1', 'ADMIN')}`;
const asUser = () => `Bearer ${token('user-1', 'USER')}`;
// A token that CLAIMS admin for a uid whose stored row says USER.
const asForged = () => `Bearer ${token('user-1', 'ADMIN')}`;

describe('admin catalog CRUD', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('admin-1', { email: 'a@x.com', account: 'ADMIN' });
    await users.create('user-1', { email: 'u@x.com', account: 'USER' });
  });

  it('refuses a non-admin', async () => {
    expect((await request(app).get('/admin/networks').set('Authorization', asUser())).status).toBe(403);
  });

  it('refuses a token whose ADMIN claim disagrees with the stored role', async () => {
    // The role is re-read from the database, so a forged claim is not enough.
    expect((await request(app).get('/admin/networks').set('Authorization', asForged())).status).toBe(403);
  });

  it('refuses an unauthenticated request', async () => {
    expect((await request(app).get('/admin/networks')).status).toBe(401);
  });

  it('creates, lists, updates and deletes a network', async () => {
    const created = await request(app).post('/admin/networks').set('Authorization', asAdmin())
      .send({ name: 'Mtn', logo: 'i.png', networkId: 1 });
    expect(created.status).toBe(201);
    expect(created.body.item).toMatchObject({ name: 'Mtn', logo: 'i.png', networkId: 1 });
    const id = created.body.item.id;

    const listed = await request(app).get('/admin/networks').set('Authorization', asAdmin());
    expect(Array.isArray(listed.body)).toBe(true);
    expect(listed.body[0]).toMatchObject({ id, name: 'Mtn' });

    const updated = await request(app).put(`/admin/networks/${id}`).set('Authorization', asAdmin())
      .send({ name: 'MTN NG', logo: 'i.png', networkId: 1 });
    expect(updated.status).toBe(200);
    expect(updated.body.item.name).toBe('MTN NG');

    const deleted = await request(app).delete(`/admin/networks/${id}?confirm=true`).set('Authorization', asAdmin());
    expect(deleted.status).toBe(200);
    expect(await catalogRepo.list('NETWORKS')).toHaveLength(0);
  });

  it('refuses a delete without confirm=true and leaves the row present', async () => {
    const created = await request(app).post('/admin/networks').set('Authorization', asAdmin())
      .send({ name: 'Mtn', logo: 'i.png', networkId: 1 });
    const id = created.body.item.id;

    const res = await request(app).delete(`/admin/networks/${id}`).set('Authorization', asAdmin());
    expect(res.status).toBe(400);
    expect(await catalogRepo.list('NETWORKS')).toHaveLength(1);
  });

  it('404s a delete for an id that matched nothing', async () => {
    const res = await request(app)
      .delete('/admin/networks/64b7f9c2e1a4d3b2c1a0f9e8?confirm=true')
      .set('Authorization', asAdmin());
    expect(res.status).toBe(404);
  });

  it('rejects a create missing a required provider-side id', async () => {
    // Without dataId the row resolves in the catalog and then fails at purchase.
    const res = await request(app).post('/admin/data-plans').set('Authorization', asAdmin())
      .send({ network: 'MTN', type: 'SME', size: '1.0 GB', amount: 280 });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('dataId');
    expect(await catalogRepo.list('DATAPACKS')).toHaveLength(0);
  });

  it('stores a data plan amount as the display string samzeedatas renders', async () => {
    const res = await request(app).post('/admin/data-plans').set('Authorization', asAdmin())
      .send({ network: 'MTN', type: 'SME', size: '1.0 GB', validity: '30 days', amount: 280, dataId: 7 });
    expect(res.status).toBe(201);

    const [stored] = await catalogRepo.list('DATAPACKS');
    expect(stored.Amount).toBe('₦280.0');
    expect(stored.dataId).toBe(7);
    // And it reads back as a number for the admin form.
    expect(res.body.item.amount).toBe(280);
  });

  it('stores an ATC commissionRate as a percent', async () => {
    await request(app).post('/admin/atc').set('Authorization', asAdmin())
      .send({ network: 'MTN', payoutNumber: '08000000000', commissionRate: 0.1 });

    const [stored] = await catalogRepo.list('ATC');
    expect(stored.percent).toBe(10);
  });

  it('resolves a cable plan providerId to a lowercase category', async () => {
    const provider = await request(app).post('/admin/cables').set('Authorization', asAdmin())
      .send({ name: 'GOTV', logo: 'g.png', cableId: 1 });

    const plan = await request(app).post('/admin/cable-plans').set('Authorization', asAdmin())
      .send({ name: 'GOtv Max', price: 4150, planCode: 2, providerId: provider.body.item.id });

    expect(plan.status).toBe(201);
    const [stored] = await catalogRepo.list('CABLESPLAN');
    expect(stored.category).toBe('gotv');
    // And the read maps back to the provider id the page filters on.
    expect(plan.body.item.providerId).toBe(provider.body.item.id);
  });

  it('rejects a cable plan whose providerId matches no provider', async () => {
    const res = await request(app).post('/admin/cable-plans').set('Authorization', asAdmin())
      .send({ name: 'X', price: 1, planCode: 1, providerId: '64b7f9c2e1a4d3b2c1a0f9e8' });
    expect(res.status).toBe(422);
  });

  it('flips active via a partial PUT without clobbering the rest of the row', async () => {
    // useCrud's toggleActive control sends PUT with a body of only { active },
    // relied on by every AdminCatalog tab.
    const created = await request(app).post('/admin/networks').set('Authorization', asAdmin())
      .send({ name: 'Mtn', logo: 'i.png', networkId: 1 });
    const id = created.body.item.id;

    const res = await request(app).put(`/admin/networks/${id}`).set('Authorization', asAdmin())
      .send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ id, name: 'Mtn', logo: 'i.png', networkId: 1, active: false });

    const [stored] = await catalogRepo.list('NETWORKS');
    expect(stored.name).toBe('Mtn');
    expect(stored.id).toBe(1);
    expect(stored.active).toBe(false);
  });

  it('flips active via a partial PUT on a cable plan, preserving its resolved category', async () => {
    const provider = await request(app).post('/admin/cables').set('Authorization', asAdmin())
      .send({ name: 'GOTV', logo: 'g.png', cableId: 1 });
    const plan = await request(app).post('/admin/cable-plans').set('Authorization', asAdmin())
      .send({ name: 'GOtv Max', price: 4150, planCode: 2, providerId: provider.body.item.id });
    const id = plan.body.item.id;

    const res = await request(app).put(`/admin/cable-plans/${id}`).set('Authorization', asAdmin())
      .send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      id,
      name: 'GOtv Max',
      price: 4150,
      planCode: 2,
      providerId: provider.body.item.id,
      active: false,
    });

    const [stored] = await catalogRepo.list('CABLESPLAN');
    expect(stored.category).toBe('gotv');
    expect(stored.active).toBe(false);
  });

  it('still 422s a PUT that explicitly clears a required field', async () => {
    // Proves the merge did not turn assertRequired into a no-op: an operator
    // sending dataId: '' is blanking the field out, not omitting it.
    const created = await request(app).post('/admin/data-plans').set('Authorization', asAdmin())
      .send({ network: 'MTN', type: 'SME', size: '1.0 GB', amount: 280, dataId: 7 });
    const id = created.body.item.id;

    const res = await request(app).put(`/admin/data-plans/${id}`).set('Authorization', asAdmin())
      .send({ dataId: '' });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('dataId');

    const [stored] = await catalogRepo.list('DATAPACKS');
    expect(stored.dataId).toBe(7);
  });

  it('refuses an unknown collection segment', async () => {
    expect((await request(app).get('/admin/nonsense').set('Authorization', asAdmin())).status).toBe(404);
  });

  // A VTpass-only row cannot supply husmodata's numeric dataId. It is still a
  // real row -- it just cannot be served by husmodata, which the provider
  // routing coverage gate catches at activation time rather than here.
  it('accepts a data plan carrying only a vtpass code', async () => {
    const res = await request(app).post('/admin/data-plans').set('Authorization', asAdmin())
      .send({ network: 'MTN', size: '1GB', validity: '30 days', amount: 1150, vtpassCode: 'mtn-1gb-3500' });

    expect(res.status).toBe(201);
    expect(res.body.item.vtpassCode).toBe('mtn-1gb-3500');
    expect(res.body.item.dataId).toBeNull();
  });

  it('still accepts a husmodata-only data plan', async () => {
    const res = await request(app).post('/admin/data-plans').set('Authorization', asAdmin())
      .send({ network: 'MTN', size: '1GB', validity: '30 days', amount: 280, dataId: 7 });
    expect(res.status).toBe(201);
  });

  // Relaxing the rule must not remove it. A row with NEITHER provider's
  // identifier is unsellable by anyone and is still refused.
  it('rejects a data plan carrying neither provider identifier', async () => {
    const res = await request(app).post('/admin/data-plans').set('Authorization', asAdmin())
      .send({ network: 'MTN', size: '1GB', validity: '30 days', amount: 280 });

    expect(res.status).toBe(422);
    expect(res.body.msg || res.body.message).toMatch(/dataId|vtpassCode/);
  });

  it('still requires the non-identifier fields', async () => {
    const res = await request(app).post('/admin/data-plans').set('Authorization', asAdmin())
      .send({ size: '1GB', vtpassCode: 'mtn-1gb-3500' });
    expect(res.status).toBe(422);
  });

  it('accepts a cable plan carrying only a vtpass code', async () => {
    const cable = await request(app).post('/admin/cables').set('Authorization', asAdmin())
      .send({ name: 'DStv', cableId: 1 });
    const res = await request(app).post('/admin/cable-plans').set('Authorization', asAdmin())
      .send({ name: 'Padi', price: 4400, providerId: cable.body.item.id, vtpassCode: 'dstv-padi' });
    expect(res.status).toBe(201);
  });

  // Documents the real contract rather than an assumed one: a single-provider
  // row created through ordinary CRUD IS active immediately. The relaxation does
  // not make it inactive, and nothing downstream should assume it does -- what
  // protects the customer is the purchase path refusing before funds move.
  it('creates a single-provider row active, not inactive', async () => {
    const res = await request(app).post('/admin/data-plans').set('Authorization', asAdmin())
      .send({ network: 'MTN', size: '1GB', validity: '30 days', amount: 1150, vtpassCode: 'mtn-1gb-3500' });

    expect(res.status).toBe(201);
    expect(res.body.item.active).toBe(true);
    expect(res.body.item.dataId).toBeNull();
  });
});
