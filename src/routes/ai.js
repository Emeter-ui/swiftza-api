const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { asyncHandler, requireAuth, sessionIfPresent } = require('../middleware');
const assistant = require('../ai/assistant');
const transcriber = require('../ai/transcribe');
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

// Each voice note is a paid Gemini call, so it gets its own ceiling on top of
// the burst guard: plenty for real use, not enough to run up a bill.
const voiceHourly = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.uid || req.ip,
  validate: { keyGeneratorIpFallback: false },
  message: { status: 'error', code: 'AI_RATE_LIMITED', msg: "You've used voice a lot this hour. Please type for now." },
});

// Visitors share one tighter burst guard per network address; the hourly
// per-browser and per-address quotas are enforced by the assistant.
const visitorBurst = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => Boolean(req.user),
  message: { status: 'error', code: 'AI_RATE_LIMITED', msg: 'Slow down a little and try again in a minute.' },
});

// Voice fallback is signed-in only: each clip is a paid Gemini call.
router.post(
  '/ai/transcribe',
  requireAuth,
  burst,
  voiceHourly,
  asyncHandler(async (req, res) => {
    res.json(await transcriber.transcribe({ uid: req.user.uid, audio: req.body?.audio, mimeType: req.body?.mimeType }));
  })
);

router.get(
  '/ai/config',
  sessionIfPresent,
  asyncHandler(async (req, res) => {
    const s = await aiSettings.load();
    const common = { enabled: s.enabled, assistantName: s.assistantName, maxMessageChars: s.maxMessageChars };
    if (!req.user) {
      return res.json({
        ...common,
        signedIn: false,
        guestEnabled: s.guestEnabled,
        guestQuickBuy: s.guestEnabled && s.guestQuickBuyEnabled,
        greeting: s.enabled ? s.guestGreeting : s.maintenanceMessage,
        suggestions: s.guestEnabled ? s.guestSuggestions : [],
      });
    }
    const user = await users.findByUid(req.user.uid);
    const first = String(user?.fullname || user?.username || '').split(/\s+/)[0] || 'there';
    res.json({
      ...common,
      signedIn: true,
      greeting: (s.enabled ? s.greeting : s.maintenanceMessage).replace(/\{firstName\}/g, first),
      suggestions: s.suggestions,
    });
  })
);

router.post(
  '/ai/chat',
  sessionIfPresent,
  visitorBurst,
  burst,
  asyncHandler(async (req, res) => {
    res.json(await assistant.chat({
      uid: req.user?.uid || null,
      // A browser-chosen id: only used to count a visitor's messages, never to
      // look anything up.
      visitor: req.user ? null : req.get('x-visitor-id') || null,
      ip: req.user ? null : req.ip,
      message: req.body?.message,
      history: req.body?.history,
    }));
  })
);

module.exports = router;
