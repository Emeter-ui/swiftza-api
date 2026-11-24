const { request, OK } = require('../models/http');
const config = require('../config/env');

// Two upstreams behind one call. OpenRouter is OpenAI-compatible and does its
// own model fallback when given `models`; Gemini is called directly as the
// last resort, so an OpenRouter outage (or exhausted credit) does not take the
// assistant down.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_LATEST = 'gemini-flash-latest';

const keys = {
  openrouter: () => config.optional('OPENROUTER_API_KEY', ''),
  gemini: () => config.optional('GEMINI_API_KEY', ''),
};

function status() {
  return { openrouter: !!keys.openrouter(), gemini: !!keys.gemini() };
}

class LlmError extends Error {
  constructor(provider, reason, detail) {
    super(`${provider}: ${reason}`);
    this.provider = provider;
    this.reason = reason;
    this.detail = detail;
  }
}

function upstreamMessage(res) {
  const b = res.body;
  return (b && (b.error?.message || b.error?.status || b.message)) || res.reason || `HTTP ${res.httpStatus}`;
}

async function openrouter({ system, messages, settings, json }) {
  const key = keys.openrouter();
  if (!key) throw new LlmError('openrouter', 'not configured');
  const fallbacks = (settings.openrouterFallbackModels || []).filter(Boolean);
  const body = {
    model: settings.openrouterModel,
    ...(fallbacks.length ? { models: [settings.openrouterModel, ...fallbacks] } : {}),
    messages: [{ role: 'system', content: system }, ...messages],
    temperature: settings.temperature,
    max_tokens: settings.maxOutputTokens,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  };
  const res = await request(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': config.optional('AI_APP_URL', 'https://swiftza.app'),
      'X-Title': 'Swiftza',
    },
    body,
    timeoutMs: settings.requestTimeoutMs,
  });
  if (res.outcome !== OK) throw new LlmError('openrouter', upstreamMessage(res), res.body);
  if (res.body?.error) throw new LlmError('openrouter', upstreamMessage(res), res.body);
  const text = res.body?.choices?.[0]?.message?.content;
  if (!text) throw new LlmError('openrouter', 'empty response', res.body);
  return {
    text,
    provider: 'openrouter',
    model: res.body.model || settings.openrouterModel,
    tokensIn: res.body.usage?.prompt_tokens ?? null,
    tokensOut: res.body.usage?.completion_tokens ?? null,
  };
}

async function gemini({ system, messages, settings, json }) {
  const key = keys.gemini();
  if (!key) throw new LlmError('gemini', 'not configured');
  let model = settings.geminiModel || GEMINI_LATEST;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: {
      temperature: settings.temperature,
      maxOutputTokens: settings.maxOutputTokens,
      ...(json ? { responseMimeType: 'application/json' } : {}),
    },
  };
  const call = (m) => request(`${GEMINI_BASE}/${encodeURIComponent(m)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key },
    body,
    timeoutMs: settings.requestTimeoutMs,
  });
  let res = await call(model);
  // Google retires models (and closes old ones to new accounts) with a 404.
  // Retry once on the always-current alias so a stale admin setting doesn't
  // take the fallback provider down.
  if (res.outcome !== OK && res.httpStatus === 404 && model !== GEMINI_LATEST) {
    model = GEMINI_LATEST;
    res = await call(model);
  }
  if (res.outcome !== OK) throw new LlmError('gemini', upstreamMessage(res), res.body);
  const cand = res.body?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new LlmError('gemini', cand?.finishReason ? `no text (${cand.finishReason})` : 'empty response', res.body);
  return {
    text,
    provider: 'gemini',
    model,
    tokensIn: res.body.usageMetadata?.promptTokenCount ?? null,
    tokensOut: res.body.usageMetadata?.candidatesTokenCount ?? null,
  };
}

const PROVIDERS = { openrouter, gemini };

// Tries the configured primary, then the other one. Returns the first answer
// along with every failure on the way, so the admin log shows why a fallback
// was used.
async function complete({ system, messages, settings, json = true }) {
  const order = settings.primaryProvider === 'gemini' ? ['gemini', 'openrouter'] : ['openrouter', 'gemini'];
  const chain = settings.useGeminiFallback === false && order[0] === 'openrouter' ? ['openrouter'] : order;
  const failures = [];
  const started = Date.now();
  for (const name of chain) {
    try {
      const out = await PROVIDERS[name]({ system, messages, settings, json });
      return { ...out, latencyMs: Date.now() - started, failures };
    } catch (err) {
      failures.push({ provider: name, reason: err.reason || err.message });
    }
  }
  const e = new LlmError('all', 'every AI provider failed');
  e.failures = failures;
  throw e;
}

module.exports = { complete, status, LlmError, OPENROUTER_URL, GEMINI_BASE };
