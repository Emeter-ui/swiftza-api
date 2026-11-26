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
    // The buy page is never linked: purchases happen in a chat card instead.
    expect(res.body.actions.map((a) => a.to)).toEqual(['/dashboard/transactions/pur_aaaaaaaaaaaa']);

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
    stubLlm({ openrouter: { reply: 'ok', widget: { type: 'buy', service: 'airtime', amount: 500 }, actions: [{ route: '/dashboard/wallet', params: {} }, { route: '/dashboard/transactions' }] } });
    const res = await chat('u1', 'buy airtime');
    expect(res.body.actions.map((a) => a.to)).toEqual(['/dashboard/wallet']);
    // Purchases are switched off, so no purchase card either.
    expect(res.body.widget).toBeNull();
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

  describe('in-chat cards', () => {
    const catalogRepo = require('../../src/repositories/catalog');
    beforeEach(async () => {
      await catalogRepo.insertMany('NETWORKS', [{ _id: 'net-mtn', name: 'MTN' }, { _id: 'net-glo', name: 'Glo' }, { _id: 'net-off', name: 'Airtel', active: false }]);
      await catalogRepo.insertMany('DATAPACKS', [
        { _id: 'plan-mtn-2gb', networkId: 'net-mtn', planType: 'SME', Size: '2GB', Validity: '30 days', Amount: '₦2000.0' },
        { _id: 'plan-glo-1gb', networkId: 'net-glo', planType: 'SME', Size: '1GB', Validity: '30 days', Amount: '₦500.0' },
      ]);
      await catalogRepo.insertMany('CABLES', [{ _id: 'cab-gotv', CableName: 'GOTV' }]);
      await catalogRepo.insertMany('CABLESPLAN', [{ _id: 'gotv-max', category: 'gotv', CableplanName: 'GOtv Max', amount: 6000 }]);
      await catalogRepo.insertMany('ELECTRICITY', [{ _id: 'disco-ie', Disconame: 'Ikeja Electric' }]);
      await catalogRepo.insertMany('EPIN', [{ _id: 'exam-waec', examName: 'WAEC', amount: 3500 }]);
    });
    // A fresh account per message keeps clear of the per-user burst limit;
    // 'u1' means a funded wallet and 'u2' a ₦10 one.
    let seq = 0;
    const asUser = async (base) => {
      const uid = `${base}-${++seq}`;
      await users.create(uid, { email: `${uid}@x.com`, fullname: 'Test User', account: 'USER', balance: base === 'u2' ? 10 : 4200 });
      return uid;
    };
    const ask = async (base, message, model) => {
      stubLlm({ openrouter: model });
      return (await chat(await asUser(base), message)).body;
    };

    it('resolves names to catalog ids and keeps only valid details', async () => {
      const body = await ask('u1', 'buy 2gb mtn data for 08031234567', {
        reply: 'Here you go', widget: { type: 'buy', service: 'data', network: 'mtn', planId: 'plan-mtn-2gb', phone: '+2348031234567', amount: 1 },
      });
      expect(body.widget).toEqual({ type: 'buy', service: 'data', networkId: 'net-mtn', planId: 'plan-mtn-2gb', phone: '08031234567' });
      expect(body.lowBalance).toBe(false);
      expect(body.balance).toBe(4200);
    });

    it('drops a plan from another network, inactive networks and out-of-range amounts', async () => {
      const data = await ask('u1', 'data', { reply: 'ok', widget: { type: 'buy', service: 'data', network: 'Glo', planId: 'plan-mtn-2gb' } });
      expect(data.widget).toEqual({ type: 'buy', service: 'data', networkId: 'net-glo' });
      const airtime = await ask('u1', 'airtime', { reply: 'ok', widget: { type: 'buy', service: 'airtime', network: 'Airtel', amount: 99999999, phone: '123' } });
      expect(airtime.widget).toEqual({ type: 'buy', service: 'airtime' });
    });

    it('finds the cable provider from the plan, and other services by name', async () => {
      const cable = await ask('u1', 'renew gotv', { reply: 'ok', widget: { type: 'buy', service: 'cable', planId: 'gotv-max', smartcard: '703 281 940' } });
      expect(cable.widget).toEqual({ type: 'buy', service: 'cable', providerId: 'cab-gotv', planId: 'gotv-max', smartcard: '703281940' });
      const light = await ask('u1', 'light', { reply: 'ok', widget: { type: 'buy', service: 'electricity', disco: 'ikeja', meterType: 'Prepaid', meter: '45012345678', amount: 5000 } });
      expect(light.widget).toEqual({ type: 'buy', service: 'electricity', discoId: 'disco-ie', meterType: 'prepaid', meter: '45012345678', amount: 5000 });
      const exam = await ask('u1', 'waec', { reply: 'ok', widget: { type: 'buy', service: 'exam', provider: 'waec', quantity: 2 } });
      expect(exam.widget).toEqual({ type: 'buy', service: 'exam', examId: 'exam-waec', quantity: 2 });
    });

    it('opens the service picker for an unknown or missing service, and ignores junk', async () => {
      expect((await ask('u1', 'pay a bill', { reply: 'ok', widget: { type: 'buy', service: 'betting' } })).widget).toEqual({ type: 'buy' });
      expect((await ask('u1', 'hi', { reply: 'ok', widget: { type: 'transfer', amount: 5000 } })).widget).toBeNull();
    });

    it('does not offer bill or top-up pages as links', async () => {
      const body = await ask('u1', 'top up', { reply: 'ok', actions: [{ route: '/dashboard/wallet/fund', params: { amount: 5000 } }, { route: '/dashboard/buy/data' }] });
      expect(body.actions).toEqual([]);
    });

    it('checks a top-up amount against the deposit limits', async () => {
      const ok = await ask('u1', 'add 5000', { reply: 'ok', widget: { type: 'fund_wallet', amount: '5,000' } });
      expect(ok.widget).toEqual({ type: 'fund_wallet', amount: 5000 });
      const tooBig = await ask('u1', 'add a lot', { reply: 'ok', widget: { type: 'fund_wallet', amount: 50000000 } });
      expect(tooBig.widget).toEqual({ type: 'fund_wallet' });
    });

    describe('low balance (₦100 or less)', () => {
      it('turns a purchase into a top-up that remembers the purchase, with no links', async () => {
        const calls = stubLlm({ openrouter: {
          reply: 'Your balance is too low. How much would you like to add?',
          widget: { type: 'buy', service: 'data', network: 'MTN', planId: 'plan-mtn-2gb' },
          actions: [{ route: '/dashboard/wallet' }],
        } });
        const body = (await chat(await asUser('u2'), 'buy mtn 2gb')).body;
        expect(body.lowBalance).toBe(true);
        expect(body.widget).toEqual({ type: 'fund_wallet', reason: 'low_balance', then: { type: 'buy', service: 'data', networkId: 'net-mtn', planId: 'plan-mtn-2gb' } });
        expect(body.actions).toEqual([]);
        const system = calls[0].body.messages[0].content;
        expect(system).toContain('LOW BALANCE MODE');
        expect(system).not.toContain('- /dashboard/wallet —');
      });

      it('adds the top-up card when the model forgets it, and keeps replies short', async () => {
        const long = 'Your wallet is low. '.repeat(40);
        const body = await ask('u2', 'recharge my line', { reply: long, widget: null });
        expect(body.widget).toEqual({ type: 'fund_wallet', reason: 'low_balance' });
        expect(body.reply.length).toBeLessThanOrEqual(320);
      });

      it('answers other questions without a card', async () => {
        const body = await ask('u2', 'when was my last transaction?', { reply: 'Today at 9am.', widget: null });
        expect(body.widget).toBeNull();
      });

      it('follows the admin threshold', async () => {
        await request(app).put('/admin/ai/settings').set('Authorization', token('adm', 'ADMIN')).send({ settings: { lowBalanceThreshold: 5 } });
        const body = await ask('u2', 'buy glo data', { reply: 'ok', widget: { type: 'buy', service: 'data', network: 'glo' } });
        expect(body.lowBalance).toBe(false);
        expect(body.widget).toEqual({ type: 'buy', service: 'data', networkId: 'net-glo' });
      });
    });
  });

  describe('signed-out visitors', () => {
    const catalogRepo = require('../../src/repositories/catalog');
    let ipSeq = 0;
    let ip;
    beforeEach(async () => {
      ip = `10.9.0.${++ipSeq}`;
      await catalogRepo.insertMany('NETWORKS', [{ _id: 'net-mtn', name: 'MTN' }]);
      await catalogRepo.insertMany('DATAPACKS', [{ _id: 'plan-mtn-1gb', networkId: 'net-mtn', planType: 'SME', Size: '1GB', Validity: '30 days', Amount: '₦700.0' }]);
    });
    const visit = (message, { visitor = 'visitor-abc123', headers = {} } = {}) => {
      let r = request(app).post('/ai/chat').set('X-Forwarded-For', ip).set('X-Visitor-Id', visitor);
      for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
      return r.send({ message });
    };

    it('serves the visitor greeting without a session', async () => {
      const res = await request(app).get('/ai/config');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ signedIn: false, guestEnabled: true });
      expect(res.body.greeting).toMatch(/sign in/i);
      expect(res.body.suggestions).toContain('Log in');
    });

    it('answers from public data only and turns a purchase into the sign-in card', async () => {
      const calls = stubLlm({ openrouter: { reply: 'Sign in first', widget: { type: 'buy', service: 'data', network: 'MTN', planId: 'plan-mtn-1gb' }, actions: [{ route: '/dashboard/wallet' }] } });
      const res = await visit('buy mtn 1gb');
      expect(res.status).toBe(200);
      expect(res.body.signedIn).toBe(false);
      expect(res.body.balance).toBeUndefined();
      expect(res.body.actions).toEqual([]);
      expect(res.body.widget).toEqual({ type: 'auth', mode: 'login', then: { type: 'buy', service: 'data', networkId: 'net-mtn', planId: 'plan-mtn-1gb' } });
      const system = calls[0].body.messages[0].content;
      expect(system).toContain('NOT signed in');
      expect(system).toContain('1GB');
      expect(system).not.toContain('CUSTOMER:');
      expect(system).not.toContain('WALLET LEDGER');
    });

    it('adds the sign-in card for account requests the model forgot, but not for price questions', async () => {
      stubLlm({ openrouter: { reply: 'Please sign in.', widget: null } });
      expect((await visit("what's my balance?")).body.widget).toEqual({ type: 'auth', mode: 'login' });
      expect((await visit('I want to create an account')).body.widget).toEqual({ type: 'auth', mode: 'register' });
      expect((await visit('how much is MTN 1GB?')).body.widget).toBeNull();
    });

    it('never gives a visitor a buy or top-up card directly', async () => {
      stubLlm({ openrouter: { reply: 'ok', widget: { type: 'fund_wallet', amount: 5000 } } });
      const res = await visit('add 5000');
      expect(res.body.widget).toEqual({ type: 'auth', mode: 'login', then: { type: 'fund_wallet', amount: 5000 } });
    });

    it('logs visitors without an account and limits them per browser', async () => {
      await request(app).put('/admin/ai/settings').set('Authorization', token('adm', 'ADMIN')).send({ settings: { guestRateLimitPerHour: 1 } });
      stubLlm({ openrouter: { reply: 'hi', widget: null } });
      expect((await visit('hello', { visitor: 'browser-one-1' })).status).toBe(200);
      const second = await visit('hello again', { visitor: 'browser-one-1' });
      expect(second.status).toBe(429);
      expect(second.body.code).toBe('AI_RATE_LIMITED');
      const log = await collection('AILOGS').findOne({ visitor: 'browser-one-1' });
      expect(log).toMatchObject({ uid: null, ip });
    });

    it('limits visitors per network address even with fresh browser ids', async () => {
      await request(app).put('/admin/ai/settings').set('Authorization', token('adm', 'ADMIN')).send({ settings: { guestIpRateLimitPerHour: 2 } });
      stubLlm({ openrouter: { reply: 'hi', widget: null } });
      expect((await visit('a', { visitor: 'fresh-id-0001' })).status).toBe(200);
      expect((await visit('b', { visitor: 'fresh-id-0002' })).status).toBe(200);
      expect((await visit('c', { visitor: 'fresh-id-0003' })).status).toBe(429);
    });

    it('can be switched off, and an invalid session is never treated as a visitor', async () => {
      await request(app).put('/admin/ai/settings').set('Authorization', token('adm', 'ADMIN')).send({ settings: { guestEnabled: false } });
      const spy = vi.spyOn(globalThis, 'fetch');
      const off = await visit('hello');
      expect(off.status).toBe(403);
      expect(off.body.code).toBe('AI_SIGN_IN_REQUIRED');
      const forged = await visit('hello', { headers: { Authorization: 'Bearer not-a-real-token' } });
      expect(forged.status).toBe(401);
      expect(spy).not.toHaveBeenCalled();
    });

    it('keeps voice transcription for signed-in customers', async () => {
      const res = await request(app).post('/ai/transcribe').send({ audio: 'AAAA', mimeType: 'audio/mp4' });
      expect(res.status).toBe(401);
    });
  });

  describe('voice transcription', () => {
    // ~2 KB of fake audio: the route only checks type, encoding and size.
    const audio = Buffer.alloc(2048, 7).toString('base64');
    // The burst limiter is per user and outlives a test, so each test speaks as its own user.
    let n = 0;
    beforeEach(() => { n += 1; });
    const transcribe = (body, uid = `voice-${n}`) => request(app).post('/ai/transcribe').set('Authorization', token(uid)).send(body);
    const stubGemini = (text, status = 200) => vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status,
      text: async () => JSON.stringify(status === 200 ? { candidates: [{ content: { parts: [{ text }] } }] } : { error: { message: 'boom' } }),
    });

    it('requires a session', async () => {
      const res = await request(app).post('/ai/transcribe').send({ audio, mimeType: 'audio/mp4' });
      expect(res.status).toBe(401);
    });

    it('sends the clip to Gemini and returns cleaned text', async () => {
      const spy = stubGemini('Transcript: "Buy ₦500 MTN airtime"');
      const res = await transcribe({ audio, mimeType: 'audio/ogg;codecs=opus' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ text: 'Buy ₦500 MTN airtime' });
      const [url, init] = spy.mock.calls[0];
      expect(String(url)).toContain('generativelanguage');
      const part = JSON.parse(init.body).contents[0].parts[1].inline_data;
      expect(part).toEqual({ mime_type: 'audio/ogg', data: audio });
    });

    it('accepts a body above the global 100 KB JSON limit', async () => {
      stubGemini('hello');
      const big = Buffer.alloc(300 * 1024, 1).toString('base64');
      expect((await transcribe({ audio: big, mimeType: 'audio/webm' })).status).toBe(200);
    });

    it('rejects unknown formats, bad base64 and oversized clips before calling Gemini', async () => {
      const spy = stubGemini('x');
      expect((await transcribe({ audio, mimeType: 'video/mp4' })).status).toBe(422);
      expect((await transcribe({ audio: 'not base64!!', mimeType: 'audio/mp4' })).status).toBe(422);
      const tooBig = Buffer.alloc(1024 * 1024 + 10, 1).toString('base64');
      expect((await transcribe({ audio: tooBig, mimeType: 'audio/mp4' })).status).toBe(422);
      expect(spy).not.toHaveBeenCalled();
    });

    it('returns a friendly 503 when Gemini fails or the assistant is off', async () => {
      stubGemini(null, 500);
      const failed = await transcribe({ audio, mimeType: 'audio/mp4' });
      expect(failed.status).toBe(503);
      expect(failed.body.code).toBe('AI_UNAVAILABLE');

      vi.restoreAllMocks();
      await request(app).put('/admin/ai/settings').set('Authorization', token('adm', 'ADMIN')).send({ settings: { enabled: false } });
      const spy = vi.spyOn(globalThis, 'fetch');
      expect((await transcribe({ audio, mimeType: 'audio/mp4' })).status).toBe(503);
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
