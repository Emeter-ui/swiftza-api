const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { asyncHandler, requireAuth } = require('../middleware');
const assistant = require('../ai/assistant');
const aiSettings = require('../repositories/ai-settings');
const users = require('../repositories/users');

// A burst guard in front of the per-hour quota the assistant enforces itself.
const burst = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.uid || req.ip,
  validate: { keyGeneratorIpFallback: false },
  message: { status: 'error', code: 'AI_RATE_LIMITED', msg: 'Slow down a little and try again in a minute.' },
});

router.get(
  '/ai/config',
  requireAuth,
  asyncHandler(async (req, res) => {
    const s = await aiSettings.load();
    const user = await users.findByUid(req.user.uid);
    const first = String(user?.fullname || user?.username || '').split(/\s+/)[0] || 'there';
    res.json({
      enabled: s.enabled,
      assistantName: s.assistantName,
      greeting: (s.enabled ? s.greeting : s.maintenanceMessage).replace(/\{firstName\}/g, first),
      suggestions: s.suggestions,
      maxMessageChars: s.maxMessageChars,
    });
  })
);

router.post(
  '/ai/chat',
  requireAuth,
  burst,
  asyncHandler(async (req, res) => {
    res.json(await assistant.chat({ uid: req.user.uid, message: req.body?.message, history: req.body?.history }));
  })
);

module.exports = router;
