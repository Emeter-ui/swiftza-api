const express = require('express');
const router = express.Router();
const { collection } = require('../../services/mongo');
const settings = require('../../repositories/settings');
const audit = require('../../models/audit');
const providers = require('../../providers');
const { SERVICE_COLUMNS, PLAN_COLUMNS, validateIdFor } = require('../../providers/ids');
const catalogRepo = require('../../repositories/catalog');
const { asyncHandler } = require('../../middleware');
const { validationFailed } = require('../../models/errors');

const SETTINGS_DOC = 'providers';

// Which collection must carry a mapping before a service can be routed.
const COVERAGE = {
  data: [['NETWORKS', 'service'], ['DATAPACKS', 'plan']],
  airtime: [['NETWORKS', 'service']],
  cable: [['CABLES', 'service'], ['CABLESPLAN', 'plan']],
  electricity: [['ELECTRICITY', 'service']],
  epin: [['EPIN', 'service']],
};

const columnFor = (providerName, kind, level) =>
  (level === 'plan' ? PLAN_COLUMNS : SERVICE_COLUMNS)[providerName]?.[kind] ?? null;

async function missingCount(name, column) {
  return collection(name).countDocuments({
    active: { $ne: false },
    $or: [{ [column]: { $exists: false } }, { [column]: null }, { [column]: '' }],
  });
}

async function coverageFor(providerName, service) {
  const gaps = [];
  for (const [name, level] of COVERAGE[service] ?? []) {
    const column = columnFor(providerName, service, level);
    if (!column) continue;
    const missing = await missingCount(name, column);
    if (missing > 0) gaps.push({ collection: name, column, missing });
  }
  return gaps;
}

// Shared by GET (reporting current routing) and PUT (reporting routing after
// a switch) so both return the same enriched shape. Previously PUT returned
// only providers.getRouting() ({ active, services }) while GET returned this
// full payload -- samzeenuxt/app/pages/admin/index.vue assigns the PUT
// response straight over the ref that GET originally populated, so after one
// successful switch `routing.available` (and supports/coverage) went
// undefined, blanking every service dropdown.
async function buildProvidersPayload() {
  const routing = await providers.getRouting();

  // loadConfig() swallows a database read failure and falls back to `{}`
  // for up to 60s, which makes a reverted-to-default routing look
  // indistinguishable from an intentional one. A direct read here (bypassing
  // that cache) surfaces a currently-failing database rather than silently
  // reporting the fallback as normal. It cannot see a blip that has already
  // resolved but is still cached — that needs loadConfig itself reworked,
  // which is out of scope here.
  let configWarning = null;
  try {
    await settings.get(SETTINGS_DOC);
  } catch (err) {
    configWarning = `Could not read provider settings from the database (${err.message}). Routing shown may be a stale fallback to defaults rather than the saved configuration.`;
  }

  const supports = {};
  const coverage = {};
  for (const name of providers.available) {
    const instance = await providers.describe(name);
    supports[name] = instance.supports;
    coverage[name] = {};
    for (const service of Object.keys(COVERAGE)) {
      const gaps = await coverageFor(name, service);
      coverage[name][service] = {
        missing: gaps.reduce((n, g) => n + g.missing, 0),
        gaps,
      };
    }
  }

  return {
    ...routing,
    available: providers.available,
    supports,
    coverage,
    ...(configWarning ? { configWarning } : {}),
  };
}

router.get(
  '/providers',
  asyncHandler(async (req, res) => {
    res.json(await buildProvidersPayload());
  })
);

