// CheapDataHub adapter.
//
// UNVERIFIED: written against CheapDataHub's published reseller docs
// (https://www.cheapdatahub.ng/api/v1/resellers/) but not tested against a
// live account -- they publish no sandbox. Confirm the response shapes below
// with a small live purchase before making this the active provider. The
// response interpretation and requery() are the parts most likely to need
// adjusting.
//
// CheapDataHub identifies everything by its own numeric ids, taken from their
// Plan IDs page: provider_id (network, airtime), bundle_id (data plan),
// disco_id, plan_id (cable plan -- which also determines the cable provider)
// and product_id (exam pin). providers/ids.js picks the cheapdatahub* catalog
// column for each, so the values arriving here are already theirs.
//
// No buy call accepts a client reference, so the only id that can later be
// requeried is the transaction id CheapDataHub returns on the response. A
// purchase that times out has no id at all and can only be resolved by hand
// against their dashboard.

const { request, OK, FAILED: HTTP_FAILED } = require('../models/http');
const { requireSecret, optional } = require('../config/env');
const {
  SERVICES,
  success,
  failed,
  pending,
  extractMessage,
} = require('./contract');

// The docs show status as the strings "true"/"false"; booleans are accepted
// too in case the live API is less quirky than its documentation.
const flag = (value) => String(value ?? '').trim().toLowerCase();

// Transaction-level states named in the webhook docs. A purchase response
// carrying one of the in-flight states is not yet a delivery.
const IN_FLIGHT = new Set(['initiated', 'processing', 'pending']);
const DELIVERED = new Set(['successful', 'success', 'delivered', 'completed']);
const NOT_DELIVERED = new Set(['failed', 'refunded', 'reversed']);

function transactionOf(body) {
  return body?.data?.transaction ?? body?.data ?? body?.transaction ?? null;
}

function transactionStatus(body) {
  const txn = transactionOf(body);
  return flag(txn?.status ?? txn?.trans_status ?? body?.transaction_status);
}

// Their reference (CDH123456) and their numeric transaction id appear on
// different endpoints' responses; either identifies the purchase to a human.
function referenceOf(body) {
  const txn = transactionOf(body);
  return body?.reference ?? body?.transaction_id ?? txn?.reference ?? txn?.id ?? null;
}

// The id GET /transactions/<id>/ accepts. Only the numeric transaction id is
// documented for that path, so a CDH-prefixed reference is not offered.
function requeryIdOf(body) {
  const txn = transactionOf(body);
  return body?.transaction_id ?? txn?.id ?? null;
}

function interpret(res, successMessage) {
  if (res.outcome !== OK) {
    // 4xx is documented as an outright rejection (401 bad key, 402 balance,
    // 409 duplicate, 422/400 validation): this request was not processed.
    if (res.outcome === HTTP_FAILED) {
      return failed(
        extractMessage(res.body, 'Provider rejected the request'),
        { raw: res.body ?? res.raw ?? null }
      );
    }
    return pending('Awaiting confirmation from provider', {
      reason: res.reason,
      raw: res.body ?? res.raw ?? null,
    });
  }

  const body = res.body || {};
  const status = flag(body.status);
  const txnStatus = transactionStatus(body);

  if (status === 'true') {
    // Accepted, but the transaction itself may still be in flight upstream --
    // their FAQ says confirmation can be delayed and arrives by webhook.
    if (IN_FLIGHT.has(txnStatus)) {
      return pending('Transaction is being processed by the provider', {
        reason: 'provider-processing',
        raw: body,
      });
    }
    if (NOT_DELIVERED.has(txnStatus)) {
      return failed(extractMessage(body.message, 'Transaction failed'), { raw: body });
    }
    return success(successMessage, { reference: referenceOf(body), raw: body });
  }

  if (status === 'false') {
    return failed(extractMessage(body.message ?? body, 'Transaction failed'), { raw: body });
  }

  // A 200 with a shape we do not recognise. Treating this as failed would risk
  // refunding a purchase the provider actually fulfilled.
  return pending('Unrecognised provider response', {
    reason: 'unrecognised-shape',
    raw: body,
  });
}

// Attached to every outcome so a held row can be requeried. Null when the
// provider returned no transaction id (timeouts, unparseable bodies).
function withRequestId(result) {
  const id = requeryIdOf(result.raw);
  return { ...result, providerRequestId: id != null ? String(id) : null };
}

function validated(res, failMessage) {
  const valid = res.outcome === OK && flag(res.body?.status) === 'true';
  return valid
    ? { valid: true, data: res.body.data ?? null }
    : {
        valid: false,
        message: extractMessage(res.body?.message, failMessage),
        raw: res.body ?? res.raw ?? null,
      };
}

