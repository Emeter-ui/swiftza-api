const smeapi = require('./smeapi');
const cheapdatahub = require('./cheapdatahub');
const settings = require('../repositories/settings');
const { optional } = require('../config/env');
const { SERVICES } = require('./contract');

const ADAPTERS = Object.assign(Object.create(null), { smeapi, cheapdatahub });

const SETTINGS_DOC = 'providers';
const CACHE_TTL_MS = 60000;

let cache = { config: null, expiresAt: 0 };

// Provider SELECTION and non-secret settings come from the database so the
// active provider can be switched from the admin panel without a redeploy.
// Credentials are never stored there — each adapter pulls its own token from
// env.
async function loadConfig() {
  const now = Date.now();
  if (cache.config && now < cache.expiresAt) return cache.config;

  let stored = {};
  try {
    stored = (await settings.get(SETTINGS_DOC)) || {};
  } catch (err) {
    // A database blip must not take purchases down; fall back to env.
    console.warn('[providers] could not read provider settings:', err.message);
  }

  const config = {
    active: stored.active || optional('ACTIVE_PROVIDER', 'smeapi'),
    overrides: stored.overrides || {},
    settings: stored,
  };

  cache = { config, expiresAt: now + CACHE_TTL_MS };
  return config;
}

function refresh() {
  cache = { config: null, expiresAt: 0 };
}

async function getActiveName() {
  const { active } = await loadConfig();
  return active;
}

// The override map was loaded but never consulted, so per-service routing was
// declared and dead. Resolution is here, in one place, so every caller agrees.
async function getProviderName(service) {
  const config = await loadConfig();
  return (service && config.overrides?.[service]) || config.active;
}

async function getRouting() {
  const config = await loadConfig();
  const services = {};
  for (const service of Object.values(SERVICES)) {
    const override = config.overrides?.[service];
    services[service] = {
      provider: override || config.active,
      source: override ? 'override' : 'default',
    };
  }
  return { active: config.active, services };
}

async function getProvider(service) {
  const config = await loadConfig();
  const name = (service && config.overrides?.[service]) || config.active;
  const adapter = ADAPTERS[name];

  if (!adapter) {
    throw new Error(
      `Unknown provider "${name}". Available: ${Object.keys(ADAPTERS).join(', ')}`
    );
  }

  const instance = adapter.create(config.settings?.[name] || {});

  if (service && !instance.supports.includes(service)) {
    throw new Error(`Provider "${name}" does not support ${service}`);
  }

  return instance;
}

// The adapter instance without consulting routing — the admin panel needs to
// inspect a provider that is not currently serving anything.
async function describe(name) {
  const adapter = ADAPTERS[name];
  if (!adapter) throw new Error(`Unknown provider "${name}"`);
  const config = await loadConfig();
  return adapter.create(config.settings?.[name] || {});
}

module.exports = {
  getProvider,
  getActiveName,
  getProviderName,
  getRouting,
  refresh,
  describe,
  available: Object.keys(ADAPTERS),
  SERVICES,
};
