// Catalog import, split into a read that contacts the provider and a write
// that does not.
//
// `preview` fetches from SME API, prices, parses and proposes — and writes
// nothing, exactly like the discovery routes it sits beside. `apply` (below)
// receives the operator's confirmed decisions and never contacts the provider
// at all. That split is the whole safety argument: the request that writes
// carries values a human approved, not a provider reference, so an upstream
// response cannot on its own put a sellable row in the catalog.
//
// Only data-plans can be imported via API discovery (SME API exposes a flat
// dataplans list). Cable plans, exam pins, networks, cables and electricity
// IDs have no equivalent discovery endpoint and must be entered through the
// admin CRUD.
const express = require('express');
const router = express.Router();
const providers = require('../../providers');
const catalogRepo = require('../../repositories/catalog');
const base = require('../../repositories/base');
const { collection } = require('../../services/mongo');
const { ADMIN_COLLECTIONS, assertRequired } = require('../../presenters/admin');
const { priceFrom, parseVariation, proposeAction, refuseSharedMatches } = require('../../models/import-plan');
const { asyncHandler } = require('../../middleware');
const { validationFailed, providerUnavailable, AppError } = require('../../models/errors');
const { cableContextForWrite } = require('./catalog');

const MAX_DECISIONS = 200;

// Which collections can be imported into and how a proposed row is built.
// Only data-plans is supported: SME API's /api/dataplans/ is the only
// discovery endpoint available. `matchOn` / `exactOn` / `label` read
// PRESENTED rows (the friendly field names ADMIN_COLLECTIONS[...].present()
// emits), not storage columns. `level: 'dataplans'` tells the preview handler
// to call smeapi.listDataPlans() rather than a tiered service/variation API.
const IMPORT_TARGETS = Object.assign(Object.create(null), {
  'data-plans': {
    level: 'dataplans',
    codeField: 'smeapiDataPlanId',
    priced: true,
    matchOn: ['network', 'size'],
    exactOn: ['validity'],
    label: (r) => [r.network, r.size].filter(Boolean).join(' '),
    build: (parsed, price, code, source) => ({
      network: source.network || parsed.network,
      size: parsed.size,
      validity: parsed.validity,
      amount: price,
      smeapiDataPlanId: code,
      type: null,
    }),
  },
});

function targetFor(segment) {
  const target = IMPORT_TARGETS[segment];
  if (!target) {
    throw validationFailed(`Cannot import into "${segment}"`, {
      collection: segment,
      importable: Object.keys(IMPORT_TARGETS),
    });
  }
  return { target, config: ADMIN_COLLECTIONS[segment] };
}

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

router.get(
  '/import/preview',
  asyncHandler(async (req, res) => {
    const segment = String(req.query.collection ?? '').trim();
    const markup = num(req.query.markup, 0);
    const round = num(req.query.round, 0);

    // Validated BEFORE the provider is contacted, so a bad request costs
    // nothing upstream.
    const { target, config } = targetFor(segment);

    // Fetch the flat plan list from SME API. describe(), not getProvider():
    // the operator must be able to preview while the provider is not yet
    // serving traffic.
    const smeapi = await providers.describe('smeapi');
    const out = await smeapi.listDataPlans();
    if (!out.ok) throw providerUnavailable(out.message || 'Could not reach SME API');

    // Each item from SME API: { id, network, name, type, validity, amount }
    // `code` is the numeric plan id that the row will store as smeapiDataPlanId.
    // `amount` is the provider's user_price — the cost side of the margin.
    const sources = out.items.map((i) => ({
      code: i.id,
      name: i.name,
      amount: i.amount,
      network: i.network,
    }));

    // Presented rows, so matching compares friendly field names.
    const rows = (await catalogRepo.list(config.collection)).map((d) => config.present(d));

    const proposals = sources.map((source) => {
      // parseVariation reads size and validity from the plan name. network
      // comes directly from the API so it takes precedence over the parsed
      // fallback.
      const parsed = parseVariation(source, null);
      const cost = source.amount;
      const price = target.priced ? priceFrom(cost, markup, round) : null;
      const code = source.code;
      const decision = proposeAction(
        { ...parsed, network: source.network || parsed.network, name: source.name },
        code,
        rows,
        target
      );

      return {
        sourceCode: source.code,
        sourceName: source.name,
        sourceNetwork: source.network,
        cost: Number.isFinite(cost) ? cost : null,
        proposed: target.build(parsed, price, code, source),
        ...decision,
        noMargin: target.priced && (price == null || price <= cost),
      };
    });

    const items = refuseSharedMatches(proposals);

    res.json({
      collection: segment,
      markup,
      round,
      items,
      summary: {
        total: items.length,
        create: items.filter((i) => i.action === 'create' && !i.alreadyImported).length,
        attach: items.filter((i) => i.action === 'attach').length,
        alreadyImported: items.filter((i) => i.alreadyImported).length,
      },
    });
  })
);

