const express = require('express');
const router = express.Router();
const notifications = require('../models/notifications');
const { asyncHandler, requireAuth } = require('../middleware');

router.get('/notifications', requireAuth, asyncHandler(async (req, res) => {
  const list = await notifications.load(req.user.uid);
  res.json({ notifications: list, unread: list.filter((n) => n.unread).length });
}));

router.post('/notifications/read', requireAuth, asyncHandler(async (req, res) => {
  await notifications.markRead(req.user.uid, req.body?.upTo);
  res.json({ status: 'success' });
}));

module.exports = router;
