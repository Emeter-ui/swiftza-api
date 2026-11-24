const crypto = require('crypto');
const { AppError, validationFailed } = require('./errors');

// Wallet-funding fee engine. Pure: no database, no clock, no network. The
// repository loads a config, this module decides what a deposit costs, and the
// credit writers use the same function so a quote and the eventual credit can
// never disagree.
//
// Every calculation runs in integer kobo. Rules are stored in naira because
// that is what an admin types, and converted once on the way in.

const CHANNELS = ['paystack'];
const METHODS = ['any', 'card', 'transfer', 'ussd'];
const MODES = ['on_top', 'deducted'];
const TAX_BASES = ['fee', 'amount'];
const UNMATCHED_POLICIES = ['reject', 'no_fee'];

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  minDeposit: 100,
  maxDeposit: 1000000,
  // What happens to a deposit inside the limits that no active rule covers.
  unmatchedPolicy: 'no_fee',
  channel: 'paystack',
});

const toKobo = (naira) => Math.round(Number(naira) * 100);
const toNaira = (kobo) => Math.round(kobo) / 100;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const blank = (v) => v === null || v === undefined || v === '';

function numOrNull(v) {
  if (blank(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

const fmt = (naira) => `₦${Number(naira).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const rangeLabel = (r) => `${fmt(r.minAmount)}–${r.maxAmount == null ? 'no limit' : fmt(r.maxAmount)}`;

// ── Normalisation ──────────────────────────────────────────────────────────
// Turns whatever the admin form posted into a canonical rule, collecting
// field-level problems instead of throwing on the first so the form can show
// all of them at once.
function normalizeRule(input = {}, { id } = {}) {
  const problems = [];
  const push = (field, message) => problems.push({ field, message });

  const rule = {
    id: id || input.id || `fee_${crypto.randomBytes(6).toString('hex')}`,
    name: typeof input.name === 'string' ? input.name.trim() : '',
    active: input.active !== false,
    channel: input.channel || 'paystack',
    method: input.method || 'any',
    minAmount: numOrNull(input.minAmount),
    maxAmount: numOrNull(input.maxAmount),
    mode: input.mode || 'on_top',
    flatFee: numOrNull(input.flatFee) ?? 0,
    percentFee: numOrNull(input.percentFee) ?? 0,
    minFee: numOrNull(input.minFee),
    capAmount: numOrNull(input.capAmount),
    taxRate: numOrNull(input.taxRate) ?? 0,
    taxBase: input.taxBase || 'fee',
    grossUp: input.grossUp === true,
    note: typeof input.note === 'string' ? input.note.trim().slice(0, 300) : '',
  };

  if (!rule.name) push('name', 'Give the rule a name');
  if (rule.name.length > 80) push('name', 'Name must be 80 characters or fewer');
  if (!CHANNELS.includes(rule.channel)) push('channel', `Channel must be one of ${CHANNELS.join(', ')}`);
  if (!METHODS.includes(rule.method)) push('method', `Method must be one of ${METHODS.join(', ')}`);
  if (!MODES.includes(rule.mode)) push('mode', 'Mode must be "on_top" (customer pays the fee) or "deducted" (fee comes out of the deposit)');
  if (!TAX_BASES.includes(rule.taxBase)) push('taxBase', 'Tax base must be "fee" or "amount"');

  if (rule.minAmount === null || Number.isNaN(rule.minAmount)) push('minAmount', 'Minimum amount is required');
  else if (rule.minAmount < 0 || !Number.isInteger(rule.minAmount)) push('minAmount', 'Minimum amount must be a whole naira amount of 0 or more');

  if (Number.isNaN(rule.maxAmount)) push('maxAmount', 'Maximum amount must be a number, or empty for no upper limit');
  else if (rule.maxAmount !== null) {
    if (!Number.isInteger(rule.maxAmount)) push('maxAmount', 'Maximum amount must be a whole naira amount');
    else if (isNum(rule.minAmount) && rule.maxAmount < rule.minAmount) {
      push('maxAmount', 'Maximum amount cannot be lower than the minimum amount');
    }
  }

  const money = (field, label) => {
    const v = rule[field];
    if (v === null) return;
    if (Number.isNaN(v)) push(field, `${label} must be a number`);
    else if (v < 0) push(field, `${label} cannot be negative`);
    else if (Math.round(v * 100) !== v * 100 && Math.abs(Math.round(v * 100) - v * 100) > 1e-6) push(field, `${label} can have at most 2 decimal places`);
  };
  money('flatFee', 'Flat fee');
  money('minFee', 'Minimum fee');
  money('capAmount', 'Fee cap');

  const pct = (field, label) => {
    const v = rule[field];
    if (Number.isNaN(v)) push(field, `${label} must be a number`);
    else if (v < 0 || v > 100) push(field, `${label} must be between 0 and 100`);
  };
  pct('percentFee', 'Percentage fee');
  pct('taxRate', 'Tax rate');

  if (rule.capAmount !== null && !Number.isNaN(rule.capAmount) && rule.capAmount === 0) {
    push('capAmount', 'A cap of ₦0 makes the rule charge nothing. Leave it empty for no cap, or deactivate the rule');
  }
  if (isNum(rule.minFee) && isNum(rule.capAmount) && rule.minFee > rule.capAmount) {
    push('capAmount', 'Fee cap cannot be lower than the minimum fee');
  }
  if (rule.grossUp && rule.mode !== 'on_top') {
    push('grossUp', 'Gross-up only applies when the fee is added on top of the amount');
  }
  if (rule.grossUp && isNum(rule.percentFee) && isNum(rule.taxRate)) {
    const p = rule.percentFee / 100;
    const t = rule.taxBase === 'fee' ? rule.taxRate / 100 : 0;
    if (p * (1 + t) >= 1) push('percentFee', 'With gross-up the percentage (plus tax on it) must be below 100%, or the charge grows without limit');
  }
  if (rule.flatFee === 0 && rule.percentFee === 0 && !isNum(rule.minFee) && rule.taxBase === 'fee') {
    // Legal, but almost always a mistake; surfaced as a warning by analyse().
  }

  return { rule, problems };
}

function normalizeSettings(input = {}) {
  const problems = [];
  const push = (field, message) => problems.push({ field, message });
  const s = {
    enabled: input.enabled !== false,
    minDeposit: numOrNull(input.minDeposit) ?? DEFAULT_SETTINGS.minDeposit,
    maxDeposit: numOrNull(input.maxDeposit) ?? DEFAULT_SETTINGS.maxDeposit,
    unmatchedPolicy: input.unmatchedPolicy || DEFAULT_SETTINGS.unmatchedPolicy,
    channel: input.channel || DEFAULT_SETTINGS.channel,
  };
  if (Number.isNaN(s.minDeposit) || !Number.isInteger(s.minDeposit) || s.minDeposit < 1) {
    push('minDeposit', 'Minimum deposit must be a whole naira amount of at least ₦1');
  }
  if (Number.isNaN(s.maxDeposit) || !Number.isInteger(s.maxDeposit)) {
    push('maxDeposit', 'Maximum deposit must be a whole naira amount');
  } else if (isNum(s.minDeposit) && s.maxDeposit <= s.minDeposit) {
    push('maxDeposit', 'Maximum deposit must be greater than the minimum deposit');
  }
  if (!UNMATCHED_POLICIES.includes(s.unmatchedPolicy)) {
    push('unmatchedPolicy', 'Unmatched policy must be "reject" or "no_fee"');
  }
  if (!CHANNELS.includes(s.channel)) push('channel', `Channel must be one of ${CHANNELS.join(', ')}`);
  return { settings: s, problems };
}

// ── Fee maths ──────────────────────────────────────────────────────────────

// The fee a rule charges on an amount, in kobo. Exposed separately from quote()
// because the analyser needs it without the deposit-limit checks.
function computeWithRule(rule, amountKobo) {
  const A = amountKobo;
  const flat = toKobo(rule.flatFee || 0);
  const p = (rule.percentFee || 0) / 100;
  const t = (rule.taxRate || 0) / 100;
  const minFee = isNum(rule.minFee) ? toKobo(rule.minFee) : null;
  const cap = isNum(rule.capAmount) ? toKobo(rule.capAmount) : null;
  const clamp = (f) => {
    let out = f;
    if (minFee !== null) out = Math.max(out, minFee);
    if (cap !== null) out = Math.min(out, cap);
    return out;
  };
  const taxOn = (fee) => Math.round((rule.taxBase === 'amount' ? A : fee) * t);

  let fee;
  let capped = false;
  let floored = false;

  if (rule.mode === 'on_top' && rule.grossUp && p > 0) {
    // Solve C so that after the processor keeps flat + p·C (and tax on that),
    // exactly A is left: C − (flat + p·C)(1+t_fee) − tax_amount = A.
    const tFee = rule.taxBase === 'fee' ? t : 0;
    const taxAmt = rule.taxBase === 'amount' ? Math.round(A * t) : 0;
    const C = Math.ceil((A + taxAmt + flat * (1 + tFee)) / (1 - p * (1 + tFee)));
    const raw = flat + Math.ceil(p * C);
    fee = clamp(raw);
    capped = cap !== null && raw > cap;
    floored = minFee !== null && raw < minFee;
  } else {
    const raw = flat + Math.round(A * p);
    fee = clamp(raw);
    capped = cap !== null && raw > cap;
    floored = minFee !== null && raw < minFee;
  }

  const tax = taxOn(fee);
  const total = fee + tax;
  const charge = rule.mode === 'on_top' ? A + total : A;
  const credit = rule.mode === 'on_top' ? A : A - total;

  return { feeKobo: fee, taxKobo: tax, totalFeeKobo: total, chargeKobo: charge, creditKobo: credit, capped, floored };
}

// Specific method beats "any". Within the same specificity, validation forbids
// overlap, so finding two is a configuration fault, not a tie to break.
function matchRule(rules, { amount, method = 'card', channel = 'paystack' }) {
  const candidates = rules.filter(
    (r) => r.active !== false
      && (r.channel || 'paystack') === channel
      && amount >= r.minAmount
      && (r.maxAmount == null || amount <= r.maxAmount)
  );
  const specific = candidates.filter((r) => r.method === method);
  const pool = specific.length ? specific : candidates.filter((r) => r.method === 'any');
  if (pool.length > 1) {
    throw new AppError(
      'FEE_CONFIG_CONFLICT',
      'Wallet funding is temporarily unavailable. Please try again shortly.',
      503,
      { ruleIds: pool.map((r) => r.id) }
    );
  }
  return pool[0] || null;
}

// The single entry point for "what does depositing X cost". Throws AppErrors a
// customer can read; never returns a quote that would credit ₦0 or less.
function quote(config, { amount, method = 'card' } = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(config?.settings || {}) };
  const rules = config?.rules || [];
  const n = Number(amount);

  if (!Number.isFinite(n) || n <= 0) throw validationFailed('Enter an amount to add');
  if (!Number.isInteger(n)) throw validationFailed('Enter a whole naira amount (no kobo)');
  if (!METHODS.includes(method) || method === 'any') throw validationFailed('Choose a valid payment method');
  if (n < settings.minDeposit) {
    throw new AppError('DEPOSIT_TOO_SMALL', `The minimum you can add is ${fmt(settings.minDeposit)}`, 422, { minDeposit: settings.minDeposit });
  }
  if (n > settings.maxDeposit) {
    throw new AppError('DEPOSIT_TOO_LARGE', `The maximum you can add at once is ${fmt(settings.maxDeposit)}`, 422, { maxDeposit: settings.maxDeposit });
  }

  const A = toKobo(n);
  const rule = settings.enabled ? matchRule(rules, { amount: n, method, channel: settings.channel }) : null;

  if (!rule && settings.enabled && settings.unmatchedPolicy === 'reject') {
    throw new AppError('DEPOSIT_AMOUNT_UNSUPPORTED', `Deposits of ${fmt(n)} are not available right now. Try a different amount.`, 422);
  }

  const calc = rule
    ? computeWithRule(rule, A)
    : { feeKobo: 0, taxKobo: 0, totalFeeKobo: 0, chargeKobo: A, creditKobo: A, capped: false, floored: false };

  if (calc.creditKobo <= 0) {
    throw new AppError('FEE_EXCEEDS_AMOUNT', `The fee on ${fmt(n)} is more than the amount. Add a larger amount.`, 422);
  }

  return {
    amount: n,
    method,
    channel: settings.channel,
    mode: rule ? rule.mode : 'none',
    ruleId: rule ? rule.id : null,
    ruleName: rule ? rule.name : null,
    fee: toNaira(calc.feeKobo),
    tax: toNaira(calc.taxKobo),
    totalFee: toNaira(calc.totalFeeKobo),
    charge: toNaira(calc.chargeKobo),
    credit: toNaira(calc.creditKobo),
    chargeKobo: calc.chargeKobo,
    creditKobo: calc.creditKobo,
    capped: calc.capped,
    floored: calc.floored,
  };
}

// Used when a Paystack payment arrives with no funding intent (an old client, a
// payment initiated outside the app). Never credits more than was paid: finds
// the largest deposit whose quoted charge fits in what was actually paid.
function creditForPaid(config, { paidKobo, method = 'card' }) {
  const settings = { ...DEFAULT_SETTINGS, ...(config?.settings || {}) };
  const rules = config?.rules || [];
  const fallback = { creditKobo: paidKobo, feeKobo: 0, taxKobo: 0, totalFeeKobo: 0, ruleId: null, mode: 'none', inferred: true };
  if (!settings.enabled || !rules.some((r) => r.active !== false)) return fallback;

  const tryAmount = (naira) => {
    try {
      const rule = matchRule(rules, { amount: naira, method, channel: settings.channel });
      if (!rule) return { chargeKobo: toKobo(naira), creditKobo: toKobo(naira), feeKobo: 0, taxKobo: 0, totalFeeKobo: 0, rule: null };
      return { ...computeWithRule(rule, toKobo(naira)), rule };
    } catch {
      return null;
    }
  };

  // Deducted: the paid amount IS the deposit amount.
  const direct = tryAmount(Math.floor(paidKobo / 100));
  if (direct && direct.rule && direct.rule.mode === 'deducted' && direct.chargeKobo === paidKobo) {
    return { creditKobo: Math.max(direct.creditKobo, 0), feeKobo: direct.feeKobo, taxKobo: direct.taxKobo, totalFeeKobo: direct.totalFeeKobo, ruleId: direct.rule.id, mode: 'deducted', inferred: true };
  }

  // On top: charge is monotonic in amount within a tier, so binary search the
  // largest whole-naira deposit whose charge does not exceed what was paid.
  let lo = 0;
  let hi = Math.floor(paidKobo / 100);
  let best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const r = mid > 0 ? tryAmount(mid) : null;
    if (r && r.chargeKobo <= paidKobo) { best = { naira: mid, r }; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (!best) return { ...fallback, creditKobo: 0 };
  const { r } = best;
  return {
    creditKobo: Math.max(r.creditKobo, 0),
    feeKobo: r.feeKobo,
    taxKobo: r.taxKobo,
    totalFeeKobo: paidKobo - r.creditKobo,
    ruleId: r.rule ? r.rule.id : null,
    mode: r.rule ? r.rule.mode : 'none',
    inferred: true,
  };
}

// ── Analysis ───────────────────────────────────────────────────────────────
// Everything an admin needs to know before saving: hard errors (save refused)
// and warnings (saved, but probably not what was meant).
function analyse(config) {
  const { settings, problems: settingProblems } = normalizeSettings(config?.settings || {});
  const errors = [];
  const warnings = [];
  const add = (list, code, message, ruleIds = [], extra = {}) => list.push({ code, message, ruleIds, ...extra });

  settingProblems.forEach((p) => add(errors, 'INVALID_SETTING', p.message, [], { field: p.field }));

  const rules = [];
  (config?.rules || []).forEach((raw) => {
    const { rule, problems } = normalizeRule(raw, { id: raw.id });
    problems.forEach((p) => add(errors, 'INVALID_RULE', `${rule.name || 'Unnamed rule'}: ${p.message}`, [rule.id], { field: p.field }));
    rules.push(rule);
  });

  // Duplicate ids or names make the UI ambiguous.
  const seenIds = new Map();
  const seenNames = new Map();
  rules.forEach((r) => {
    if (seenIds.has(r.id)) add(errors, 'DUPLICATE_ID', `Two rules share the id ${r.id}`, [seenIds.get(r.id), r.id]);
    seenIds.set(r.id, r.id);
    const key = r.name.toLowerCase();
    if (key && seenNames.has(key)) add(warnings, 'DUPLICATE_NAME', `Two rules are both named "${r.name}"`, [seenNames.get(key), r.id]);
    if (key) seenNames.set(key, r.id);
  });

  const usable = rules.filter((r) => r.active && isNum(r.minAmount) && (r.maxAmount === null || isNum(r.maxAmount)) && r.maxAmount !== undefined);
  const hi = (r) => (r.maxAmount === null ? Infinity : r.maxAmount);

  // Overlaps: same channel + same method. "any" vs a specific method is not a
  // clash (specific wins) but is reported so the admin knows which one applies.
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const a = usable[i];
      const b = usable[j];
      if (a.channel !== b.channel) continue;
      const from = Math.max(a.minAmount, b.minAmount);
      const to = Math.min(hi(a), hi(b));
      if (from > to) continue;
      const span = `${fmt(from)}–${to === Infinity ? 'no limit' : fmt(to)}`;
      if (a.method === b.method) {
        add(errors, 'RANGE_OVERLAP', `"${a.name}" and "${b.name}" both cover ${span} for ${a.method === 'any' ? 'every method' : a.method}. A deposit there would match two rules`, [a.id, b.id], { from, to: to === Infinity ? null : to });
      } else if (a.method === 'any' || b.method === 'any') {
        const [generic, specific] = a.method === 'any' ? [a, b] : [b, a];
        add(warnings, 'RANGE_SHADOWED', `For ${specific.method} deposits of ${span}, "${specific.name}" applies instead of "${generic.name}"`, [specific.id, generic.id], { from, to: to === Infinity ? null : to });
      }
    }
  }

  const sMin = settings.minDeposit;
  const sMax = settings.maxDeposit;

  usable.forEach((r) => {
    // Unreachable / partly unreachable ranges.
    if (isNum(sMin) && isNum(sMax)) {
      if (r.minAmount > sMax || hi(r) < sMin) {
        add(warnings, 'RULE_UNREACHABLE', `"${r.name}" (${rangeLabel(r)}) is entirely outside the deposit limits ${fmt(sMin)}–${fmt(sMax)} and will never apply`, [r.id]);
      } else if (r.minAmount < sMin || (r.maxAmount !== null && r.maxAmount > sMax)) {
        add(warnings, 'RULE_PARTLY_UNREACHABLE', `Part of "${r.name}" (${rangeLabel(r)}) is outside the deposit limits ${fmt(sMin)}–${fmt(sMax)}`, [r.id]);
      }
    }

    // A deducted fee that eats the whole deposit. Worst case is the smallest
    // reachable amount, because a flat fee is proportionally largest there.
    if (r.mode === 'deducted') {
      const lowest = Math.max(r.minAmount, isNum(sMin) ? sMin : 1, 1);
      const probes = [lowest, Math.min(hi(r), isNum(sMax) ? sMax : hi(r))].filter((x) => isNum(x) && x !== Infinity && x >= lowest);
      for (const amt of probes) {
        const c = computeWithRule(r, toKobo(amt));
        if (c.creditKobo <= 0) {
          add(errors, 'FEE_EXCEEDS_AMOUNT', `"${r.name}" would take the whole deposit at ${fmt(amt)} (fee ${fmt(toNaira(c.totalFeeKobo))}). Raise the minimum amount or lower the fee`, [r.id], { amount: amt });
          break;
        }
        if (c.totalFeeKobo * 2 > toKobo(amt)) {
          add(warnings, 'FEE_OVER_HALF', `"${r.name}" takes more than half of a ${fmt(amt)} deposit (fee ${fmt(toNaira(c.totalFeeKobo))})`, [r.id], { amount: amt });
          break;
        }
      }
    }

    if (r.flatFee === 0 && r.percentFee === 0 && !isNum(r.minFee) && !(r.taxBase === 'amount' && r.taxRate > 0)) {
      add(warnings, 'ZERO_FEE_RULE', `"${r.name}" charges nothing. Deactivate it, or set "no fee" as the unmatched policy instead`, [r.id]);
    }
    if (isNum(r.capAmount) && isNum(r.minFee) && r.capAmount === r.minFee) {
      add(warnings, 'FLAT_BY_CLAMP', `"${r.name}" has the same minimum fee and cap, so it always charges ${fmt(r.capAmount)}`, [r.id]);
    }
  });

  // Gaps and boundary cliffs per method the customer can actually pick.
  if (isNum(sMin) && isNum(sMax) && sMax > sMin && settings.enabled) {
    // Methods that see exactly the same rules behave identically, so they are
    // checked once and reported together ("every method") instead of three
    // near-identical messages.
    const pickable = METHODS.filter((m) => m !== 'any');
    const groups = new Map();
    pickable.forEach((m) => {
      const sig = usable.filter((r) => r.channel === settings.channel && (r.method === m || r.method === 'any')).map((r) => r.id).sort().join('|');
      groups.set(sig, [...(groups.get(sig) || []), m]);
    });
    for (const members of groups.values()) {
      const method = members[0];
      const who = members.length === pickable.length ? 'every method' : members.join(' / ');
      const applicable = usable
        .filter((r) => r.channel === settings.channel && (r.method === method || r.method === 'any'))
        .map((r) => ({ from: Math.max(r.minAmount, sMin), to: Math.min(hi(r), sMax), rule: r }))
        .filter((x) => x.from <= x.to)
        .sort((x, y) => x.from - y.from);

      if (!usable.length) {
        if (settings.unmatchedPolicy === 'reject') {
          add(errors, 'NO_RULES_REJECT_ALL', 'There are no active fee rules and unmatched deposits are set to be refused, so every deposit would be refused');
        }
        break;
      }

      let cursor = sMin;
      const gaps = [];
      for (const seg of applicable) {
        if (seg.from > cursor) gaps.push([cursor, seg.from - 1]);
        cursor = Math.max(cursor, seg.to + 1);
      }
      if (cursor <= sMax) gaps.push([cursor, sMax]);

      gaps.forEach(([from, to]) => {
        const consequence = settings.unmatchedPolicy === 'reject' ? 'will be refused' : 'will be charged no fee';
        add(settings.unmatchedPolicy === 'reject' ? errors : warnings, 'RANGE_GAP',
          `${who === 'every method' ? 'Deposits' : `${who} deposits`} of ${fmt(from)}–${fmt(to)} are not covered by any rule and ${consequence}`,
          [], { method: who, from, to });
      });

      // Cliff: depositing ₦1 more gets you a smaller wallet credit (deducted),
      // or depositing ₦1 more costs far more than ₦1 extra (on top).
      const effective = (amt) => {
        try { return quote({ settings, rules: usable }, { amount: amt, method }); } catch { return null; }
      };
      const boundaries = new Set();
      applicable.forEach((seg) => { if (seg.from > sMin) boundaries.add(seg.from); });
      gaps.forEach(([, to]) => { if (to < sMax) boundaries.add(to + 1); });
      for (const b of boundaries) {
        const before = effective(b - 1);
        const after = effective(b);
        if (!before || !after) continue;
        if (after.credit < before.credit) {
          add(warnings, 'CREDIT_CLIFF', `${who}: depositing ${fmt(b)} credits ${fmt(after.credit)}, less than the ${fmt(before.credit)} credited for ${fmt(b - 1)}. Customers are penalised for adding ₦1 more`, [before.ruleId, after.ruleId].filter(Boolean), { method: who, amount: b });
        } else if (after.mode === 'on_top' && after.charge - before.charge > Math.max(100, b * 0.05)) {
          // Paying a little more at a tier boundary is normal (Paystack's own
          // ₦100 step at ₦2,500); only a jump above 5% is worth flagging.
          add(warnings, 'CHARGE_CLIFF', `${who}: adding ${fmt(b)} costs ${fmt(after.charge)}, ${fmt(after.charge - before.charge)} more than adding ${fmt(b - 1)}`, [before.ruleId, after.ruleId].filter(Boolean), { method: who, amount: b });
        }
      }
    }
  }

  // De-duplicate identical messages produced once per method.
  const uniq = (list) => {
    const seen = new Set();
    return list.filter((x) => (seen.has(x.message) ? false : (seen.add(x.message), true)));
  };

  return { ok: errors.length === 0, errors: uniq(errors), warnings: uniq(warnings), settings, rules };
}

// A sample of quotes across the configured range, for the admin preview table.
function simulateTable(config, { method = 'card', points } = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(config?.settings || {}) };
  const amounts = new Set(points && points.length ? points : []);
  if (!amounts.size) {
    [settings.minDeposit, 500, 1000, 2499, 2500, 5000, 10000, 20000, 50000, 100000, 500000, settings.maxDeposit]
      .forEach((a) => amounts.add(a));
    (config?.rules || []).forEach((r) => {
      if (isNum(r.minAmount)) amounts.add(r.minAmount);
      if (isNum(r.maxAmount)) amounts.add(r.maxAmount);
    });
  }
  return [...amounts]
    .filter((a) => isNum(a) && Number.isInteger(a) && a >= settings.minDeposit && a <= settings.maxDeposit)
    .sort((a, b) => a - b)
    .map((amount) => {
      try {
        return { ok: true, ...quote(config, { amount, method }) };
      } catch (err) {
        // The customer-facing wording ("temporarily unavailable") hides the
        // cause; the admin preview should name it.
        const message = err.code === 'FEE_CONFIG_CONFLICT' ? 'Clash: matches more than one rule' : err.message;
        return { ok: false, amount, method, code: err.code || 'ERROR', message };
      }
    });
}

// Paystack's published Nigerian local-card pricing as a starting point. The
// admin edits or replaces these; nothing loads them automatically.
const PRESETS = {
  paystack_local: [
    { name: 'Paystack local · under ₦2,500', method: 'any', minAmount: 100, maxAmount: 2499, mode: 'on_top', flatFee: 0, percentFee: 1.5, capAmount: 2000, grossUp: true },
    { name: 'Paystack local · ₦2,500 and above', method: 'any', minAmount: 2500, maxAmount: null, mode: 'on_top', flatFee: 100, percentFee: 1.5, capAmount: 2000, grossUp: true },
  ],
};

module.exports = {
  CHANNELS, METHODS, MODES, TAX_BASES, UNMATCHED_POLICIES, DEFAULT_SETTINGS, PRESETS,
  toKobo, toNaira,
  normalizeRule, normalizeSettings, computeWithRule, matchRule, quote, creditForPaid, analyse, simulateTable,
};
