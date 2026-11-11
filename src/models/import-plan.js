//
// Pure planning logic for catalog import. No I/O anywhere in this file: every
// function takes values and returns values, so the arithmetic that decides
// what a customer is charged can be tested without a provider or a database.

// The provider names its data services by network; the catalog names rows by
// network. An explicit table, not string manipulation -- `etisalat-data` maps
// to the brand's current name, which no amount of munging would produce.
const NETWORK_BY_SERVICE = Object.assign(Object.create(null), {
  'mtn-data': 'MTN',
  'glo-data': 'GLO',
  'glo-sme-data': 'GLO',
  'airtel-data': 'Airtel',
  'etisalat-data': '9mobile',
  'smile-direct': 'Smile',
  spectranet: 'Spectranet',
});

// Float noise, not arithmetic: 100 * 1.1 is 110.00000000000001 in floating
// point, and a ceiling turns that exact ₦110 into ₦111 -- or ₦120 at a step of
// 10. Snapping to a millionth of a naira removes the noise, and can only ever
// discard less than a millionth of a naira of a real price.
const clean = (n) => Math.round(n * 1e6) / 1e6;

// Rounds UP, never to nearest. 333 at 15% is 382.95; rounding to the nearest
// 10 gives 380 -- BELOW the intended margin, on roughly half of all rows, and
// invisibly. Ceiling gives 390.
//
// And always to a WHOLE naira, whatever the step. The money layer is whole
// naira: a data-plan amount is stored through Math.round (formatNairaAmount ->
// parsePrice), and cable-plan and exam-pin prices are Math.round-ed when
// charged (parsePrice in models/catalog.js). A kobo price lands on the nearest
// naira there -- ₦116.15 (101 at 15%) becomes ₦116, below cost plus markup,
// which is exactly what ceiling rounding exists to prevent. So a `step` of 0
// means "no step", never "kobo".
//
// Returns null rather than a number for input that cannot produce a price, so
// a bad row is skipped visibly instead of priced at NaN or Infinity.
function priceFrom(cost, markupPercent, step) {
  const c = Number(cost);
  const m = Number(markupPercent);
  if (!Number.isFinite(c) || c <= 0) return null;
  if (!Number.isFinite(m) || m < 0) return null;

  const raw = clean(c * (1 + m / 100));
  if (!Number.isFinite(raw)) return null;

  const s = Number(step);
  if (!Number.isFinite(s) || s <= 0) return Math.ceil(raw);
  // The outer ceiling: a fractional step would otherwise yield a fractional
  // price (0.3 gives 383.1).
  return Math.ceil(clean(Math.ceil(clean(raw / s)) * s));
}

// Reads the NAME, never the code. VTpass codes lie: `mtn-1gb-3500` is a 10GB
// plan and `mtn-10mb-100` is a 100MB one. Anything that maps a plan by parsing
// its code misprices the sale.
const SIZE = /(\d+(?:\.\d+)?)\s*(TB|GB|MB)\b/i;
// The trailing segment after the last dash: "N100 100MB - 24 hrs" -> "24 hrs".
// Requires whitespace before the dash so a hyphen inside a compound word --
// "MTN 100GB 2-Month Plan", "... (2-Months)" -- is never mistaken for the
// delimiter. Without that whitespace check, those names fabricate a
// plausible-looking wrong validity ("Month Plan") instead of returning null.
// Do not simplify this back to a bare `-\s*([^-]+?)\s*$`.
const VALIDITY = /\s-\s*([^-]+?)\s*$/;

function parseVariation(variation, serviceID) {
  const name = String(variation?.name ?? '');
  const size = name.match(SIZE);
  const validity = name.match(VALIDITY);

  return {
    size: size ? `${size[1]}${size[2].toUpperCase()}` : null,
    validity: validity ? validity[1].trim() : null,
    network: NETWORK_BY_SERVICE[String(serviceID)] ?? null,
  };
}

const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, '');

// Which existing rows this variation could reasonably BE. A row qualifies only
// if it carries no provider code yet -- a row that already has one either is
// this variation (alreadyImported, below) or belongs to a different one, and
// writing over it would repoint a plan a customer can already buy.
//
// A field the parse could not fill matches nothing: guessing from a blank is
// how a 500MB plan gets attached to a 1GB row.
function proposeAction(parsed, code, rows, target) {
  const alreadyImported = rows.some((r) => norm(r[target.codeField]) === norm(code) && code);
  if (alreadyImported) {
    return { action: 'create', match: null, ambiguous: false, alreadyImported: true };
  }

  const usable = target.matchOn.every((f) => parsed[f] != null && parsed[f] !== '');
  const candidates = usable
    ? rows.filter(
        (r) => !r[target.codeField] && target.matchOn.every((f) => norm(r[f]) === norm(parsed[f]))
      )
    : [];

  // More than one candidate is a refusal to guess, not a coin flip.
  if (candidates.length !== 1) {
    return {
      action: 'create',
      match: null,
      ambiguous: candidates.length > 1,
      alreadyImported: false,
    };
  }

  const row = candidates[0];
  // Blank on both sides is not agreement -- it is the absence of a value.
  // Without this guard, norm(null) === norm(null) is '' === '', which is true,
  // and a sparsely-filled row (exactly what Quick Add produces) gets labelled
  // 'likely' on a field neither side actually confirmed.
  const filled = (v) => v != null && v !== '';
  const exact = target.exactOn.every(
    (f) => filled(row[f]) && filled(parsed[f]) && norm(row[f]) === norm(parsed[f])
  );
  return {
    action: 'attach',
    match: {
      id: row.id,
      label: target.label(row),
      confidence: exact ? 'likely' : 'possible',
      why: target.matchOn.map((f) => `${f} ${parsed[f]}`).join(', '),
    },
    ambiguous: false,
    alreadyImported: false,
  };
}

// proposeAction judges one variation at a time, so it counts rows per
// variation and never variations per row. Two variations can each find the
// same single un-coded row -- the captured mtn-data payload has two 3GB plans,
// "3GB - 30 days" and "3GB - 2 days" -- and both would propose attaching to
// it. Applied in order, the second attach overwrites the first code on a row
// that may already be live, and the customer who buys the 30-day plan is sent
// the 2-day one. A row claimed by more than one variation is therefore the
// same refusal to guess as a variation matching more than one row.
function refuseSharedMatches(items) {
  const claims = new Map();
  for (const item of items) {
    if (item.action === 'attach' && item.match) {
      claims.set(item.match.id, (claims.get(item.match.id) ?? 0) + 1);
    }
  }
  return items.map((item) =>
    item.action === 'attach' && item.match && claims.get(item.match.id) > 1
      ? { ...item, action: 'create', match: null, ambiguous: true }
      : item
  );
}

module.exports = {
  priceFrom, parseVariation, NETWORK_BY_SERVICE, proposeAction, refuseSharedMatches, norm,
};
