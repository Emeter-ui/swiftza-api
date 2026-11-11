import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const asAdmin = () =>
  `Bearer ${jwt.sign({ uid: 'admin-1', account: 'ADMIN' }, process.env.JWT_SECRET, { subject: 'admin-1' })}`;
const asUser = () =>
  `Bearer ${jwt.sign({ uid: 'user-1', account: 'USER' }, process.env.JWT_SECRET, { subject: 'user-1' })}`;

describe('Waitlist Admin Routes', () => {
  beforeAll(startTestMongo);
  afterAll(stopTestMongo);

  beforeEach(async () => {
    await clearTestMongo();
    await users.create('admin-1', { email: 'admin@swiftza.app', account: 'ADMIN' });
    await users.create('user-1', { email: 'user@swiftza.app', account: 'USER' });
  });

  describe('GET /admin/waitlist', () => {
    it('refuses non-admin users', async () => {
      const res = await request(app).get('/admin/waitlist').set('Authorization', asUser());
      expect(res.status).toBe(403);
    });

    it('returns empty list when waitlist is empty', async () => {
      const res = await request(app).get('/admin/waitlist').set('Authorization', asAdmin());
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.total).toBe(0);
      expect(res.body.nextCursor).toBeNull();
    });

    it('returns waitlist items with pagination', async () => {
      const coll = collection('waitlist');
      await coll.insertMany([
        { _id: new ObjectId('600000000000000000000001'), email: 'first@test.com', joinedAt: new Date('2026-01-01T00:00:00Z') },
        { _id: new ObjectId('600000000000000000000002'), email: 'second@test.com', joinedAt: new Date('2026-01-02T00:00:00Z') },
        { _id: new ObjectId('600000000000000000000003'), email: 'third@test.com', joinedAt: new Date('2026-01-03T00:00:00Z') },
      ]);

      const res = await request(app)
        .get('/admin/waitlist?limit=2')
        .set('Authorization', asAdmin());

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.total).toBe(3);
      expect(res.body.items[0].email).toBe('third@test.com');
      expect(res.body.items[1].email).toBe('second@test.com');
      expect(res.body.nextCursor).toBe('600000000000000000000002');

      // Next page
      const res2 = await request(app)
        .get(`/admin/waitlist?limit=2&cursor=${res.body.nextCursor}`)
        .set('Authorization', asAdmin());

      expect(res2.status).toBe(200);
      expect(res2.body.items).toHaveLength(1);
      expect(res2.body.items[0].email).toBe('first@test.com');
      expect(res2.body.nextCursor).toBeNull();
    });

    it('supports search by email substring', async () => {
      const coll = collection('waitlist');
      await coll.insertMany([
        { email: 'alice@gmail.com', joinedAt: new Date() },
        { email: 'bob@yahoo.com', joinedAt: new Date() },
        { email: 'alice_work@corp.com', joinedAt: new Date() },
      ]);

      const res = await request(app)
        .get('/admin/waitlist?search=alice')
        .set('Authorization', asAdmin());

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items.every((i) => i.email.includes('alice'))).toBe(true);
    });

    it('supports all=true for bulk export', async () => {
      const coll = collection('waitlist');
      await coll.insertMany([
        { email: 'one@test.com', joinedAt: new Date() },
        { email: 'two@test.com', joinedAt: new Date() },
      ]);

      const res = await request(app)
        .get('/admin/waitlist?all=true')
        .set('Authorization', asAdmin());

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.total).toBe(2);
    });
  });

  describe('POST /admin/waitlist', () => {
    it('allows admin to add a new waitlist email', async () => {
      const res = await request(app)
        .post('/admin/waitlist')
        .set('Authorization', asAdmin())
        .send({ email: 'newperson@swiftza.app' });

      expect(res.status).toBe(201);
      expect(res.body.item.email).toBe('newperson@swiftza.app');
      expect(res.body.item.id).toBeTruthy();
      expect(res.body.item.joinedAt).toBeTruthy();

      const doc = await collection('waitlist').findOne({ email: 'newperson@swiftza.app' });
      expect(doc).toBeTruthy();
    });

    it('rejects invalid email address', async () => {
      const res = await request(app)
        .post('/admin/waitlist')
        .set('Authorization', asAdmin())
        .send({ email: 'invalid-email' });

      expect(res.status).toBe(422);
    });

    it('rejects duplicate email address', async () => {
      await collection('waitlist').insertOne({ email: 'dup@swiftza.app', joinedAt: new Date() });

      const res = await request(app)
        .post('/admin/waitlist')
        .set('Authorization', asAdmin())
        .send({ email: 'dup@swiftza.app' });

      expect(res.status).toBe(422);
    });
  });

  describe('DELETE /admin/waitlist/:id', () => {
    it('deletes an existing waitlist entry', async () => {
      const id = new ObjectId();
      await collection('waitlist').insertOne({ _id: id, email: 'del@swiftza.app', joinedAt: new Date() });

      const res = await request(app)
        .delete(`/admin/waitlist/${id.toHexString()}`)
        .set('Authorization', asAdmin());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const doc = await collection('waitlist').findOne({ _id: id });
      expect(doc).toBeNull();
    });

    it('returns 404 for non-existent id', async () => {
      const res = await request(app)
        .delete(`/admin/waitlist/${new ObjectId().toHexString()}`)
        .set('Authorization', asAdmin());

      expect(res.status).toBe(404);
    });
  });
});
