const { parsePrice } = require('../models/catalog');
const { optionalInt } = require('../config/env');

// In-chat cards the assistant can open instead of sending the customer to
// another screen:
//
//   { type: 'buy', service?, networkId?, planId?, planType?, phone?, amount?,
//     providerId?, smartcard?, discoId?, meterType?, meter?, examId?, quantity? }
//   { type: 'fund_wallet', amount?, reason?, then?: <buy widget> }
//   { type: 'auth', mode: 'login' | 'register', then?: <buy or fund widget> }
//     (signed-out visitors only: sign in, then carry on with `then`)
//
// Everything the model returns is untrusted. Names are matched to catalog
// rows and sent on as ids, plans must exist and be on sale, and numbers must
// be in range. A detail that fails is dropped rather than the whole card:
// the card simply asks the customer for it. Prices are never taken from the
// model; the card shows catalog prices and the purchase routes charge them.

const SERVICES = ['airtime', 'data', 'cable', 'electricity', 'exam'];

// The same bounds the purchase routes enforce (models/catalog.js). Airtime
// starts at ₦100 because that is the smallest amount the app offers.
const AIRTIME_MIN = Math.max(100, optionalInt('AIRTIME_MIN_AMOUNT', 50));
const AIRTIME_MAX = optionalInt('AIRTIME_MAX_AMOUNT', 50000);
const ELECTRICITY_MIN = optionalInt('ELECTRICITY_MIN_AMOUNT', 500);
const ELECTRICITY_MAX = optionalInt('ELECTRICITY_MAX_AMOUNT', 100000);

// Matches the wording of what customers ask for, so a vague message still
// gets the top-up card in low-balance mode when the model forgets to add it.
const PURCHASE_INTENT = /\b(buy|recharge|top ?up|topup|fund|add money|deposit|load|airtime|data|bundle|pay|renew|subscri\w*|dstv|gotv|startimes|electric\w*|light|meter|token|waec|neco|jamb|exam)\b/i;

// For visitors, the sign-in card is added when they clearly want to do
// something on an account. Price questions ("how much is MTN 1GB?") are not
// matched: no buy verb, no account word.
const ACCOUNT_INTENT = /\b(log ?in|sign ?in|sign ?up|register|create (an |my )?account|open (an )?account|balance|wallet|refund|my (account|transactions?|orders?|money|history)|buy|recharge|top ?up|topup|fund|add money|deposit|renew|subscribe)\b/i;
const REGISTER_INTENT = /\b(sign ?up|register|create (an |my )?account|open (an )?account|new (here|account|user)|don'?t have an account)\b/i;

const lower = (v) => String(v ?? '').trim().toLowerCase();
const loose = (v) => lower(v).replace(/[^a-z0-9]/g, '');
const isLive = (row) => row && row.active !== false;

// Exact name first, then a contains-match either way ("ikeja" → "Ikeja
// Electric", "DSTV Nigeria" → "DSTV"). Both sides need three characters so
// "ie" cannot match half the catalog.
function matchByName(rows, field, value) {
  const want = loose(value);
  if (!want) return null;
  const live = (rows || []).filter((r) => isLive(r) && r[field]);
  return live.find((r) => loose(r[field]) === want)
    || live.find((r) => {
      const name = loose(r[field]);
      return name.length >= 3 && want.length >= 3 && (name.includes(want) || want.includes(name));
    })
    || null;
}

const byId = (rows, id) => (id == null || id === '' ? null : (rows || []).find((r) => String(r.docid) === String(id) && isLive(r)) || null);

function wholeNaira(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[₦,\s]/g, ''));
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function nigerianPhone(value) {
  const d = String(value ?? '').replace(/\D/g, '').replace(/^234/, '0');
  const local = d && !d.startsWith('0') ? `0${d}` : d;
  return /^0\d{10}$/.test(local) ? local : null;
}

function digits(value, min, max) {
  const d = String(value ?? '').replace(/[\s-]/g, '');
  return new RegExp(`^\\d{${min},${max}}$`).test(d) ? d : null;
}

