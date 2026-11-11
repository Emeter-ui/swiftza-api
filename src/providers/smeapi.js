// SME API adapter. https://smeapi.com.ng/apidocumentation.html
//
// Auth: Token header. Every buy endpoint requires a unique `ref` per
// transaction — pass transref directly. All numeric provider/network/plan ids
// come from the catalog via providers/ids.js; nothing here guesses them.
//
// Discovery: GET /api/dataplans/ is public and returns a flat plan list —
// no service/variation hierarchy. Cable, electricity and exam IDs must be
// entered manually.
//
// Requery: SME API has no documented requery endpoint. A purchase that times
// out cannot be automatically resolved; check the dashboard for the ref value
// that was sent on the original request.

const { request, OK, FAILED: HTTP_FAILED } = require('../models/http');
const { requireSecret, optional } = require('../config/env');
const {
  SERVICES,
  success,
  failed,
  pending,
  extractMessage,
} = require('./contract');

function interpret(res, successMessage) {
  if (res.outcome !== OK) {
    if (res.outcome === HTTP_FAILED) {
      return failed(
        extractMessage(res.body?.error ?? res.body?.detail ?? res.body, 'Provider rejected the request'),
        { raw: res.body ?? res.raw ?? null }
      );
    }
    return pending('Awaiting confirmation from provider', {
      reason: res.reason,
      raw: res.body ?? res.raw ?? null,
    });
  }

  const body = res.body || {};

  if (body.error || body.detail) {
    return failed(
      extractMessage(body.error ?? body.detail, 'Transaction failed'),
      { raw: body }
    );
  }

  const status = String(body.Status ?? body.status ?? '').toLowerCase();

  if (status === 'successful' || status === 'success') {
    return success(successMessage, {
      reference: body.Ident ?? body.ident ?? body.id ?? body.reference ?? body.ref ?? null,
      raw: body,
    });
  }

  if (status === 'failed' || status === 'unsuccessful') {
    return failed(
      extractMessage(body.api_response ?? body.message ?? body, 'Transaction failed'),
      { raw: body }
    );
  }

  // A 200 with a shape we do not recognise. Treating this as failed would risk
  // refunding a purchase the provider actually fulfilled.
  return pending('Unrecognised provider response', {
    reason: 'unrecognised-shape',
    raw: body,
  });
}

function create(config = {}) {
  const baseUrl =
    config.baseUrl || optional('PROVIDER_SMEAPI_BASE_URL', 'https://smeapi.com.ng');

  const authHeaders = () => ({
    Authorization: `Token ${requireSecret('PROVIDER_SMEAPI_TOKEN')}`,
  });

  const post = (path, body) =>
    request(`${baseUrl}/api/${path}/`, {
      method: 'POST',
      headers: authHeaders(),
      body,
    });

  return {
    name: 'smeapi',
    supports: [
      SERVICES.DATA,
      SERVICES.AIRTIME,
      SERVICES.CABLE,
      SERVICES.ELECTRICITY,
      SERVICES.EPIN,
    ],

    assertConfigured() {
      requireSecret('PROVIDER_SMEAPI_TOKEN');
    },

    // Public endpoint — no auth header required. Returns a flat list of all
    // available data plans. Used by the admin import preview.
    async listDataPlans() {
      const res = await request(`${baseUrl}/api/dataplans/`);
      // Response shape: { status: 'success', data: [...] }
      const items = res.body?.data;
      if (res.outcome !== OK || !Array.isArray(items)) {
        return {
          ok: false,
          message: extractMessage(
            res.body ?? res.error ?? null,
            res.reason === 'timeout'
              ? 'SME API did not respond in time'
              : 'Could not reach SME API'
          ),
        };
      }
      return {
        ok: true,
        items: items.map((p) => ({
          id: p.id ?? null,
          network: String(p.network ?? '').trim(),
          name: p.name ?? null,
          type: p.type ?? null,
          validity: p.days ?? null,
          amount: Number(p.price ?? 0),
        })),
      };
    },

    async buyData({ networkId, phone, planId, transref }) {
      const res = await post('data', {
        network: Number(networkId),
        data_plan: Number(planId),
        phone: String(phone),
        ref: String(transref),
        ported_number: 'false',
      });
      return interpret(res, 'Data purchased successfully');
    },

    async buyAirtime({ networkId, phone, amount, transref }) {
      const res = await post('airtime', {
        network: Number(networkId),
        amount: Number(amount),
        phone: String(phone),
        ref: String(transref),
        ported_number: 'false',
      });
      return interpret(res, 'Airtime purchased successfully');
    },

    async buyCable({ cableId, planId, smartCard, phone, transref }) {
      const res = await post('cabletv', {
        provider: Number(cableId),
        iucnumber: String(smartCard),
        plan: Number(planId),
        ref: String(transref),
        ...(phone ? { phone: String(phone) } : {}),
      });
      return interpret(res, 'Cable subscription successful');
    },

    async buyElectricity({ discoId, meterNumber, meterType, amount, phone, transref }) {
      const res = await post('electricity', {
        provider: Number(discoId),
        metertype: String(meterType).toLowerCase(),
        meternumber: String(meterNumber),
        amount: Number(amount),
        ref: String(transref),
        ...(phone ? { phone: String(phone) } : {}),
      });
      return interpret(res, 'Electricity top-up successful');
    },

    // examName holds the smeapiExamProviderId (numeric) from the catalog.
    async buyEpin({ examName, quantity, transref }) {
      const res = await post('exam', {
        provider: Number(examName),
        quantity: Number(quantity),
        ref: String(transref),
      });
      return interpret(res, 'E-pin purchased successfully');
    },

    async validateIuc({ smartCard, cableId }) {
      const res = await request(`${baseUrl}/api/cabletv/verify/`, {
        method: 'POST',
        headers: authHeaders(),
        body: {
          provider: Number(cableId),
          iucnumber: String(smartCard),
        },
      });
      const valid = res.outcome === OK && !res.body?.error && !res.body?.detail;
      return valid
        ? { valid: true, data: res.body }
        : {
            valid: false,
            message: extractMessage(
              res.body?.error ?? res.body?.detail ?? res.body,
              'Unable to validate smart card'
            ),
            raw: res.body ?? res.raw ?? null,
          };
    },

    async validateMeter({ meterNumber, discoId, meterType }) {
      const res = await request(`${baseUrl}/api/electricity/verify/`, {
        method: 'POST',
        headers: authHeaders(),
        body: {
          provider: Number(discoId),
          metertype: String(meterType).toLowerCase(),
          meternumber: String(meterNumber),
        },
      });
      const valid = res.outcome === OK && !res.body?.error && !res.body?.detail;
      return valid
        ? { valid: true, data: res.body }
        : {
            valid: false,
            message: extractMessage(
              res.body?.error ?? res.body?.detail ?? res.body,
              'Unable to validate meter'
            ),
            raw: res.body ?? res.raw ?? null,
          };
    },

    // No documented requery endpoint. The ref value sent on the original
    // request is the only handle available — look it up in the SME API dashboard.
    async requery(reference) {
      return pending(
        `SME API has no requery endpoint; check the dashboard for ref ${reference}`,
        { reason: 'no-requery-endpoint', raw: null }
      );
    },
  };
}

module.exports = { create };
