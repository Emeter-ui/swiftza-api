import { describe, it, expect, vi, afterEach } from 'vitest';
const vtpass = require('../../src/providers/vtpass');
const categories = require('../fixtures/vtpass/service-categories.json');
const services = require('../fixtures/vtpass/services-airtime.json');
const variations = require('../fixtures/vtpass/service-variations-mtn-data.json');

const respond = (body, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status })
  );

describe('vtpass discovery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists categories from the real captured payload', async () => {
    respond(categories);
    const out = await vtpass.create({}).listCategories();

    expect(out.ok).toBe(true);
    // Length and first entry both derived from the fixture, so the assertion
    // cannot encode an assumption the fixture does not support.
    expect(out.items).toHaveLength(categories.content.length);
    expect(out.items[0]).toEqual({
      identifier: categories.content[0].identifier,
      name: categories.content[0].name,
    });
  });

  it('lists services from the real captured payload', async () => {
    respond(services);
    const out = await vtpass.create({}).listServices('airtime');

    expect(out.ok).toBe(true);
    expect(out.items).toHaveLength(services.content.length);
    expect(out.items[0].serviceID).toBe(services.content[0].serviceID);
    expect(out.items[0].name).toBe(services.content[0].name);
  });

  it('lists variations with their real amounts', async () => {
    respond(variations);
    const out = await vtpass.create({}).listVariations('mtn-data');

    expect(out.ok).toBe(true);
    const wire = variations.content.variations ?? variations.content.varations;
    expect(out.items).toHaveLength(wire.length);
    expect(out.items[0].variationCode).toBe(wire[0].variation_code);
    // The amount must come off the wire and never be inferred from the code:
    // VTpass variation codes lie. `mtn-1gb-3500` is a 10GB plan and
    // `mtn-10mb-100` is 100MB. A picker that reads the code name misprices.
    expect(out.items[0].amount).toBe(Number(wire[0].variation_amount));
  });

  // Verified against the live sandbox: these three GET routes return 200 with
  // no headers at all. Refusing to call them because a key is unset would fail
  // closed on a call that demonstrably works without one.
  it('calls discovery with no credentials at all', async () => {
    const api = process.env.PROVIDER_VTPASS_API_KEY;
    const secret = process.env.PROVIDER_VTPASS_SECRET_KEY;
    delete process.env.PROVIDER_VTPASS_API_KEY;
    delete process.env.PROVIDER_VTPASS_SECRET_KEY;
    try {
      const spy = respond(categories);
      const out = await vtpass.create({}).listCategories();

      expect(out.ok).toBe(true);
      const sent = spy.mock.calls[0][1]?.headers ?? {};
      expect(sent['api-key']).toBeUndefined();
      expect(sent['secret-key']).toBeUndefined();
    } finally {
      process.env.PROVIDER_VTPASS_API_KEY = api;
      process.env.PROVIDER_VTPASS_SECRET_KEY = secret;
    }
  });

  it('sends the identifier and serviceID as query parameters', async () => {
    const spy = respond(services);
    await vtpass.create({}).listServices('tv-subscription');
    expect(String(spy.mock.calls[0][0])).toContain('identifier=tv-subscription');

    vi.restoreAllMocks();
    const spy2 = respond(variations);
    await vtpass.create({}).listVariations('mtn-data');
    expect(String(spy2.mock.calls[0][0])).toContain('serviceID=mtn-data');
  });

  it('reports the provider message on a rejection and never throws', async () => {
    respond({ response_description: 'INVALID IDENTIFIER' }, 400);
    const out = await vtpass.create({}).listServices('nonsense');

    expect(out.ok).toBe(false);
    expect(out.message).toBe('INVALID IDENTIFIER');
    expect(out.items).toBeUndefined();
  });

  it('reports a failure, not an empty list, when the transport dies', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
    const out = await vtpass.create({}).listCategories();

    expect(out.ok).toBe(false);
    // An empty items array would render as "VTpass offers nothing", which is a
    // very different claim from "we could not reach VTpass".
    expect(out.items).toBeUndefined();
    expect(out.message).toBeTruthy();
  });

  it('reports a failure when the body is a 200 with no content array', async () => {
    respond({ response_description: '000' });
    const out = await vtpass.create({}).listCategories();
    expect(out.ok).toBe(false);
  });
});