function create(config = {}) {
  const baseUrl =
    config.baseUrl ||
    optional('PROVIDER_CHEAPDATAHUB_BASE_URL', 'https://www.cheapdatahub.ng/api/v1/resellers');

  const authHeaders = () => ({
    Authorization: `Bearer ${requireSecret('PROVIDER_CHEAPDATAHUB_API_KEY')}`,
  });

  // Every documented path ends in a trailing slash (Django); omitting it
  // turns a POST into a redirect that drops the body.
  const post = (path, body) =>
    request(`${baseUrl}/${path}/`, {
      method: 'POST',
      headers: authHeaders(),
      body,
    });

  return {
    name: 'cheapdatahub',
    supports: [
      SERVICES.DATA,
      SERVICES.AIRTIME,
      SERVICES.CABLE,
      SERVICES.ELECTRICITY,
      SERVICES.EPIN,
    ],

    // One secret, read lazily by authHeaders() on every call. Checked here so
    // a missing key is a named, pre-purchase failure rather than one thrown
    // from inside invoke after funds are already reserved.
    assertConfigured() {
      requireSecret('PROVIDER_CHEAPDATAHUB_API_KEY');
    },

    // The data endpoint takes only the bundle id; the bundle already names
    // its network, so networkId is not sent.
    async buyData({ phone, planId }) {
      const res = await post('data/purchase', {
        bundle_id: Number(planId),
        phone_number: phone,
      });
      return withRequestId(interpret(res, 'Data purchased successfully'));
    },

    async buyAirtime({ networkId, phone, amount }) {
      const res = await post('airtime/purchase', {
        provider_id: Number(networkId),
        phone_number: phone,
        amount: Number(amount),
      });
      return withRequestId(interpret(res, 'Airtime purchased successfully'));
    },

    // The cable plan id determines the provider, so cableId is not sent.
    // `phone` is documented as a field, but neither cable route collects one
    // today; it is sent only when present.
    async buyCable({ planId, smartCard, phone }) {
      const res = await post('cable/purchase', {
        plan_id: Number(planId),
        cardnumber: smartCard,
        ...(phone ? { phone } : {}),
      });
      return withRequestId(interpret(res, 'Cable subscription successful'));
    },

    async buyElectricity({ discoId, meterNumber, meterType, amount, phone }) {
      const res = await post('electricity/purchase', {
        disco_id: Number(discoId),
        meter_number: meterNumber,
        meter_type: String(meterType).toLowerCase(),
        amount: Number(amount),
        ...(phone ? { phone } : {}),
      });
      return withRequestId(interpret(res, 'Electricity top-up successful'));
    },

    // examName carries the CheapDataHub product_id (see providers/ids.js).
    // Quantity must be 1, 2 or 5; anything else is a 4xx and is reversed.
    async buyEpin({ examName, quantity }) {
      const res = await post('exam-pin/purchase', {
        product_id: Number(examName),
        quantity: Number(quantity),
      });
      return withRequestId(interpret(res, 'E-pin purchased successfully'));
    },

    // Validation needs a cable PLAN id, not a provider id -- the plan decides
    // which provider is asked. The CABLES row therefore carries one
    // representative plan id per provider (cheapdatahubValidatePlanId).
    async validateIuc({ smartCard, cableId }) {
      const res = await post('cable/validate', {
        plan_id: Number(cableId),
        smart_card_number: smartCard,
      });
      return validated(res, 'Unable to validate smart card');
    },

    async validateMeter({ meterNumber, discoId, meterType }) {
      const res = await post('electricity/validate', {
        disco_id: Number(discoId),
        meter_type: String(meterType).toLowerCase(),
        meter_number: meterNumber,
      });
      return validated(res, 'Unable to validate meter');
    },

    // Asks what happened to a purchase held at 'requery' status. Only a
    // positively stated transaction status is trusted; every other shape --
    // a 4xx on the status question, an unknown id, a missing status -- is
    // pending, because a status query the provider could not answer is not
    // evidence the purchase failed. Same rule as the other adapters' requery.
    async requery(reference) {
      const res = await request(
        `${baseUrl}/transactions/${encodeURIComponent(reference)}/`,
        { headers: authHeaders() }
      );
      if (res.outcome !== OK) {
        return pending('Unable to confirm transaction status with provider', {
          reason: res.reason ?? 'transport-failed',
          raw: res.body ?? res.raw ?? null,
        });
      }

      const body = res.body || {};
      const status = transactionStatus(body);

      if (DELIVERED.has(status)) {
        return success('Transaction confirmed as delivered by provider', {
          reference: referenceOf(body),
          raw: body,
        });
      }
      if (NOT_DELIVERED.has(status)) {
        return failed(extractMessage(body.message, 'Transaction failed'), { raw: body });
      }
      return pending('Unable to positively confirm transaction status with provider', {
        reason: 'unconfirmed',
        raw: body,
      });
    },
  };
}

module.exports = { create, interpret };
