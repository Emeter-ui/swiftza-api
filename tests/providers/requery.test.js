import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
const husmodata = require('../../src/providers/husmodata');
const vtpass = require('../../src/providers/vtpass');

describe('provider requery', () => {
  beforeEach(() => {
    process.env.PROVIDER_HUSMODATA_TOKEN = 't';
    process.env.PROVIDER_VTPASS_API_KEY = 'k';
    process.env.PROVIDER_VTPASS_SECRET_KEY = 's';
  });
  afterEach(() => vi.restoreAllMocks());

  it('husmodata reports success only when the BODY says so, not merely on HTTP 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ Status: 'successful' }), { status: 200 })
    );
    const a = await husmodata.create({}).requery('pur_1');
    expect(a.status).toBe('success');

    // The trap: husmodata's validate methods treat ANY 200 as success. A 200
    // carrying an error payload must NOT be read as a delivered product. This
    // body is unambiguous -- the provider is explicitly reporting failure --
    // so the outcome must be exactly 'failed', not merely "not success".
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ Status: 'failed', error: 'not found' }), { status: 200 })
    );
    const b = await husmodata.create({}).requery('pur_1');
    expect(b.status).toBe('failed');
  });

  it('husmodata reports pending when the transport fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
    const r = await husmodata.create({}).requery('pur_1');
    expect(r.status).toBe('pending');
  });

  it('husmodata reports pending, not failed, on an HTTP 4xx', async () => {
    // A 4xx from requery means the *status question* was rejected, not that
    // the original purchase failed -- interpret() maps 4xx to 'failed' for
    // buy calls, but that mapping must not apply here. With an unverified
    // requery path, a 404 is the likely first-contact outcome in production.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    );
    const r = await husmodata.create({}).requery('pur_1');
    expect(r.status).toBe('pending');
  });

  it('husmodata reports pending on an unrecognised 200 body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ nonsense: true }), { status: 200 })
    );
    const r = await husmodata.create({}).requery('pur_1');
    expect(r.status).toBe('pending');
  });

  // The real danger case: no husmodata buy call ever sends a client
  // reference, so a requery is unanswerable in principle and a 200 carrying
  // an error payload (e.g. "reference not found") with no explicit Status is
  // the realistic response shape -- NOT the fabricated 'nonsense: true' case
  // above. interpret()'s `if (body.error) return failed(...)` branch would
  // read this as the provider saying the purchase failed, which it never
  // said -- it said nothing about the original purchase. This is the case C1
  // exists to fix.
  it('husmodata reports pending, not failed, on an error payload with no positive status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'reference not found' }), { status: 200 })
    );
    const r = await husmodata.create({}).requery('pur_1');
    expect(r.status).toBe('pending');
  });

  it('husmodata sends the reference to fetch unmodified', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ Status: 'successful' }), { status: 200 })
    );
    await husmodata.create({}).requery('pur_reference_xyz');

    const [url, options] = spy.mock.calls[0];
    expect(String(url)).not.toMatch(/serviceIdFor|planIdFor|validateIdFor/);
    expect(String(options.body)).toContain('pur_reference_xyz');
  });

  it('vtpass maps its delivered status to success and an unknown body to pending', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: '000', content: { transactions: { status: 'delivered' } } }), { status: 200 })
    );
    expect((await vtpass.create({}).requery('pur_1')).status).toBe('success');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ nonsense: true }), { status: 200 })
    );
    expect((await vtpass.create({}).requery('pur_1')).status).toBe('pending');
  });

  // Pins the other positive outcome (husmodata already has an equivalent
  // above): a body that positively states the transaction failed must still
  // report 'failed', not get swept into 'pending' along with everything
  // unmatched.
  it('vtpass maps its positively-failed status to failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: '000', content: { transactions: { status: 'failed' } } }), { status: 200 })
    );
    const r = await vtpass.create({}).requery('pur_1');
    expect(r.status).toBe('failed');
  });

  // The real danger case: buildRequestId() prefixes every buy call's
  // request_id with the current minute, so requery() (which sends the bare
  // reference) is asking about an id VTpass was never given. The realistic
  // response is a 200 with a non-'000' code and a descriptive rejection --
  // NOT the fabricated 'nonsense: true' shape above, which has no code at
  // all. interpret()'s `if (code) return failed(...)` fallback would read
  // this as the provider saying the purchase failed, which it never said.
  // This is the case C1 exists to fix.
  it('vtpass reports pending, not failed, on a 200 with an unmatched request id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ code: '040', response_description: 'TRANSACTION NOT FOUND' }),
        { status: 200 }
      )
    );
    const r = await vtpass.create({}).requery('pur_1');
    expect(r.status).toBe('pending');
  });

  it('vtpass reports pending, not failed, on an HTTP 4xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ response_description: 'not found' }), { status: 404 })
    );
    const r = await vtpass.create({}).requery('pur_1');
    expect(r.status).toBe('pending');
  });

  it('vtpass sends the reference to fetch unmodified', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: '000', content: { transactions: { status: 'delivered' } } }), { status: 200 })
    );
    await vtpass.create({}).requery('pur_reference_xyz');

    const [, options] = spy.mock.calls[0];
    expect(String(options.body)).toContain('pur_reference_xyz');
  });
});

// ── VTpass documented response codes ────────────────────────────────────────
// Added after reading VTpass's published response-code table, which states:
// "Take any response that differs from the guidelines provided here as
// pending, and initiate a transaction requery accordingly."
describe('vtpass response codes on the BUY path', () => {
  beforeEach(() => {
    process.env.PROVIDER_VTPASS_API_KEY = 'k';
    process.env.PROVIDER_VTPASS_SECRET_KEY = 's';
  });
  afterEach(() => vi.restoreAllMocks());

  const buy = async (body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 })
    );
    return vtpass.create({}).buyAirtime({
      networkId: 'mtn', phone: '08011111111', amount: 100, transref: 'pur_x',
    });
  };

  it('treats 099 TRANSACTION IS PROCESSING as pending, never failed', async () => {
    // The bug this pins: 099 means still in flight. Read as failed, the caller
    // reverses a debit for a purchase VTpass may still deliver.
    expect((await buy({ code: '099', response_description: 'TRANSACTION IS PROCESSING' })).status)
      .toBe('pending');
  });

  it('treats 089 REQUEST IS PROCESSING as pending', async () => {
    expect((await buy({ code: '089' })).status).toBe('pending');
  });

  it('still fails outright on a documented rejection', async () => {
    expect((await buy({ code: '016', response_description: 'TRANSACTION FAILED' })).status)
      .toBe('failed');
    expect((await buy({ code: '018' })).status).toBe('failed');
  });

  it('holds 000 with an in-flight nested status', async () => {
    for (const status of ['pending', 'initiated']) {
      const r = await buy({ code: '000', content: { transactions: { status } } });
      expect(r.status).toBe('pending');
    }
    const ok = await buy({ code: '000', content: { transactions: { status: 'delivered' } } });
    expect(ok.status).toBe('success');
  });
});
