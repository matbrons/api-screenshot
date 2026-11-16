import { describe, expect, it, vi } from 'vitest';
import { configFromEnv, createApp, sameSecret } from '../src/app.ts';
import type { CaptureResult } from '../src/capture.ts';
import { CaptureError, quotaExceeded } from '../src/errors.ts';
import type { ScreenshotOptions } from '../src/options.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const result: CaptureResult = {
  image: PNG,
  contentType: 'image/png',
  info: { finalUrl: 'https://example.com/', status: 200, removed: 2, consentManager: 'Example CMP', pageHeight: 3000, truncated: false, overlayRemaining: null },
};

function setup(screenshot = vi.fn(async (_opts: ScreenshotOptions) => result), apiKey?: string) {
  const app = createApp({ screenshot, apiKey, allowPublicAccess: !apiKey });
  const call = (path: string, init?: RequestInit) => app.request(path, init);
  return { app, call, screenshot };
}

describe('GET /screenshot', () => {
  it('returns the image with capture details in headers', async () => {
    const { call, screenshot } = setup();
    const res = await call('/screenshot?url=example.com&full_page=true');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-removed-elements')).toBe('2');
    expect(res.headers.get('x-consent-manager')).toBe('Example CMP');
    expect(res.headers.get('x-page-height')).toBe('3000');
    expect(res.headers.has('x-overlay-remaining')).toBe(false);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(screenshot.mock.calls[0]![0]).toMatchObject({ url: 'https://example.com/', fullPage: true });
  });

  it('says when a banner or pop-up is still in the shot', async () => {
    const leftover: CaptureResult = { ...result, info: { ...result.info, overlayRemaining: 'cookie_banner' } };
    const { call } = setup(vi.fn(async () => leftover));
    const res = await call('/screenshot?url=example.com');
    expect(res.headers.get('x-overlay-remaining')).toBe('cookie_banner');
  });

  it('reads options given more than once as a list, and refuses other repeats', async () => {
    const { call, screenshot } = setup();
    const res = await call('/screenshot?url=example.com&click=%23a&click=%23b&headers=X-A:%201&headers=X-B:%202');
    expect(res.status).toBe(200);
    expect(screenshot.mock.calls[0]![0]).toMatchObject({ click: ['#a', '#b'], headers: [['X-A', '1'], ['X-B', '2']] });
    expect((await call('/screenshot?url=example.com&url=example.org')).status).toBe(400);
  });

  it('returns JSON with the details and the file in base64 for response_type=json', async () => {
    const withMeta: CaptureResult = {
      ...result,
      info: { ...result.info, metadata: { title: 'Example', description: 'A page.', openGraph: { title: 'Shared' }, icon: 'https://example.com/favicon.ico', height: 3000 } },
    };
    const { call } = setup(vi.fn(async () => withMeta));
    const res = await call('/screenshot?url=example.com&response_type=json');
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({
      url: 'https://example.com/', final_url: 'https://example.com/', status: 200, title: 'Example', description: 'A page.',
      icon: 'https://example.com/favicon.ico', open_graph: { title: 'Shared' }, page_height: 3000, removed_elements: 2,
      consent_manager: 'Example CMP', overlay_remaining: null, truncated: false,
      content_type: 'image/png', size: 4, image: Buffer.from(PNG).toString('base64'),
    });
    const meta = await (await call('/screenshot?url=example.com&response_type=metadata')).json();
    expect(meta).toMatchObject({ title: 'Example', page_height: 3000 });
    expect(meta).not.toHaveProperty('image');
  });

  it('answers bad options with 400 and never starts a browser', async () => {
    const { call, screenshot } = setup();
    const res = await call('/screenshot?url=example.com&colour=red');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_options' });
    expect(screenshot).not.toHaveBeenCalled();
  });

  it.each([
    [new CaptureError('blocked', 'Bot check', 'captcha'), 422, 'blocked'],
    [new CaptureError('url_not_allowed', 'Private', 'ssrf'), 403, 'url_not_allowed'],
    [new CaptureError('timeout', 'Too slow'), 504, 'timeout'],
    [new CaptureError('busy', 'Busy'), 503, 'busy'],
  ])('turns %s into a JSON error', async (err, status, code) => {
    const { call } = setup(vi.fn(async () => { throw err; }));
    const res = await call('/screenshot?url=example.com');
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error: code, message: err.message });
  });

  it('tells clients to wait until 00:00 UTC when the day is used up', async () => {
    const { call } = setup(vi.fn(async () => { throw quotaExceeded(); }));
    const res = await call('/screenshot?url=example.com');
    expect(res.status).toBe(429);
    const wait = Number(res.headers.get('retry-after'));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(86_400);
    expect(await res.json()).toMatchObject({ error: 'quota_exceeded' });
  });

  it('hides unexpected errors behind a plain 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { call } = setup(vi.fn(async () => { throw new Error('secret internals'); }));
    const res = await call('/screenshot?url=example.com');
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret internals');
    spy.mockRestore();
  });
});

