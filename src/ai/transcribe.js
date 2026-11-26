const { request, OK } = require('../models/http');
const config = require('../config/env');
const aiSettings = require('../repositories/ai-settings');
const { GEMINI_BASE } = require('./llm');
const { AppError, validationFailed } = require('../models/errors');
const logger = require('../services/logger');

// Voice notes from the AI chat box, for browsers without built-in speech
// recognition (Firefox, some in-app browsers) or whose recogniser cannot reach
// its service (Brave). Gemini only: OpenRouter's audio input takes wav/mp3,
// and browsers record mp4, ogg or webm.
//
// The transcript goes back into the customer's input box; they read it and
// press send themselves, so a mishearing is never acted on.

const GEMINI_DEFAULT = 'gemini-flash-latest';
// What MediaRecorder produces in each browser, and nothing else.
const MIME_TYPES = ['audio/mp4', 'audio/ogg', 'audio/webm', 'audio/mpeg', 'audio/wav', 'audio/aac'];
// 30 seconds at the client's 24 kbps is ~90 KB; this leaves room for browsers
// that ignore the requested bitrate.
const MAX_BYTES = 1024 * 1024;

const PROMPT = [
  'Transcribe this voice message from a customer of Swiftza, a Nigerian bills and top-up app.',
  'Return ONLY the words spoken, as plain text, with no quotes, labels or commentary.',
  'Write money as digits with the naira sign (₦2,000) and phone numbers as digits.',
  'Keep network and provider names as spoken (MTN, Airtel, Glo, 9mobile, DStv, GOtv, Ikeja Electric).',
  'If nothing intelligible is said, return an empty string.',
].join(' ');

function decode(audio, mimeType) {
  const type = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (!MIME_TYPES.includes(type)) throw validationFailed('Unsupported audio format');
  if (typeof audio !== 'string' || !audio || !/^[A-Za-z0-9+/]+=*$/.test(audio)) {
    throw validationFailed('Audio is missing or not base64');
  }
  const bytes = Buffer.from(audio, 'base64');
  if (!bytes.length) throw validationFailed('Audio is empty');
  if (bytes.length > MAX_BYTES) throw validationFailed('Voice notes can be up to 30 seconds');
  return { type, base64: audio, size: bytes.length };
}

// Models occasionally wrap the answer despite the prompt.
function cleanTranscript(text) {
  return String(text || '')
    .trim()
    .replace(/^(transcript(ion)?|text)\s*:\s*/i, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

async function transcribe({ uid, audio, mimeType }) {
  const clip = decode(audio, mimeType);
  const settings = await aiSettings.load();
  const key = config.optional('GEMINI_API_KEY', '');
  if (!settings.enabled || !key) {
    throw new AppError('AI_UNAVAILABLE', "Voice typing isn't available right now. Please type your message.", 503);
  }

  const model = settings.geminiModel || GEMINI_DEFAULT;
  const call = (m) => request(`${GEMINI_BASE}/${encodeURIComponent(m)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key },
    body: {
      contents: [{ role: 'user', parts: [{ text: PROMPT }, { inline_data: { mime_type: clip.type, data: clip.base64 } }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 400 },
    },
    timeoutMs: settings.requestTimeoutMs,
  });

  const started = Date.now();
  let res = await call(model);
  // Same retired-model recovery as the chat path.
  if (res.outcome !== OK && res.httpStatus === 404 && model !== GEMINI_DEFAULT) res = await call(GEMINI_DEFAULT);

  if (res.outcome !== OK) {
    logger.warn({ uid: String(uid), status: res.httpStatus, reason: res.reason, type: clip.type, size: clip.size }, 'voice transcription failed');
    throw new AppError('AI_UNAVAILABLE', "Couldn't turn that into text. Please try again or type your message.", 503);
  }
  const parts = res.body?.candidates?.[0]?.content?.parts || [];
  const text = cleanTranscript(parts.map((p) => p.text || '').join(''));
  logger.info({ uid: String(uid), type: clip.type, size: clip.size, ms: Date.now() - started, chars: text.length }, 'voice transcribed');
  return { text };
}

module.exports = { transcribe, cleanTranscript, MAX_BYTES, MIME_TYPES };
