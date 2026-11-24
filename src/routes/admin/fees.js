const express = require('express');
const router = express.Router();
const fees = require('../../models/fees');
const feeRepo = require('../../repositories/fees');
const audit = require('../../models/audit');
const { collection } = require('../../services/mongo');
const { asyncHandler } = require('../../middleware');
const { validationFailed, AppError } = require('../../models/errors');

// Every write runs the full analyser over the WHOLE resulting rule set, not
// just the rule being edited -- an overlap is a property of two rules, so a
// rule can only be judged next to the others.
async function commit(req, next, action, details = {}) {
  const report = fees.analyse(next);
  if (!report.ok) {
    throw new AppError('FEE_CONFIG_INVALID', report.errors[0].message, 422, {
      errors: report.errors,
      warnings: report.warnings,
    });
  }
  const saved = await feeRepo.save(
    { settings: report.settings, rules: report.rules },
    { expectedVersion: req.body?.expectedVersion, adminUid: req.user.uid }
  );
  await audit.record({ action, adminUid: req.user.uid, details: { ...details, version: saved.version } });
  return { ...saved, warnings: report.warnings };
}

const findRule = (config, id) => {
  const idx = config.rules.findIndex((r) => r.id === id);
  if (idx === -1) throw new AppError('NOT_FOUND', 'Fee rule not found', 404, { id });
  return idx;
};

router.get(
  '/fees',
  asyncHandler(async (req, res) => {
    const config = await feeRepo.load();
    const report = fees.analyse(config);
    res.json({
      ...config,
      errors: report.errors,
      warnings: report.warnings,
      options: {
        methods: fees.METHODS,
        modes: fees.MODES,
        taxBases: fees.TAX_BASES,
        unmatchedPolicies: fees.UNMATCHED_POLICIES,
        channels: fees.CHANNELS,
        presets: Object.keys(fees.PRESETS),
      },
    });
  })
);

router.put(
  '/fees/settings',
  asyncHandler(async (req, res) => {
    const current = await feeRepo.load();
    const { settings, problems } = fees.normalizeSettings({ ...current.settings, ...(req.body?.settings || req.body || {}) });
    if (problems.length) throw validationFailed(problems[0].message, { problems });
    res.json(await commit(req, { ...current, settings }, 'fees.settings.update', { settings }));
  })
);

router.post(
  '/fees/rules',
  asyncHandler(async (req, res) => {
    const current = await feeRepo.load();
    const { rule, problems } = fees.normalizeRule(req.body?.rule || req.body || {}, { id: undefined });
    if (problems.length) throw validationFailed(problems[0].message, { problems });
    const out = await commit(req, { ...current, rules: [...current.rules, rule] }, 'fees.rule.create', { rule });
    res.status(201).json({ ...out, item: rule });
  })
);

router.put(
  '/fees/rules/:id',
  asyncHandler(async (req, res) => {
    const current = await feeRepo.load();
    const idx = findRule(current, req.params.id);
    const before = current.rules[idx];
    const patch = req.body?.rule || req.body || {};
    const { rule, problems } = fees.normalizeRule({ ...before, ...patch }, { id: before.id });
    if (problems.length) throw validationFailed(problems[0].message, { problems });
    const rules = current.rules.slice();
    rules[idx] = rule;
    const out = await commit(req, { ...current, rules }, 'fees.rule.update', { before, after: rule });
    res.json({ ...out, item: rule });
  })
);

router.delete(
  '/fees/rules/:id',
  asyncHandler(async (req, res) => {
    const current = await feeRepo.load();
    const idx = findRule(current, req.params.id);
    const removed = current.rules[idx];
    const rules = current.rules.filter((_, i) => i !== idx);
    res.json(await commit(req, { ...current, rules }, 'fees.rule.delete', { rule: removed }));
  })
);

// Replace the whole rule set at once (used by "apply preset" and bulk edit).
router.put(
  '/fees/rules',
  asyncHandler(async (req, res) => {
    const current = await feeRepo.load();
    if (!Array.isArray(req.body?.rules)) throw validationFailed('rules must be an array');
    const normalized = req.body.rules.map((r) => fees.normalizeRule(r, { id: r.id }));
    const bad = normalized.find((n) => n.problems.length);
    if (bad) throw validationFailed(`${bad.rule.name || 'Unnamed rule'}: ${bad.problems[0].message}`, { problems: bad.problems });
    res.json(await commit(req, { ...current, rules: normalized.map((n) => n.rule) }, 'fees.rules.replace', { count: normalized.length }));
  })
);