describe('POST /screenshot', () => {
  const post = (body: string, headers: Record<string, string> = {}) => ({
    method: 'POST', body, headers: { 'content-type': 'application/json', ...headers },
  });

  it('takes a JSON body', async () => {
    const { call, screenshot } = setup();
    const res = await call('/screenshot', post(JSON.stringify({ url: 'https://example.com', viewport_width: 390 })));
    expect(res.status).toBe(200);
    expect(screenshot.mock.calls[0]![0]).toMatchObject({ viewportWidth: 390 });
  });

  it('refuses broken or oversized bodies', async () => {
    const { call } = setup();
    expect((await call('/screenshot', post('{nope'))).status).toBe(400);
    expect((await call('/screenshot', post('[1]'))).status).toBe(400);
    const big = JSON.stringify({ url: 'https://example.com', hide_selectors: 'x'.repeat(20000) });
    expect((await call('/screenshot', post(big))).status).toBe(400);
    const huge = JSON.stringify({ html: 'x'.repeat(3 * 1024 * 1024) });
    expect(await (await call('/screenshot', post(huge))).json()).toMatchObject({ message: expect.stringMatching(/too large/) });
  });

  /** A body sent in chunks with no Content-Length, as a client streaming it would. Counts what was read. */
  const chunked = (chunks: Uint8Array[]) => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[pulled++];
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    return { init: { method: 'POST', body, duplex: 'half', headers: { 'content-type': 'application/json' } } as RequestInit, pulled: () => pulled };
  };

  it('stops reading a chunked body without a length once it is too large', async () => {
    const { call, screenshot } = setup();
    const mb = new Uint8Array(1024 * 1024).fill(0x20);
    const { init, pulled } = chunked(Array.from({ length: 50 }, () => mb));
    const res = await call('/screenshot', init);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: expect.stringMatching(/too large/) });
    expect(pulled()).toBeLessThanOrEqual(4); // stopped just past 2 MB, not after all 50
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('counts a body in bytes, not characters', async () => {
    const { call } = setup();
    // 800,000 three-byte characters: under 2 MB as text, 2.4 MB as sent.
    const wide = new TextEncoder().encode(JSON.stringify({ html: '€'.repeat(800_000) }));
    const res = await call('/screenshot', chunked([wide.subarray(0, 1_000_000), wide.subarray(1_000_000)]).init);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: expect.stringMatching(/too large/) });
    const ok = new TextEncoder().encode(JSON.stringify({ html: '<p>€</p>' }));
    expect((await call('/screenshot', chunked([ok.subarray(0, 5), ok.subarray(5)]).init)).status).toBe(200);
  });

  it('takes html to render instead of a URL', async () => {
    const { call, screenshot } = setup();
    const res = await call('/screenshot', post(JSON.stringify({ html: '<h1>Hello</h1>' })));
    expect(res.status).toBe(200);
    expect(screenshot.mock.calls[0]![0]).toMatchObject({ url: null, html: '<h1>Hello</h1>', blockCookieBanners: false });
  });
});

const KEY = 'a-long-random-test-key';

