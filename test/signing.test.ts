import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { configFromEnv, createApp, sameSecret } from '../src/app.ts';
import type { CaptureResult } from '../src/capture.ts';
import type { ScreenshotOptions } from '../src/options.ts';
import { canonicalQuery, sign, verifySignedQuery } from '../src/signing.ts';

const SECRET = 'a-long-random-signing-secret';
const KEY = 'a-long-random-test-key';

const result: CaptureResult = {
  image: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  contentType: 'image/png',
  info: { finalUrl: 'https://example.com/', status: 200, removed: 0, consentManager: null, pageHeight: null, truncated: false, overlayRemaining: null },
};

/** Builds a signed path the way the README tells users to. */
async function signedPath(params: Record<string, string>, secret = SECRET): Promise<string> {
  const query = new URLSearchParams(params);
  const signature = await sign(canonicalQuery(query), secret);
  return `/screenshot?${query}&signature=${signature}`;
}

function setup(env: Record<string, string> = { API_KEY: KEY, SIGNING_SECRET: SECRET }) {
  const screenshot = vi.fn(async (_opts: ScreenshotOptions) => result);
  return { app: createApp({ ...configFromEnv(env), screenshot }), screenshot };
}

describe('canonicalQuery', () => {
  it('sorts by name, leaves out the signature and encodes as RFC 3986', () => {
    const q = new URLSearchParams('url=https://example.com/a b?x=1&full_page=true&signature=abc&hide_selectors=.a,(b)');
    expect(canonicalQuery(q)).toBe('full_page=true&hide_selectors=.a%2C%28b%29&url=https%3A%2F%2Fexample.com%2Fa%20b%3Fx%3D1');
  });

  it('gives the same string however the URL was encoded', () => {
    expect(canonicalQuery(new URLSearchParams('url=https://example.com/caf%C3%A9'))).toBe(
      canonicalQuery(new URLSearchParams('url=https%3A%2F%2Fexample.com%2Fcafé')),
    );
  });

  it('refuses a name that appears twice', () => {
    expect(() => canonicalQuery(new URLSearchParams('url=a&url=b'))).toThrow(/twice/);
  });

  it('matches a plain HMAC-SHA256, so any language can make one', async () => {
    const text = 'full_page=true&url=https%3A%2F%2Fexample.com';
    expect(await sign(text, SECRET)).toBe(createHmac('sha256', SECRET).update(text).digest('hex'));
  });
});

describe('verifySignedQuery', () => {
  const at = (params: Record<string, string>, signature: string) => new URLSearchParams({ ...params, signature });

  it('accepts a valid signature in upper or lower case', async () => {
    const params = { url: 'https://example.com' };
    const sig = await sign(canonicalQuery(new URLSearchParams(params)), SECRET);
    expect(await verifySignedQuery(at(params, sig), SECRET, sameSecret)).toBeNull();
    expect(await verifySignedQuery(at(params, sig.toUpperCase()), SECRET, sameSecret)).toBeNull();
  });

  it('returns the expiry while it is in the future, and refuses it after', async () => {
    const params = { url: 'https://example.com', expires: '2000000000' };
    const sig = await sign(canonicalQuery(new URLSearchParams(params)), SECRET);
    expect(await verifySignedQuery(at(params, sig), SECRET, sameSecret, 1_999_999_999_000)).toBe(2000000000);
    await expect(verifySignedQuery(at(params, sig), SECRET, sameSecret, 2_000_000_000_000)).rejects.toMatchObject({
      code: 'unauthorized', reason: 'signature_expired',
    });
  });
});

describe('signed requests', () => {
  it('get a shot without the key', async () => {
    const { app, screenshot } = setup();
    const res = await app.request(await signedPath({ url: 'https://example.com', full_page: 'true' }));
    expect(res.status).toBe(200);
    expect(screenshot.mock.calls[0]![0]).toMatchObject({ url: 'https://example.com/', fullPage: true });
  });

  it('work in any parameter order', async () => {
    const { app } = setup();
    const sig = await sign('full_page=true&url=https%3A%2F%2Fexample.com', SECRET);
    expect((await app.request(`/screenshot?url=https://example.com&full_page=true&signature=${sig}`)).status).toBe(200);
  });

  it('fail when any parameter is changed, added or removed', async () => {
    const { app, screenshot } = setup();
    const path = await signedPath({ url: 'https://example.com', full_page: 'true' });
    for (const tampered of [
      path.replace('full_page=true', 'full_page=false'),
      path.replace('example.com', 'example.org'),
      `${path}&delay=5`,
      path.replace('&full_page=true', ''),
      path.replace(/signature=[0-9a-f]+/, 'signature=' + '0'.repeat(64)),
      path.replace(/signature=[0-9a-f]+/, 'signature='),
    ]) {
      const res = await app.request(tampered);
      expect(res.status, tampered).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'unauthorized' });
    }
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('fail when made with another secret', async () => {
    const { app } = setup();
    expect((await app.request(await signedPath({ url: 'https://example.com' }, 'another-long-random-secret'))).status).toBe(401);
  });

  it('fail once expired, with a reason', async () => {
    const { app, screenshot } = setup();
    const past = String(Math.floor(Date.now() / 1000) - 60);
    const res = await app.request(await signedPath({ url: 'https://example.com', expires: past }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized', reason: 'signature_expired' });
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('work until they expire', async () => {
    const { app } = setup();
    const soon = String(Math.floor(Date.now() / 1000) + 600);
    const res = await app.request(await signedPath({ url: 'https://example.com', expires: soon }));
    expect(res.status).toBe(200);
  });

  it('are refused when the server has no signing secret', async () => {
    const { app } = setup({ API_KEY: KEY });
    const res = await app.request(await signedPath({ url: 'https://example.com' }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { message: string }).message).toMatch(/SIGNING_SECRET/);
  });

  it('are refused as POST', async () => {
    const { app } = setup();
    const path = await signedPath({ url: 'https://example.com' });
    const res = await app.request(path, { method: 'POST', body: '{"url":"https://example.com"}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
  });

  it('do not open the server to unsigned requests when only a signing secret is set', async () => {
    const { app, screenshot } = setup({ SIGNING_SECRET: SECRET });
    expect((await app.request('/screenshot?url=https://example.com')).status).toBe(401);
    expect((await app.request(`/screenshot?url=https://example.com&access_key=${SECRET}`)).status).toBe(401);
    expect(screenshot).not.toHaveBeenCalled();
    expect((await app.request(await signedPath({ url: 'https://example.com' }))).status).toBe(200);
  });

  it('leave the key working next to them', async () => {
    const { app } = setup();
    expect((await app.request('/screenshot?url=example.com', { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(200);
  });

  it('are refused when the signing secret is weak', async () => {
    const { app } = setup({ API_KEY: KEY, SIGNING_SECRET: 'change-me' });
    const res = await app.request(await signedPath({ url: 'https://example.com' }, 'change-me'));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'not_configured' });
  });
});