// Dry run: analyse a proposed configuration without saving it. The admin
// screen calls this on every edit so clashes show before Save is pressed.
router.post(
  '/fees/validate',
  asyncHandler(async (req, res) => {
    const current = await feeRepo.load();
    const proposed = {
      settings: { ...current.settings, ...(req.body?.settings || {}) },
      rules: Array.isArray(req.body?.rules) ? req.body.rules : current.rules,
    };
    const report = fees.analyse(proposed);
    res.json({ ok: report.ok, errors: report.errors, warnings: report.warnings });
  })
);

router.post(
  '/fees/simulate',
  asyncHandler(async (req, res) => {
    const current = await feeRepo.load();
    const config = {
      settings: { ...current.settings, ...(req.body?.settings || {}) },
      rules: Array.isArray(req.body?.rules) ? req.body.rules.map((r) => fees.normalizeRule(r, { id: r.id }).rule) : current.rules,
    };
    const method = req.body?.method || 'card';
    if (req.body?.amount !== undefined && req.body?.amount !== '') {
      try {
        return res.json({ ok: true, quote: fees.quote(config, { amount: Number(req.body.amount), method }) });
      } catch (err) {
        const message = err.code === 'FEE_CONFIG_CONFLICT' ? 'Clash: this amount matches more than one rule' : err.message;
        return res.json({ ok: false, code: err.code || 'ERROR', message });
      }
    }
    const points = Array.isArray(req.body?.points) ? req.body.points.map(Number) : undefined;
    res.json({ ok: true, table: fees.simulateTable(config, { method, points }) });
  })
);

router.get(
  '/fees/presets/:name',
  asyncHandler(async (req, res) => {
    const preset = fees.PRESETS[req.params.name];
    if (!preset) throw new AppError('NOT_FOUND', 'Unknown preset', 404);
    res.json({ rules: preset.map((r) => fees.normalizeRule(r).rule) });
  })
);

// Fee income from credits the engine has priced. Rows from before the engine
// existed carry no breakdown and are not counted.
router.get(
  '/fees/revenue',
  asyncHandler(async (req, res) => {
    const match = { mode: 'credit', totalFee: { $exists: true } };
    const range = {};
    if (req.query.from) range.$gte = new Date(String(req.query.from));
    if (req.query.to) {
      const to = new Date(String(req.query.to));
      to.setHours(23, 59, 59, 999);
      range.$lte = to;
    }
    if (Object.keys(range).length) match.CreatedAt = range;
    const rows = await collection('WALLETTRANSACTIONS').aggregate([
      { $match: match },
      {
        $group: {
          _id: { rule: '$feeRuleName', mode: '$feeMode' },
          count: { $sum: 1 },
          grossPaid: { $sum: '$grossPaid' },
          credited: { $sum: '$amount' },
          fee: { $sum: '$fee' },
          tax: { $sum: '$tax' },
          totalFee: { $sum: '$totalFee' },
        },
      },
      { $sort: { totalFee: -1 } },
    ]).toArray();
    const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const items = rows.map((r) => ({
      rule: r._id.rule || (r._id.mode === 'none' ? 'No fee' : 'Inferred'),
      mode: r._id.mode || 'none',
      count: r.count,
      grossPaid: r2(r.grossPaid),
      credited: r2(r.credited),
      fee: r2(r.fee),
      tax: r2(r.tax),
      totalFee: r2(r.totalFee),
    }));
    const totals = items.reduce((t, i) => ({
      count: t.count + i.count, grossPaid: r2(t.grossPaid + i.grossPaid), credited: r2(t.credited + i.credited),
      fee: r2(t.fee + i.fee), tax: r2(t.tax + i.tax), totalFee: r2(t.totalFee + i.totalFee),
    }), { count: 0, grossPaid: 0, credited: 0, fee: 0, tax: 0, totalFee: 0 });
    res.json({ items, totals });
  })
);

router.get(
  '/fees/history',
  asyncHandler(async (req, res) => {
    const rows = await collection('AUDITLOG')
      .find({ action: { $regex: '^fees\\.' } })
      .sort({ CreatedAt: -1 })
      .limit(50)
      .toArray();
    res.json(rows.map((r) => ({
      id: String(r._id), action: r.action, adminUid: r.adminUid, version: r.version ?? null,
      createdAt: r.CreatedAt, summary: r.rule?.name || r.after?.name || (r.settings ? 'Deposit limits' : r.count != null ? `${r.count} rules` : null),
    })));
  })
);

module.exports = router;