describe('API key', () => {
  it('is required when set, in either header', async () => {
    const { call } = setup(undefined, KEY);
    expect((await call('/screenshot?url=example.com')).status).toBe(401);
    expect((await call('/screenshot?url=example.com', { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(200);
    expect((await call('/screenshot?url=example.com', { headers: { 'x-api-key': KEY } })).status).toBe(200);
  });

  it('is never taken from the URL, where it would end up in logs', async () => {
    const { call, screenshot } = setup(undefined, KEY);
    const inUrl = await call(`/screenshot?url=example.com&access_key=${KEY}`);
    expect(inUrl.status).toBe(401);
    expect(((await inUrl.json()) as { message: string }).message).toMatch(/header.*signed URL/);
    const both = await call(`/screenshot?url=example.com&access_key=${KEY}`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(both.status).toBe(401);
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('is checked before the options', async () => {
    const { call } = setup(undefined, KEY);
    expect((await call('/screenshot?bogus=1')).status).toBe(401);
  });

  it('leaves / and /health open', async () => {
    const { call } = setup(undefined, KEY);
    expect((await call('/health')).status).toBe(200);
    expect((await call('/')).status).toBe(200);
    expect((await call('/nope')).status).toBe(404);
  });

  it('compares keys of any length', async () => {
    expect(await sameSecret('abc', 'abc')).toBe(true);
    expect(await sameSecret('abc', 'abcd')).toBe(false);
    expect(await sameSecret('', 'abc')).toBe(false);
  });
});

describe('without a key', () => {
  const fromEnv = (env: Record<string, string>) => {
    const screenshot = vi.fn(async (_opts: ScreenshotOptions) => result);
    return { app: createApp({ ...configFromEnv(env), screenshot }), screenshot };
  };

  it('refuses screenshots until a key is set or public access is turned on', async () => {
    const { app, screenshot } = fromEnv({});
    const res = await app.request('/screenshot?url=example.com');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'not_configured' });
    expect(screenshot).not.toHaveBeenCalled();
    expect((await app.request('/health')).status).toBe(200);
    expect(((await (await app.request('/')).json()) as { auth: string }).auth).toMatch(/^not configured/);
  });

  it('serves without a key when ALLOW_PUBLIC_ACCESS is true', async () => {
    expect((await fromEnv({ ALLOW_PUBLIC_ACCESS: 'true' }).app.request('/screenshot?url=example.com')).status).toBe(200);
    expect((await fromEnv({ ALLOW_PUBLIC_ACCESS: 'false' }).app.request('/screenshot?url=example.com')).status).toBe(503);
  });

  it.each(['change-me', 'replace-with-a-long-random-string', 'short-key'])('refuses the weak key %s, even with the right key sent', async (key) => {
    const { app, screenshot } = fromEnv({ API_KEY: key, ALLOW_PUBLIC_ACCESS: 'true' });
    const res = await app.request('/screenshot?url=example.com', { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'not_configured', message: expect.stringMatching(/API_KEY/) });
    expect(screenshot).not.toHaveBeenCalled();
  });
});

describe('configFromEnv', () => {
  it('reads settings and ignores nonsense', () => {
    expect(configFromEnv({ API_KEY: ` ${KEY} `, MAX_TIMEOUT_SECONDS: '90', MAX_FULL_PAGE_HEIGHT: 'tall' })).toEqual({
      apiKey: KEY, allowPublicAccess: false, limits: { maxTimeoutSeconds: 90, maxFullPageHeight: 20000 },
      requestProxy: expect.objectContaining({ allowed: false }), cacheTtl: 86400,
    });
    expect(configFromEnv({ API_KEY: '' }).apiKey).toBeUndefined();
    expect(configFromEnv({ ALLOW_PUBLIC_ACCESS: ' TRUE ' }).allowPublicAccess).toBe(true);
    expect(configFromEnv({ ALLOW_PUBLIC_ACCESS: 'nope' }).allowPublicAccess).toBe(false);
    expect(configFromEnv({ CACHE_TTL_SECONDS: '0' }).cacheTtl).toBe(0);
    expect(configFromEnv({ CACHE_TTL_SECONDS: '3600' }).cacheTtl).toBe(3600);
    expect(configFromEnv({ CACHE_TTL_SECONDS: 'soon' }).cacheTtl).toBe(86400);
    expect(configFromEnv({ SIGNING_SECRET: 'short' }).keyProblem).toMatch(/SIGNING_SECRET is too short/);
  });
});
