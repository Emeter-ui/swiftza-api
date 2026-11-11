const { parsePrice } = require('../models/catalog');
const { validationFailed } = require('../models/errors');

// The admin page's AdminCatalog field configs use friendly names — `logo` for
// `img`, `name` for `CableName`, `amount` for `Amount`, `commissionRate` for
// `percent`. Admin CRUD reads and writes in those names, so each collection
// needs both a presenter and an inverse mapper.
//
// These are deliberately NOT the customer presenters in ./index.js: /catalog/*
// emits `image` where the admin form uses `logo`, and the customer contract has
// no need for the provider-side ids the admin must be able to set.

// samzeedatas renders DATAPACKS.Amount verbatim, so a bare number would change
// what customers see. Writes are formatted back into the display string. An
// unparseable value would otherwise fall through and store something
// meaningless, so it fails loudly instead.
function formatNairaAmount(value) {
  if (typeof value === 'string' && value.trim().startsWith('₦')) return value;
  const n = parsePrice(value);
  if (!Number.isFinite(n)) {
    throw validationFailed('amount must be a number', { field: 'amount', value });
  }
  if (n < 1) {
    throw validationFailed('amount must be at least 1', { field: 'amount', value });
  }
  return `₦${n}.0`;
}

const isActive = (d) => d.active !== false;
const activeOf = (b) => b.active !== false;
// A numeric field that arrives as a garbage string must fail loudly. Number()
// would yield NaN, which is valid BSON and writes silently; returning null
// instead would store exactly the unsellable row `required` exists to prevent.
const num = (v, field, { min } = {}) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw validationFailed(`${field} must be a number`, { field, value: v });
  }
  if (min !== undefined && n < min) {
    throw validationFailed(`${field} must be at least ${min}`, { field, value: v });
  }
  return n;
};
// SME API identifiers are opaque numbers and are optional: a row without one
// is valid until that service is routed to smeapi, which is what the coverage
// gate checks.
const text = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const key = (v) => String(v ?? '').trim().toLowerCase();

// The adapter names providers/index.js registers. Copied rather than imported:
// importing providers/index.js here would pull settings and mongo into a
// module that is otherwise a pure mapping layer. tests/presenters/admin.test.js
// asserts this list against providers.available, so the two cannot drift.
const PROVIDER_NAMES = new Set(['smeapi', 'cheapdatahub']);

const providerName = (v) => {
  const name = String(v ?? '').trim().toLowerCase();
  if (!PROVIDER_NAMES.has(name)) {
    throw validationFailed(`Unknown provider "${name}"`, { field: 'provider', value: v });
  }
  return name;
};

