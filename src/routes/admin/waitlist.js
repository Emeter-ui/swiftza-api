const express = require('express');
const router = express.Router();
const { collection } = require('../../services/mongo');
const { ObjectId } = require('mongodb');
const { toIso } = require('../../presenters');
const { asyncHandler } = require('../../middleware');
const { validationFailed, AppError } = require('../../models/errors');

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toId(value) {
  if (!value) return null;
  if (value instanceof ObjectId) return value;
  const text = String(value);
  return ObjectId.isValid(text) ? new ObjectId(text) : text;
}

router.get(
  '/waitlist',
  asyncHandler(async (req, res) => {
    const coll = collection('waitlist');
    const query = {};

    if (req.query.search) {
      const q = String(req.query.search).trim();
      if (q) {
        query.email = { $regex: escapeRegex(q), $options: 'i' };
      }
    }

    const total = await coll.countDocuments(query);

    if (req.query.all === 'true') {
      const rows = await coll.find(query).sort({ joinedAt: -1, _id: -1 }).limit(5000).toArray();
      return res.json({
        items: rows.map((r) => ({
          id: r._id instanceof ObjectId ? r._id.toHexString() : String(r._id),
          email: r.email,
          joinedAt: toIso(r.joinedAt || r.CreatedAt),
        })),
        total,
        nextCursor: null,
      });
    }

    const parsed = Number(req.query.limit);
    const size = Math.min(Math.max(Number.isFinite(parsed) ? parsed : DEFAULT_PAGE, 1), MAX_PAGE);

    if (req.query.cursor) {
      const after = toId(req.query.cursor);
      if (after !== null) {
        query._id = { $lt: after };
      }
    }

    const rows = await coll
      .find(query)
      .sort({ _id: -1 })
      .limit(size + 1)
      .toArray();

    const hasMore = rows.length > size;
    const items = (hasMore ? rows.slice(0, size) : rows).map((r) => ({
      id: r._id instanceof ObjectId ? r._id.toHexString() : String(r._id),
      email: r.email,
      joinedAt: toIso(r.joinedAt || r.CreatedAt),
    }));

    res.json({
      items,
      total,
      nextCursor: hasMore ? items[items.length - 1].id : null,
    });
  })
);

router.post(
  '/waitlist',
  asyncHandler(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw validationFailed('Valid email address is required');
    }

    const coll = collection('waitlist');
    const existing = await coll.findOne({ email });
    if (existing) {
      throw validationFailed('Email is already on the waitlist');
    }

    const doc = { email, joinedAt: new Date() };
    const result = await coll.insertOne(doc);

    res.status(201).json({
      item: {
        id: result.insertedId.toHexString(),
        email: doc.email,
        joinedAt: doc.joinedAt.toISOString(),
      },
    });
  })
);

router.delete(
  '/waitlist/:id',
  asyncHandler(async (req, res) => {
    const _id = toId(req.params.id);
    if (!_id) {
      throw new AppError('NOT_FOUND', 'Waitlist entry not found', 404, { id: req.params.id });
    }

    const coll = collection('waitlist');
    const result = await coll.deleteOne({ _id });
    if (result.deletedCount === 0) {
      throw new AppError('NOT_FOUND', 'Waitlist entry not found', 404, { id: req.params.id });
    }

    res.json({ success: true, id: req.params.id });
  })
);

module.exports = router;
