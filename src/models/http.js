const { http } = require('../config/env');

// Three outcomes, because "did not succeed" and "we do not know" must never be
// conflated: reversing a balance on UNKNOWN can refund a user for a purchase the
// provider actually fulfilled, so the caller has to be able to tell them apart.
const OK = 'ok';
const FAILED = 'failed';
const UNKNOWN = 'unknown';

function result(outcome, fields) {
  return { outcome, httpStatus: null, body: null, reason: null, ...fields };
}

async function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = http.timeoutMs,
  } = options;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // No reply at all. The upstream may still have processed the request.
    return result(UNKNOWN, {
      reason: err.name === 'TimeoutError' ? 'timeout' : 'network',
      error: err.message,
    });
  }

  let text;
  try {
    text = await response.text();
  } catch (err) {
    return result(UNKNOWN, {
      httpStatus: response.status,
      reason: 'body-read-failed',
      error: err.message,
    });
  }

  let parsed = null;
  let parseFailed = false;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parseFailed = true;
  }

  // 4xx is the provider explicitly rejecting the request, so nothing was
  // charged upstream and this is safe to treat as a definitive failure.
  if (response.status >= 400 && response.status < 500) {
    return result(FAILED, {
      httpStatus: response.status,
      body: parsed,
      reason: parseFailed ? 'client-error-non-json' : 'client-error',
      raw: parseFailed ? text.slice(0, 500) : undefined,
    });
  }

  // 5xx may have been thrown after the purchase was already applied.
  if (response.status >= 500) {
    return result(UNKNOWN, {
      httpStatus: response.status,
      body: parsed,
      reason: 'server-error',
      raw: parseFailed ? text.slice(0, 500) : undefined,
    });
  }

  // 2xx carrying a non-JSON body (maintenance page, HTML error, proxy
  // interstitial). The old code called .json() here and threw straight past
  // the reversal logic, silently keeping the user's money.
  if (parseFailed) {
    return result(UNKNOWN, {
      httpStatus: response.status,
      reason: 'invalid-json',
      raw: text.slice(0, 500),
    });
  }

  return result(OK, { httpStatus: response.status, body: parsed });
}

module.exports = { request, OK, FAILED, UNKNOWN };
