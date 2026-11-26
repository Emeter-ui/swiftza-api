const express = require('express');
const router = express.Router();
const aiSettings = require('../../repositories/ai-settings');
const assistant = require('../../ai/assistant');
const appMap = require('../../ai/app-map');
const llm = require('../../ai/llm');
const audit = require('../../models/audit');
const { collection } = require('../../services/mongo');
const { request, OK } = require('../../models/http');
const { asyncHandler } = require('../../middleware');
const { validationFailed, AppError } = require('../../models/errors');

const PROVIDERS = ['openrouter', 'gemini'];

// Validates and coerces an admin patch. Unknown keys are dropped so the
// document cannot accumulate junk; every bound is a guard against a setting
// that would make the assistant useless or expensive.
function validate(patch, current) {
  const next = { ...current };
  const problems = [];
  const bad = (field, message) => problems.push({ field, message });
  const str = (k, max, { required = false } = {}) => {
    if (patch[k] === undefined) return;
    const v = String(patch[k] ?? '').trim();
    if (required && !v) return bad(k, 'This field cannot be empty');
    if (v.length > max) return bad(k, `Keep this under ${max} characters`);
    next[k] = v;
  };
  const num = (k, min, max, { int = true } = {}) => {
    if (patch[k] === undefined) return;
    const v = Number(patch[k]);
    if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) return bad(k, `Must be ${int ? 'a whole number ' : ''}between ${min} and ${max}`);
    next[k] = v;
  };
  const bool = (k) => { if (patch[k] !== undefined) next[k] = patch[k] === true; };

  bool('enabled'); bool('allowActions'); bool('useGeminiFallback'); bool('guestEnabled'); bool('guestQuickBuyEnabled');
  str('assistantName', 40, { required: true });
  str('greeting', 400, { required: true });
  str('openrouterModel', 120, { required: true });
  str('geminiModel', 80, { required: true });
  str('refusalMessage', 300, { required: true });
  str('supportContact', 200);
  str('maintenanceMessage', 300);
  str('extraInstructions', 4000);
  str('guestGreeting', 400, { required: true });
  num('temperature', 0, 1.5, { int: false });
  num('maxOutputTokens', 100, 4000);
  num('requestTimeoutMs', 5000, 60000);
  num('historyTurns', 0, 30);
  num('transactionsInContext', 5, 100);
  num('maxMessageChars', 100, 4000);
  num('rateLimitPerHour', 0, 1000);
  num('lowBalanceThreshold', 0, 100000);
  num('guestRateLimitPerHour', 0, 200);
  num('guestIpRateLimitPerHour', 0, 5000);
  num('guestMaxOrder', 100, 1000000);
  num('guestDailyLimitPerEmail', 100, 5000000);

  if (patch.primaryProvider !== undefined) {
    if (!PROVIDERS.includes(patch.primaryProvider)) bad('primaryProvider', 'Choose openrouter or gemini');
    else next.primaryProvider = patch.primaryProvider;
  }
  if (patch.openrouterFallbackModels !== undefined) {
    const list = (Array.isArray(patch.openrouterFallbackModels) ? patch.openrouterFallbackModels : String(patch.openrouterFallbackModels).split(','))
      .map((m) => String(m).trim()).filter(Boolean);
    if (list.length > 4) bad('openrouterFallbackModels', 'Up to 4 fallback models');
    else next.openrouterFallbackModels = list;
  }
  if (patch.actionGroups !== undefined) {
    const list = Array.isArray(patch.actionGroups) ? patch.actionGroups.filter((g) => appMap.GROUPS.includes(g)) : null;
    if (!list) bad('actionGroups', 'Must be a list');
    else next.actionGroups = list;
  }
  if (patch.suggestions !== undefined) {
    const list = (Array.isArray(patch.suggestions) ? patch.suggestions : []).map((s) => String(s).trim()).filter(Boolean);
    if (list.length > 6 || list.some((s) => s.length > 80)) bad('suggestions', 'Up to 6 suggestions, 80 characters each');
    else next.suggestions = list;
  }
  if (patch.guestSuggestions !== undefined) {
    const list = (Array.isArray(patch.guestSuggestions) ? patch.guestSuggestions : []).map((s) => String(s).trim()).filter(Boolean);
    if (list.length > 6 || list.some((s) => s.length > 80)) bad('guestSuggestions', 'Up to 6 suggestions, 80 characters each');
    else next.guestSuggestions = list;
  }
  if (patch.faqs !== undefined) {
    if (!Array.isArray(patch.faqs)) bad('faqs', 'Must be a list');
    else {
      const list = patch.faqs.map((f) => ({ q: String(f?.q ?? '').trim(), a: String(f?.a ?? '').trim() })).filter((f) => f.q || f.a);
      const incomplete = list.findIndex((f) => !f.q || !f.a);
      if (incomplete !== -1) bad('faqs', `FAQ #${incomplete + 1} needs both a question and an answer`);
      else if (list.length > 60) bad('faqs', 'Up to 60 FAQs');
      else if (list.some((f) => f.q.length > 300 || f.a.length > 1500)) bad('faqs', 'Questions up to 300 and answers up to 1500 characters');
      else next.faqs = list;
    }
  }
  if (next.primaryProvider === 'gemini' && !next.geminiModel) bad('geminiModel', 'Set a Gemini model to use Gemini as primary');

  return { next, problems };
}