router.put(
  '/providers',
  asyncHandler(async (req, res) => {
    const service = String(req.body.service ?? '').trim().toLowerCase();
    const provider = String(req.body.provider ?? '').trim().toLowerCase();

    if (!COVERAGE[service]) {
      throw validationFailed(`Unknown service "${service}"`, { service });
    }
    if (!providers.available.includes(provider)) {
      throw validationFailed(`Unknown provider "${provider}"`, { provider });
    }

    // Gate 1 — the adapter must declare the service.
    const instance = await providers.describe(provider);
    if (!instance.supports.includes(service)) {
      throw validationFailed(`${provider} does not support ${service}`, { provider, service });
    }

    // Gate 1.5 — the provider's own credentials must be present. Without this,
    // a provider with no secrets configured passes every other gate (Gate 3
    // has no preflight call for data/airtime/epin) and is accepted and
    // audited; the first customer purchase then throws from requireSecret
    // *inside* invoke -- after reserveFunds -- turning every purchase into a
    // reserve/reverse pair and a bare 500, while this endpoint reported
    // success. Checking here makes a missing secret a clean, free 422 like a
    // missing catalog column already is (Gate 2), instead of an expensive
    // failure discovered only after money moves.
    try {
      instance.assertConfigured();
    } catch (err) {
      throw validationFailed(
        `Cannot route ${service} to ${provider}: ${err.message}`,
        { provider, service }
      );
    }

    // Gate 2 — every sellable row must carry this provider's identifier.
    const gaps = await coverageFor(provider, service);
    if (gaps.length) {
      const detail = gaps
        .map((g) => `${g.missing} row(s) in ${g.collection} have no ${g.column}`)
        .join('; ');
      throw validationFailed(
        `Cannot route ${service} to ${provider}: ${detail}`,
        { gaps }
      );
    }

    // Gate 3 — a live read-only call, for the services that have one. A
    // timeout is a refusal: an unreachable provider is exactly what must not
    // start receiving traffic.
    await preflight(provider, service);

    const before = await providers.getProviderName(service);
    // Dot notation so this write touches only this service's key. A
    // read-merge-$set of the whole `overrides` object races: two admins
    // switching different services at once would have the second write
    // computed from a snapshot taken before the first landed, silently
    // reverting it with no error raised. `service` is validated against the
    // COVERAGE whitelist above, before this string is ever interpolated, so
    // it cannot carry attacker-controlled dots/operators into the key.
    await settings.set(SETTINGS_DOC, { [`overrides.${service}`]: provider });
    providers.refresh();

    await audit.record({
      action: 'provider.route',
      adminUid: req.user.uid,
      targetUid: null,
      details: { service, from: before, to: provider },
    });

    res.json(await buildProvidersPayload());
  })
);

async function preflight(providerName, service) {
  if (service !== 'cable' && service !== 'electricity') return;

  const stored = (await settings.get(SETTINGS_DOC)) || {};
  const sample = stored.preflight?.[service];
  if (!sample) {
    throw validationFailed(
      `Routing ${service} needs a pre-flight sample saved first`,
      { service }
    );
  }

  const instance = await providers.describe(providerName);
  try {
    const result =
      service === 'cable'
        ? await instance.validateIuc(await resolveSample(providerName, 'cable', sample))
        : await instance.validateMeter(await resolveSample(providerName, 'electricity', sample));
    if (!result || result.valid === false) {
      throw new Error(result?.message || 'provider rejected the sample');
    }
  } catch (err) {
    throw validationFailed(
      `Pre-flight against ${providerName} failed: ${err.message}`,
      { service, provider: providerName }
    );
  }
}

// The stored sample carries this system's internal ids (the same CableID /
// DiscoID a catalog row holds). Resolving them here means the pre-flight
// exercises the very mapping the switch is about to depend on. This uses
// validateIdFor (not serviceIdFor): for smeapi the validate and buy endpoints
// take the same numeric provider id, so the columns agree; for cheapdatahub
// cable validation takes a plan id rather than a provider id and diverges.
async function resolveSample(providerName, service, sample) {
  if (service === 'cable') {
    const rows = (await catalogRepo.list('CABLES')).filter((r) => r.active !== false);
    const doc = rows.find((r) => String(r.CableID) === String(sample.cableId));
    if (!doc) throw new Error(`no active CABLES row with CableID ${sample.cableId}`);
    return { smartCard: sample.smartCard, cableId: validateIdFor(providerName, 'cable', doc) };
  }
  const rows = (await catalogRepo.list('ELECTRICITY')).filter((r) => r.active !== false);
  const doc = rows.find((r) => String(r.DiscoID) === String(sample.discoId));
  if (!doc) throw new Error(`no active ELECTRICITY row with DiscoID ${sample.discoId}`);
  return {
    meterNumber: sample.meterNumber,
    discoId: validateIdFor(providerName, 'electricity', doc),
    meterType: sample.meterType || 'prepaid',
  };
}

// Editable rather than only settable directly in the database — without this
// route, cable and electricity can never pass gate 3.
router.put(
  '/providers/preflight',
  asyncHandler(async (req, res) => {
    const service = String(req.body.service ?? '').trim().toLowerCase();
    if (service !== 'cable' && service !== 'electricity') {
      throw validationFailed('Only cable and electricity take a pre-flight sample', { service });
    }
    // Same dot-notation treatment as the overrides write above: touch only
    // this service's key so a concurrent save of the other service's sample
    // cannot be clobbered by a stale read-merge. `service` is already
    // whitelisted above.
    await settings.set(SETTINGS_DOC, { [`preflight.${service}`]: req.body.sample || null });
    providers.refresh();
    const updated = (await settings.get(SETTINGS_DOC)) || {};
    res.json({ preflight: updated.preflight || {} });
  })
);

module.exports = router;