function buyWidget(raw, catalog) {
  const service = SERVICES.includes(lower(raw.service)) ? lower(raw.service) : null;
  const out = { type: 'buy' };
  if (!service) return out; // No service named: the card opens on the service picker.
  out.service = service;
  const set = (k, v) => { if (v !== null && v !== undefined && v !== '') out[k] = v; };

  if (service === 'airtime' || service === 'data') {
    let network = matchByName(catalog.networks, 'name', raw.network);
    if (service === 'data') {
      let plan = byId(catalog.plans, raw.planId);
      if (plan && !(parsePrice(plan.Amount) > 0)) plan = null;
      // A plan from a different network than the one named is a model mix-up;
      // keep the network the customer said and let them pick the plan.
      if (plan && network && String(plan.networkId) !== String(network.docid)) plan = null;
      if (plan && !network) network = byId(catalog.networks, plan.networkId);
      if (plan) set('planId', String(plan.docid));
      else if (raw.planType && /^[a-z ]{2,20}$/i.test(String(raw.planType).trim())) set('planType', String(raw.planType).trim().toUpperCase());
    } else {
      set('amount', wholeNaira(raw.amount, AIRTIME_MIN, AIRTIME_MAX));
    }
    if (network) set('networkId', String(network.docid));
    set('phone', nigerianPhone(raw.phone));
  }

  if (service === 'cable') {
    let provider = matchByName(catalog.cables, 'CableName', raw.provider);
    let plan = byId(catalog.cablePlans, raw.planId);
    if (plan && !(parsePrice(plan.amount) > 0)) plan = null;
    // CABLESPLAN links to its provider only through the category name.
    const planProvider = plan ? matchByName(catalog.cables, 'CableName', plan.category) : null;
    if (plan && provider && planProvider && String(planProvider.docid) !== String(provider.docid)) plan = null;
    if (plan && !provider) provider = planProvider;
    if (provider) set('providerId', String(provider.docid));
    if (plan && provider) set('planId', String(plan.docid));
    set('smartcard', digits(raw.smartcard, 8, 20));
  }

  if (service === 'electricity') {
    const disco = matchByName(catalog.discos, 'Disconame', raw.disco ?? raw.provider);
    if (disco) set('discoId', String(disco.docid));
    const type = lower(raw.meterType);
    if (type === 'prepaid' || type === 'postpaid') set('meterType', type);
    set('meter', digits(raw.meter, 6, 20));
    set('amount', wholeNaira(raw.amount, ELECTRICITY_MIN, ELECTRICITY_MAX));
    set('phone', nigerianPhone(raw.phone));
  }

  if (service === 'exam') {
    const exam = matchByName(catalog.exams, 'examName', raw.provider ?? raw.exam);
    if (exam && parsePrice(exam.amount) > 0) set('examId', String(exam.docid));
    set('quantity', wholeNaira(raw.quantity, 1, 10));
  }

  return out;
}

function fundWidget(raw, feeSettings) {
  const out = { type: 'fund_wallet' };
  const min = Number(feeSettings?.minDeposit) || 100;
  const max = Number(feeSettings?.maxDeposit) || 1000000;
  const amount = wholeNaira(raw?.amount, min, max);
  if (amount) out.amount = amount;
  return out;
}

// A buy or top-up card for a visitor becomes the sign-in card, keeping the
// request so the chat can open it once they are in.
function visitorWidget(raw, { settings, catalog, feeSettings, message }) {
  const allowed = settings.allowActions;
  const canBuy = allowed && settings.actionGroups.includes('purchases');
  const canFund = allowed && settings.actionGroups.includes('wallet');
  const pending = (w) => {
    const t = lower(w?.type);
    if ((t === 'buy' || t === 'services') && canBuy) return buyWidget(w, catalog);
    if (t === 'fund_wallet' && canFund) return fundWidget(w, feeSettings);
    return null;
  };

  const type = lower(raw?.type);
  const then = type === 'auth' ? pending(raw.then) : pending(raw);
  if (type === 'auth' || then) {
    const register = lower(raw.mode) === 'register' || REGISTER_INTENT.test(String(message || ''));
    return { type: 'auth', mode: register ? 'register' : 'login', ...(then ? { then } : {}) };
  }
  if (ACCOUNT_INTENT.test(String(message || ''))) {
    return { type: 'auth', mode: REGISTER_INTENT.test(String(message || '')) ? 'register' : 'login' };
  }
  return null;
}

/**
 * Turns the model's widget (if any) into a safe one, or null.
 *
 * Low balance: the customer can only top up. A purchase card becomes a top-up
 * card that remembers what they wanted (`then`), so the chat can pick the
 * purchase back up once the money lands. If the model forgot the card but the
 * message is clearly about paying for something, the top-up card is added.
 */
function sanitize(raw, { settings, catalog, feeSettings, lowBalance, message, signedIn = true }) {
  if (!signedIn) return visitorWidget(raw, { settings, catalog, feeSettings, message });
  if (!settings.allowActions) return null;
  const canBuy = settings.actionGroups.includes('purchases');
  const canFund = settings.actionGroups.includes('wallet');
  const type = lower(raw?.type);

  let widget = null;
  if (type === 'fund_wallet' && canFund) {
    widget = fundWidget(raw, feeSettings);
    if (canBuy && raw.then && typeof raw.then === 'object') {
      const then = buyWidget(raw.then, catalog);
      if (then.service) widget.then = then;
    }
  } else if ((type === 'buy' || type === 'services') && canBuy) {
    widget = buyWidget(raw, catalog);
  }

  if (!lowBalance) return widget;
  if (!canFund) return null;
  if (widget?.type === 'buy') {
    return { type: 'fund_wallet', reason: 'low_balance', ...(widget.service ? { then: widget } : {}) };
  }
  if (widget) return { ...widget, reason: 'low_balance' };
  // ("auth" is never offered to someone already signed in: it falls through to null.)
  return PURCHASE_INTENT.test(String(message || '')) ? { type: 'fund_wallet', reason: 'low_balance' } : null;
}

// Low-balance replies are kept short even when the model rambles: cut at the
// last full sentence that fits.
function shorten(text, max = 320) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'));
  return end > max / 3 ? cut.slice(0, end + 1).trim() : `${cut.slice(0, cut.lastIndexOf(' ')).trim()}…`;
}

module.exports = {
  sanitize, buyWidget, fundWidget, shorten, matchByName,
  SERVICES, AIRTIME_MIN, AIRTIME_MAX, ELECTRICITY_MIN, ELECTRICITY_MAX,
};