const strip = ({ updatedAt, updatedBy, ...rest }) => rest;

router.get(
  '/ai/settings',
  asyncHandler(async (req, res) => {
    const s = await aiSettings.load();
    res.json({ settings: s, defaults: aiSettings.DEFAULTS, keys: llm.status(), groups: appMap.GROUPS, routes: appMap.ROUTES });
  })
);

router.put(
  '/ai/settings',
  asyncHandler(async (req, res) => {
    const current = strip(await aiSettings.load());
    const { next, problems } = validate(req.body?.settings || req.body || {}, current);
    if (problems.length) throw validationFailed(problems[0].message, { problems });
    const saved = await aiSettings.save(next, req.user.uid);
    await audit.record({ action: 'ai.settings.update', adminUid: req.user.uid, details: { keys: Object.keys(req.body?.settings || req.body || {}) } });
    res.json({ settings: saved, keys: llm.status() });
  })
);

router.post(
  '/ai/settings/reset',
  asyncHandler(async (req, res) => {
    const saved = await aiSettings.save({ ...aiSettings.DEFAULTS }, req.user.uid);
    await audit.record({ action: 'ai.settings.reset', adminUid: req.user.uid });
    res.json({ settings: saved, keys: llm.status() });
  })
);

// Runs a real conversation turn, optionally with unsaved settings and as a
// chosen customer, and returns the provider/model/latency used. Logged with
// dryRun so it does not count toward anyone's hourly quota.
router.post(
  '/ai/test',
  asyncHandler(async (req, res) => {
    const current = strip(await aiSettings.load());
    const { next, problems } = validate(req.body?.settings || {}, current);
    if (problems.length) throw validationFailed(problems[0].message, { problems });
    const uid = String(req.body?.asUid || req.user.uid);
    if (!(await collection('USERS').findOne({ _id: uid }))) throw new AppError('USER_NOT_FOUND', 'No customer with that id', 404);
    res.json(await assistant.chat({ uid, message: req.body?.message, history: req.body?.history, settingsOverride: { ...next, enabled: true }, dryRun: true }));
  })
);

router.get(
  '/ai/logs',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const filter = {};
    if (req.query.uid) filter.uid = String(req.query.uid);
    if (req.query.filter === 'errors') filter.error = { $exists: true };
    if (req.query.filter === 'out-of-scope') filter.inScope = false;
    if (req.query.filter === 'fallback') filter['failures.0'] = { $exists: true };
    const rows = await collection(assistant.LOGS).find(filter).sort({ CreatedAt: -1 }).limit(limit).toArray();
    res.json(rows.map(({ _id, ...r }) => ({ id: String(_id), ...r })));
  })
);

router.get(
  '/ai/stats',
  asyncHandler(async (req, res) => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [row] = await collection(assistant.LOGS).aggregate([
      { $match: { CreatedAt: { $gte: since }, dryRun: { $ne: true } } },
      {
        $group: {
          _id: null,
          messages: { $sum: 1 },
          users: { $addToSet: '$uid' },
          errors: { $sum: { $cond: [{ $ifNull: ['$error', false] }, 1, 0] } },
          outOfScope: { $sum: { $cond: [{ $eq: ['$inScope', false] }, 1, 0] } },
          fallbacks: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$failures', []] } }, 0] }, 1, 0] } },
          avgLatencyMs: { $avg: '$latencyMs' },
          tokensIn: { $sum: { $ifNull: ['$tokensIn', 0] } },
          tokensOut: { $sum: { $ifNull: ['$tokensOut', 0] } },
        },
      },
    ]).toArray();
    res.json({
      window: '7d',
      messages: row?.messages || 0,
      users: row?.users?.length || 0,
      errors: row?.errors || 0,
      outOfScope: row?.outOfScope || 0,
      fallbacks: row?.fallbacks || 0,
      avgLatencyMs: row?.avgLatencyMs ? Math.round(row.avgLatencyMs) : null,
      tokensIn: row?.tokensIn || 0,
      tokensOut: row?.tokensOut || 0,
    });
  })
);

let modelCache = { at: 0, items: [] };
router.get(
  '/ai/models',
  asyncHandler(async (req, res) => {
    if (Date.now() - modelCache.at < 6 * 60 * 60 * 1000 && modelCache.items.length) return res.json({ items: modelCache.items });
    const r = await request('https://openrouter.ai/api/v1/models', { timeoutMs: 15000 });
    if (r.outcome !== OK || !Array.isArray(r.body?.data)) throw new AppError('PROVIDER_UNAVAILABLE', 'Could not load the OpenRouter model list', 503);
    modelCache = {
      at: Date.now(),
      items: r.body.data.map((m) => ({
        id: m.id, name: m.name, context: m.context_length,
        promptPrice: m.pricing?.prompt != null ? Number(m.pricing.prompt) * 1e6 : null,
        completionPrice: m.pricing?.completion != null ? Number(m.pricing.completion) * 1e6 : null,
      })).sort((a, b) => a.id.localeCompare(b.id)),
    };
    res.json({ items: modelCache.items });
  })
);

module.exports = router;
module.exports.validate = validate;