// A code already sitting on some OTHER row would let apply silently retarget
// that row's provider link, or duplicate it across two rows.
async function assertCodeAvailable(config, target, code, { index, ownId } = {}) {
  const clash = await collection(config.collection).findOne({
    [target.codeField]: String(code),
    ...(ownId ? { _id: { $ne: base.toId(ownId) } } : {}),
  });
  if (clash) {
    throw validationFailed(`${target.codeField} ${code} is already on another row`, { index });
  }
}

// The write half. Deliberately has no provider import in scope and makes no
// network call: every value it stores arrived in the request body, where the
// operator could see it. A test asserts fetch is never called from here.
router.post(
  '/import/apply',
  asyncHandler(async (req, res) => {
    const segment = String(req.body?.collection ?? '').trim();
    const decisions = Array.isArray(req.body?.decisions) ? req.body.decisions : [];

    const { target, config } = targetFor(segment);

    if (decisions.length > MAX_DECISIONS) {
      throw validationFailed(
        `An import applies at most ${MAX_DECISIONS} rows at a time`,
        { sent: decisions.length, max: MAX_DECISIONS }
      );
    }

    const results = [];
    for (const [index, decision] of decisions.entries()) {
      try {
        if (decision?.action === 'attach') {
          const id = String(decision.id ?? '');
          const existing = await catalogRepo.findById(config.collection, id);
          if (!existing) throw new AppError('NOT_FOUND', 'Record not found', 404, { id });

          const code = decision.fields?.[target.codeField];
          if (code === undefined || code === null || code === '') {
            throw validationFailed(`An attach must carry ${target.codeField}`, { index });
          }
          const held = String(existing[target.codeField] ?? '').trim();
          if (held !== '' && held !== String(code).trim()) {
            throw validationFailed(
              `This row already carries ${target.codeField} ${held}; an attach only fills an empty one`,
              { index, id }
            );
          }
          await assertCodeAvailable(config, target, code, { index, ownId: id });
          await base.update(config.collection, id, { [target.codeField]: String(code) });
          results.push({ index, action: 'attach', ok: true, id });
        } else if (decision?.action === 'create') {
          const body = { ...(decision?.fields ?? {}), active: false };
          assertRequired(config, body);

          const ctx = segment === 'cable-plans' ? await cableContextForWrite(body) : {};

          const code = body[target.codeField];
          if (code !== undefined && code !== null && code !== '') {
            await assertCodeAvailable(config, target, code, { index });
          }

          const id = await catalogRepo.insert(config.collection, config.toStored(body, ctx));
          results.push({ index, action: 'create', ok: true, id });
        } else {
          throw validationFailed(`Unknown action "${decision?.action}"`, { index });
        }
      } catch (err) {
        results.push({ index, action: decision?.action ?? 'create', ok: false, error: err.message });
      }
    }

    res.json({
      created: results.filter((r) => r.ok && r.action === 'create').length,
      attached: results.filter((r) => r.ok && r.action === 'attach').length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  })
);

module.exports = router;
module.exports.IMPORT_TARGETS = IMPORT_TARGETS;
module.exports.targetFor = targetFor;
module.exports.MAX_DECISIONS = MAX_DECISIONS;
