const { validationFailed } = require('../models/errors');

// Which column carries a provider's identifier for a given service. Selection
// happens at invoke time, when the provider instance is already known, so a
// routing change between catalog lookup and dispatch cannot pair one provider's
// ids with another provider's API.
const SERVICE_COLUMNS = Object.assign(Object.create(null), {
  // smeapi uses numeric ids for everything. Data and airtime share the same
  // network column; cable, electricity and epin each have their own provider id.
  smeapi: Object.assign(Object.create(null), {
    data: 'smeapiNetworkId', airtime: 'smeapiNetworkId',
    cable: 'smeapiCableProviderId', electricity: 'smeapiDiscoId',
    epin: 'smeapiExamProviderId',
  }),
  // CheapDataHub's data endpoint takes only a bundle id, but data still maps
  // to the network column so the coverage gate demands the same column
  // airtime uses. Its cable buy takes only the plan id; the CABLES column is
  // the representative plan id its validate endpoint needs (see
  // VALIDATE_COLUMNS).
  cheapdatahub: Object.assign(Object.create(null), {
    data: 'cheapdatahubNetworkId', airtime: 'cheapdatahubNetworkId',
    cable: 'cheapdatahubValidatePlanId', electricity: 'cheapdatahubDiscoId',
    epin: 'cheapdatahubProductId',
  }),
});

const PLAN_COLUMNS = Object.assign(Object.create(null), {
  smeapi: Object.assign(Object.create(null), {
    data: 'smeapiDataPlanId', cable: 'smeapiCablePlanId',
  }),
  cheapdatahub: Object.assign(Object.create(null), {
    data: 'cheapdatahubBundleId', cable: 'cheapdatahubPlanId',
  }),
});

// The column carrying a provider's *validate* identifier. For smeapi the buy
// and validate endpoints take the same numeric provider id, so these repeat
// SERVICE_COLUMNS. CheapDataHub validates a smart card against a cable PLAN id
// rather than a provider id, so it diverges there.
const VALIDATE_COLUMNS = Object.assign(Object.create(null), {
  smeapi: Object.assign(Object.create(null), {
    cable: 'smeapiCableProviderId', electricity: 'smeapiDiscoId',
  }),
  cheapdatahub: Object.assign(Object.create(null), {
    cable: 'cheapdatahubValidatePlanId', electricity: 'cheapdatahubDiscoId',
  }),
});

const present = (v) => v !== undefined && v !== null && String(v).trim() !== '';

function pick(table, providerName, kind, doc, label) {
  const columns = table[providerName];
  if (!columns) {
    throw validationFailed(`Unknown provider "${providerName}"`, { provider: providerName });
  }
  const column = columns[kind];
  if (!column) {
    throw validationFailed(`${providerName} does not serve ${kind}`, { provider: providerName, kind });
  }
  const value = doc?.[column];
  if (!present(value)) {
    // Named explicitly: this is what an admin must fill in, and the message is
    // rendered verbatim by the admin page.
    throw validationFailed(
      `This ${label} has no ${column} for ${providerName}`,
      { column, provider: providerName, kind }
    );
  }
  return value;
}

const serviceIdFor = (providerName, kind, doc) => pick(SERVICE_COLUMNS, providerName, kind, doc, 'entry');
const planIdFor = (providerName, kind, doc) => pick(PLAN_COLUMNS, providerName, kind, doc, 'plan');
const validateIdFor = (providerName, kind, doc) => pick(VALIDATE_COLUMNS, providerName, kind, doc, 'entry');

module.exports = {
  serviceIdFor, planIdFor, validateIdFor,
  SERVICE_COLUMNS, PLAN_COLUMNS, VALIDATE_COLUMNS,
};