const ADMIN_COLLECTIONS = {
  networks: {
    collection: 'NETWORKS',
    required: ['name'],
    requiresOneOf: [['smeapiNetworkId'], ['cheapdatahubNetworkId']],
    present: (d) => ({
      id: d.docid,
      name: d.name ?? null,
      logo: d.img ?? null,
      smeapiNetworkId: d.smeapiNetworkId ?? null,
      cheapdatahubNetworkId: d.cheapdatahubNetworkId ?? null,
      active: isActive(d),
    }),
    toStored: (b) => ({
      name: b.name,
      img: b.logo ?? null,
      smeapiNetworkId: num(b.smeapiNetworkId, 'smeapiNetworkId', { min: 1 }),
      cheapdatahubNetworkId: num(b.cheapdatahubNetworkId, 'cheapdatahubNetworkId', { min: 1 }),
      active: activeOf(b),
    }),
  },

  'data-plans': {
    collection: 'DATAPACKS',
    required: ['network', 'amount'],
    requiresOneOf: [['smeapiDataPlanId'], ['cheapdatahubBundleId']],
    present: (d) => ({
      id: d.docid,
      network: d.Network ?? null,
      type: d.planType ?? null,
      size: d.Size ?? null,
      validity: d.Validity ?? null,
      amount: parsePrice(d.Amount),
      smeapiDataPlanId: d.smeapiDataPlanId ?? null,
      cheapdatahubBundleId: d.cheapdatahubBundleId ?? null,
      active: isActive(d),
    }),
    toStored: (b) => ({
      Network: b.network,
      planType: b.type ?? null,
      Size: b.size ?? null,
      Validity: b.validity ?? null,
      Amount: formatNairaAmount(b.amount),
      smeapiDataPlanId: num(b.smeapiDataPlanId, 'smeapiDataPlanId', { min: 1 }),
      cheapdatahubBundleId: num(b.cheapdatahubBundleId, 'cheapdatahubBundleId', { min: 1 }),
      active: activeOf(b),
    }),
  },

  cables: {
    collection: 'CABLES',
    required: ['name'],
    requiresOneOf: [['smeapiCableProviderId'], ['cheapdatahubValidatePlanId']],
    present: (d) => ({
      id: d.docid,
      name: d.CableName ?? null,
      logo: d.img ?? null,
      // CableID is the internal lookup key used by legacy routes.
      cableId: d.CableID ?? null,
      smeapiCableProviderId: d.smeapiCableProviderId ?? null,
      cheapdatahubValidatePlanId: d.cheapdatahubValidatePlanId ?? null,
      active: isActive(d),
    }),
    toStored: (b) => ({
      CableName: b.name,
      img: b.logo ?? null,
      CableID: num(b.cableId, 'cableId', { min: 1 }),
      smeapiCableProviderId: num(b.smeapiCableProviderId, 'smeapiCableProviderId', { min: 1 }),
      cheapdatahubValidatePlanId: num(b.cheapdatahubValidatePlanId, 'cheapdatahubValidatePlanId', { min: 1 }),
      active: activeOf(b),
    }),
  },

  // CABLESPLAN has no provider id column — it links to CABLES through a
  // lowercase `category` string. The route resolves providerId to the provider
  // document and passes its name in; the mapper lowercases it.
  'cable-plans': {
    collection: 'CABLESPLAN',
    required: ['name', 'price', 'providerId'],
    requiresOneOf: [['smeapiCablePlanId'], ['cheapdatahubPlanId']],
    present: (d, ctx = {}) => ({
      id: d.docid,
      name: d.CableplanName ?? null,
      price: parsePrice(d.amount),
      // CableplanID is kept as an internal id for existing integrations.
      planCode: d.CableplanID ?? null,
      providerId: ctx.providerId ?? null,
      smeapiCablePlanId: d.smeapiCablePlanId ?? null,
      cheapdatahubPlanId: d.cheapdatahubPlanId ?? null,
      active: isActive(d),
    }),
    toStored: (b, ctx = {}) => ({
      CableplanName: b.name,
      amount: num(b.price, 'price', { min: 1 }),
      CableplanID: num(b.planCode, 'planCode', { min: 1 }),
      category: key(ctx.providerName),
      smeapiCablePlanId: num(b.smeapiCablePlanId, 'smeapiCablePlanId', { min: 1 }),
      cheapdatahubPlanId: num(b.cheapdatahubPlanId, 'cheapdatahubPlanId', { min: 1 }),
      active: activeOf(b),
    }),
  },

  electricity: {
    collection: 'ELECTRICITY',
    required: ['name'],
    requiresOneOf: [['smeapiDiscoId'], ['cheapdatahubDiscoId']],
    present: (d) => ({
      id: d.docid,
      name: d.Disconame ?? null,
      logo: d.img ?? null,
      // DiscoID is the internal lookup key used by legacy routes.
      discoId: d.DiscoID ?? null,
      smeapiDiscoId: d.smeapiDiscoId ?? null,
      cheapdatahubDiscoId: d.cheapdatahubDiscoId ?? null,
      active: isActive(d),
    }),
    toStored: (b) => ({
      Disconame: b.name,
      img: b.logo ?? null,
      DiscoID: num(b.discoId, 'discoId', { min: 1 }),
      smeapiDiscoId: num(b.smeapiDiscoId, 'smeapiDiscoId', { min: 1 }),
      cheapdatahubDiscoId: num(b.cheapdatahubDiscoId, 'cheapdatahubDiscoId', { min: 1 }),
      active: activeOf(b),
    }),
  },

  epins: {
    collection: 'EPIN',
    required: ['name', 'unitPrice'],
    present: (d) => ({
      id: d.docid,
      name: d.examName ?? null,
      unitPrice: parsePrice(d.amount),
      logo: d.img ?? null,
      smeapiExamProviderId: d.smeapiExamProviderId ?? null,
      cheapdatahubProductId: d.cheapdatahubProductId ?? null,
      active: isActive(d),
    }),
    toStored: (b) => ({
      examName: b.name,
      amount: num(b.unitPrice, 'unitPrice', { min: 1 }),
      img: b.logo ?? null,
      smeapiExamProviderId: num(b.smeapiExamProviderId, 'smeapiExamProviderId', { min: 1 }),
      cheapdatahubProductId: num(b.cheapdatahubProductId, 'cheapdatahubProductId', { min: 1 }),
      active: activeOf(b),
    }),
  },

  // airtime-to-cash.vue computes `1 - commissionRate`, so the wire value is a
  // fraction while storage holds a percentage.
  atc: {
    collection: 'ATC',
    required: ['network', 'commissionRate', 'payoutNumber'],
    present: (d) => ({
      id: d.docid,
      network: d.network ?? null,
      payoutNumber: d.number != null ? String(d.number) : null,
      commissionRate: Number(d.percent) / 100,
      active: isActive(d),
    }),
    toStored: (b) => {
      const rate = Number(b.commissionRate);
      if (!Number.isFinite(rate) || rate < 0 || rate >= 1) {
        throw validationFailed('commissionRate must be a fraction between 0 and 1', {
          field: 'commissionRate',
          value: b.commissionRate,
        });
      }
      return {
        network: b.network,
        number: b.payoutNumber != null ? String(b.payoutNumber) : null,
        percent: Math.round(rate * 100),
        active: activeOf(b),
      };
    },
  },

  // The provider's published earning rate, seeded and maintained by hand.
  // A stale rate here produces a false "earning below expected" alarm rather
  // than silence, which is the right direction to fail.
  'provider-rates': {
    collection: 'PROVIDERRATES',
    required: ['provider', 'serviceLabel', 'matchesTransType', 'expectedRate'],
    present: (d) => ({
      id: d.docid,
      provider: d.provider ?? null,
      serviceLabel: d.serviceLabel ?? null,
      matchesTransType: d.matchesTransType ?? null,
      expectedRate: d.expectedRate ?? null,
      cappedAt: d.cappedAt ?? null,
      active: isActive(d),
    }),
    toStored: (b) => {
      const rate = Number(b.expectedRate);
      if (!Number.isFinite(rate) || rate < 0 || rate >= 100) {
        throw validationFailed('expectedRate must be a percentage between 0 and 100', {
          field: 'expectedRate',
          value: b.expectedRate,
        });
      }
      return {
        provider: providerName(b.provider),
        serviceLabel: text(b.serviceLabel),
        matchesTransType: text(b.matchesTransType),
        expectedRate: rate,
        cappedAt: num(b.cappedAt, 'cappedAt', { min: 0 }),
        active: activeOf(b),
      };
    },
  },
};

const present = (v) => v !== undefined && v !== null && v !== '';

// A row must carry every always-required field, and -- where the collection
// declares alternatives -- at least one complete group of them.
//
// The alternatives exist because a row's provider identifiers are not
// interchangeable: smeapi takes numeric ids and cheapdatahub takes different
// numeric ids, and a row imported from one provider cannot supply the other's.
// Demanding both would make importing impossible; demanding neither would allow
// a row no provider can serve.
function assertRequired(config, body) {
  const missing = config.required.filter((field) => !present(body[field]));
  if (missing.length) {
    throw validationFailed(`Missing required field(s): ${missing.join(', ')}`, { missing });
  }

  const groups = config.requiresOneOf;
  if (groups && !groups.some((group) => group.every((field) => present(body[field])))) {
    const options = groups.map((g) => g.join(' + ')).join(' or ');
    throw validationFailed(
      `This record needs at least one provider's identifier: ${options}`,
      { requiresOneOf: groups }
    );
  }
}

module.exports = { ADMIN_COLLECTIONS, formatNairaAmount, PROVIDER_NAMES, assertRequired };
