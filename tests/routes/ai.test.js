import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const users = require('../../src/repositories/users');
const { collection } = require('../../src/services/mongo');
const { startTestMongo, stopTestMongo, clearTestMongo } = require('../helpers/mongo');

const token = (uid, account = 'USER') => `Bearer ${jwt.sign({ uid, account }, process.env.JWT_SECRET, { subject: uid })}`;

// Routes each fetch by URL so one test can fail OpenRouter and answer from Gemini.
function stubLlm({ openrouter, gemini }) {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).includes('openrouter.ai')) {
      if (openrouter instanceof Error) throw openrouter;
      if (typeof openrouter === 'number') return { status: openrouter, text: async () => JSON.stringify({ error: { message: 'credit exhausted' } }) };
      return { status: 200, text: async () => JSON.stringify({ model: 'test/model', choices: [{ message: { content: JSON.stringify(openrouter) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
    }
    if (String(url).includes('generativelanguage')) {
      return { status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(gemini) }] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4 } }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

const chat = (uid, message, extra = {}) => request(app).post('/ai/chat').set('Authorization', token(uid)).send({ message, ...extra });

describe('Swiftza AI', () => {
  beforeAll(async () => {
    process.env.OPENROUTER_API_KEY = 'or-test';
    process.env.GEMINI_API_KEY = 'gm-test';
    await startTestMongo();
  });
  afterAll(stopTestMongo);
  beforeEach(async () => {
    await clearTestMongo();
    await users.create('u1', { email: 'u1@x.com', fullname: 'Ada Obi', account: 'USER', balance: 4200 });
    await users.create('u2', { email: 'u2@x.com', fullname: 'Bayo', account: 'USER', balance: 10 });
    await users.create('adm', { email: 'a@x.com', account: 'ADMIN', balance: 0 });
    await collection('TRANSACTIONS').insertOne({ _id: 'pur_aaaaaaaaaaaa', uid: 'u1', transref: 'pur_aaaaaaaaaaaa', transType: 'Data-Reversed', amount: 500, status: 'error', message: 'Plan unavailable', CreatedAt: new Date() });
    await collection('TRANSACTIONS').insertOne({ _id: 'pur_bbbbbbbbbbbb', uid: 'u2', transref: 'pur_bbbbbbbbbbbb', transType: 'Airtime', amount: 9999, status: 'success', CreatedAt: new Date() });
    await collection('WALLETTRANSACTIONS').insertOne({ _id: 'pur_aaaaaaaaaaaa', uid: 'u1', transref: 'pur_aaaaaaaaaaaa', amount: 500, mode: 'credit-reversal', status: 'reversed', prevBal: 3700, newBal: 4200, reversalReason: 'provider rejected', CreatedAt: new Date() });
  });
  afterEach(() => vi.restoreAllMocks());

  it('answers with context, and keeps only valid, owned actions', async () => {
    const calls = stubLlm({
      openrouter: {
        reply: 'Your data purchase was refunded.', in_scope: true,
        actions: [
          { label: 'View receipt', route: '/dashboard/transactions/pur_aaaaaaaaaaaa', params: {} },
          { label: 'Other user receipt', route: '/dashboard/transactions/pur_bbbbbbbbbbbb' },
          { label: 'Evil', route: '/admin', params: {} },
          { label: 'Buy airtime', route: '/dashboard/buy/airtime', params: { network: 'MTN', phone: '08030000000', amount: 500, hack: 'x' } },
        ],
        suggestions: ['Try again'],
      },
    });
    const res = await chat('u1', 'Why was pur_aaaaaaaaaaaa reversed? also show pur_bbbbbbbbbbbb');
    expect(res.status).toBe(200);
    expect(res.body.reply).toMatch(/refunded/);
    expect(res.body.actions.map((a) => a.to)).toEqual([
      '/dashboard/transactions/pur_aaaaaaaaaaaa',
      '/dashboard/buy/airtime?network=MTN&phone=08030000000&amount=500',
    ]);

    const system = calls[0].body.messages[0].content;
    expect(system).toContain('wallet balance ₦4,200');
    expect(system).toContain('refund reason: provider rejected');
    // Another customer's reference is never pulled into this user's context.
    expect(system).toContain('pur_bbbbbbbbbbbb: not found on this account');
    expect(system).not.toContain('9,999');
  });

  it('falls back to Gemini when OpenRouter fails, and logs why', async () => {
    const calls = stubLlm({ openrouter: 402, gemini: { reply: 'Balance is ₦4,200', in_scope: true, actions: [] } });
    const res = await chat('u1', 'What is my balance?');
    expect(res.body.reply).toBe('Balance is ₦4,200');
    expect(calls.map((c) => c.url.includes('gemini') || c.url.includes('generativelanguage'))).toEqual([false, true]);
    const log = await collection('AILOGS').findOne({ uid: 'u1' });
    expect(log.provider).toBe('gemini');
    expect(log.failures[0]).toMatchObject({ provider: 'openrouter' });
  });

  it('returns 503 with a friendly message when every provider fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const res = await chat('u1', 'hello');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_UNAVAILABLE');
  });

  it('drops actions on out-of-scope answers', async () => {
    stubLlm({ openrouter: { reply: 'I can only help with Swiftza.', in_scope: false, actions: [{ route: '/dashboard' }] } });
    const res = await chat('u1', 'Write me a poem about Lagos');
    expect(res.body.inScope).toBe(false);
    expect(res.body.actions).toEqual([]);
  });

  it('tolerates a model that wraps JSON in prose or fences', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'Sure!\n```json\n{"reply":"Hi Ada","actions":[]}\n```' } }] }) });
    const res = await chat('u1', 'hi');
    expect(res.body.reply).toBe('Hi Ada');
  });

  it('enforces the per-hour limit from settings', async () => {
    await request(app).put('/admin/ai/settings').set('Authorization', token('adm', 'ADMIN')).send({ settings: { rateLimitPerHour: 1 } });
    stubLlm({ openrouter: { reply: 'ok', actions: [] } });
    expect((await chat('u1', 'one')).status).toBe(200);
    const second = await chat('u1', 'two');
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('AI_RATE_LIMITED');
  });

  it('returns the maintenance message when disabled, without calling a provider', async () => {
    await request(app).put('/admin/ai/settings').set('Authorization', token('adm', 'ADMIN')).send({ settings: { enabled: false, maintenanceMessage: 'Back soon' } });
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await chat('u1', 'hello');
    expect(res.body.reply).toBe('Back soon');
    expect(spy).not.toHaveBeenCalled();
  });

  it('respects disabled action groups', async () => {
    await request(app).put('/admin/ai/settings').set('Authorization', token('adm', 'ADMIN')).send({ settings: { actionGroups: ['wallet'] } });
    stubLlm({ openrouter: { reply: 'ok', actions: [{ route: '/dashboard/buy/airtime', params: { amount: 100 } }, { route: '/dashboard/wallet/fund', params: { amount: 5000 } }] } });
    const res = await chat('u1', 'top up 5000 and buy airtime');
    expect(res.body.actions.map((a) => a.to)).toEqual(['/dashboard/wallet/fund?amount=5000']);
  });

  it('injects exact fee quotes for amounts in the message', async () => {
    await request(app).post('/admin/fees/rules').set('Authorization', token('adm', 'ADMIN')).send({ rule: { name: 'Std', minAmount: 100, mode: 'on_top', flatFee: 50, percentFee: 1 } });
    const calls = stubLlm({ openrouter: { reply: 'ok', actions: [] } });
    await chat('u1', 'what is the fee to add 7,350?');
    expect(calls[0].body.messages[0].content).toContain('Adding ₦7,350 by card: pays ₦7,473.5, fee ₦123.5');
  });

  it('admin settings validation rejects bad values with field details', async () => {
    const res = await request(app).put('/admin/ai/settings').set('Authorization', token('adm', 'ADMIN')).send({ settings: { temperature: 3, faqs: [{ q: 'only a question' }] } });
    expect(res.status).toBe(422);
    expect(res.body.details.problems.map((p) => p.field)).toEqual(expect.arrayContaining(['temperature', 'faqs']));
  });

  it('admin test run uses draft settings and does not count toward quota', async () => {
    const calls = stubLlm({ openrouter: { reply: 'test ok', actions: [] } });
    const res = await request(app).post('/admin/ai/test').set('Authorization', token('adm', 'ADMIN'))
      .send({ message: 'hi', asUid: 'u1', settings: { assistantName: 'Zee', openrouterModel: 'x/y' } });
    expect(res.status).toBe(200);
    expect(res.body.debug.provider).toBe('openrouter');
    expect(calls[0].body.model).toBe('x/y');
    expect(calls[0].body.messages[0].content).toContain('You are Zee');
    const stats = await request(app).get('/admin/ai/stats').set('Authorization', token('adm', 'ADMIN'));
    expect(stats.body.messages).toBe(0);
  });

  it('serves the greeting with the first name', async () => {
    const res = await request(app).get('/ai/config').set('Authorization', token('u1'));
    expect(res.body.greeting).toMatch(/^Hi Ada/);
  });
});
