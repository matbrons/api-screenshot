import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import {
  cacheKey, cachedScreenshot, kvStore, pack, takeCacheOptions, unpack, type CacheStore, type KvNamespace,
} from '../src/cache.ts';
import type { CaptureResult } from '../src/capture.ts';
import { openDiskStore } from '../src/disk-cache.ts';
import { CaptureError } from '../src/errors.ts';
import { parseOptions, type ScreenshotOptions } from '../src/options.ts';
import { withRetries } from '../src/retry.ts';
import { canonicalQuery, sign } from '../src/signing.ts';

const KEY = 'a-long-random-test-key';
const SECRET = 'a-long-random-signing-secret';

const result: CaptureResult = {
  image: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
  contentType: 'image/png',
  info: { finalUrl: 'https://example.com/', status: 200, removed: 3, consentManager: 'OneTrust', pageHeight: 2400, truncated: false, overlayRemaining: null },
};

function memoryStore(): CacheStore & { data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    put: async (key, value) => void data.set(key, value),
  };
}

function setup(screenshot = vi.fn(async (_opts: ScreenshotOptions) => result)) {
  const store = memoryStore();
  const app = createApp({ screenshot, apiKey: KEY, signingSecret: SECRET, cache: store, cacheTtl: 3600 });
  const call = (query: string) => app.request(`/screenshot?${query}`, { headers: { authorization: `Bearer ${KEY}` } });
  return { app, call, screenshot, store };
}

describe('cache in the API', () => {
  it('takes the shot once and serves it again from the cache, with the same headers', async () => {
    const { call, screenshot } = setup();
    const first = await call('url=example.com&full_page=true');
    expect(first.status).toBe(200);
    expect(first.headers.get('x-cache')).toBe('MISS');
    expect(first.headers.get('cache-control')).toBe('private, max-age=3600');

    const second = await call('url=https://example.com/&full_page=1');
    expect(second.status).toBe(200);
    expect(second.headers.get('x-cache')).toBe('HIT');
    expect(second.headers.get('age')).toBe('0');
    expect(second.headers.get('content-type')).toBe('image/png');
    expect(second.headers.get('x-consent-manager')).toBe('OneTrust');
    expect(second.headers.get('x-removed-elements')).toBe('3');
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(result.image);
    expect(screenshot).toHaveBeenCalledTimes(1);
  });

  it('keeps different options apart', async () => {
    const { call, screenshot } = setup();
    await call('url=example.com');
    await call('url=example.com&full_page=true');
    await call('url=example.com&cache_key=v2');
    expect(screenshot).toHaveBeenCalledTimes(3);
  });

  it('takes a new shot with fresh=true and keeps that one', async () => {
    const { call, screenshot } = setup();
    await call('url=example.com');
    const fresh = await call('url=example.com&fresh=true');
    expect(fresh.headers.get('x-cache')).toBe('BYPASS');
    expect((await call('url=example.com')).headers.get('x-cache')).toBe('HIT');
    expect(screenshot).toHaveBeenCalledTimes(2);
  });

  it('neither reads nor keeps with cache=false or cache_ttl=0', async () => {
    const { call, screenshot, store } = setup();
    for (const q of ['url=example.com&cache=false', 'url=example.com&cache_ttl=0']) {
      const res = await call(q);
      expect(res.headers.get('x-cache')).toBe('BYPASS');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(store.data.size).toBe(0);
    expect(screenshot).toHaveBeenCalledTimes(2);
  });

  it('never keeps a blocked page or a failure', async () => {
    const screenshot = vi.fn(async (_opts: ScreenshotOptions): Promise<CaptureResult> => {
      throw new CaptureError('blocked', 'Bot check', 'captcha');
    });
    const { call, store } = setup(screenshot);
    expect((await call('url=example.com')).status).toBe(422);
    const again = await call('url=example.com');
    expect(again.status).toBe(422);
    expect(again.headers.get('cache-control')).toBe('no-store');
    expect(screenshot).toHaveBeenCalledTimes(2);
    expect(store.data.size).toBe(0);
  });

  it('checks the key before serving from the cache', async () => {
    const { app, call } = setup();
    await call('url=example.com');
    expect((await app.request('/screenshot?url=example.com')).status).toBe(401);
  });

  it('lets shared caches keep a signed shot, but not past its expiry', async () => {
    const { app } = setup();
    const expires = Math.floor(Date.now() / 1000) + 600;
    const query = new URLSearchParams({ url: 'https://example.com', expires: String(expires) });
    const res = await app.request(`/screenshot?${query}&signature=${await sign(canonicalQuery(query), SECRET)}`);
    expect(res.status).toBe(200);
    const maxAge = Number(res.headers.get('cache-control')!.match(/^public, max-age=(\d+)$/)![1]);
    expect(maxAge).toBeGreaterThan(590);
    expect(maxAge).toBeLessThanOrEqual(600);
  });

  it('refuses bad cache options', async () => {
    const { call } = setup();
    for (const q of ['cache_ttl=-1', 'cache_ttl=99999999', 'cache_ttl=1.5', 'fresh=maybe', 'cache=yes']) {
      expect((await call(`url=example.com&${q}`)).status, q).toBe(400);
    }
  });

  it('still answers when the store fails', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken: CacheStore = { get: async () => { throw new Error('down'); }, put: async () => { throw new Error('down'); } };
    const app = createApp({ screenshot: async () => result, apiKey: KEY, cache: broken });
    const res = await app.request('/screenshot?url=example.com', { headers: { 'x-api-key': KEY } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    spy.mockRestore();
  });
});

describe('cachedScreenshot', () => {
  const opts = parseOptions({ url: 'example.com' });

  it('treats cache_ttl as the oldest shot a request accepts', async () => {
    const store = memoryStore();
    let t = 1_000_000;
    const take = vi.fn(async () => result);
    await cachedScreenshot(store, opts, { ttl: 3600, fresh: false, key: null }, take, () => t);
    t += 600_000;
    expect((await cachedScreenshot(store, opts, { ttl: 3600, fresh: false, key: null }, take, () => t)).status).toBe('HIT');
    expect((await cachedScreenshot(store, opts, { ttl: 300, fresh: false, key: null }, take, () => t)).status).toBe('MISS');
    expect(take).toHaveBeenCalledTimes(2);
  });

  it('never serves a shot past the time it was stored for', async () => {
    const store = memoryStore();
    let t = 0;
    const take = vi.fn(async () => result);
    await cachedScreenshot(store, opts, { ttl: 60, fresh: false, key: null }, take, () => t);
    t = 61_000;
    expect((await cachedScreenshot(store, opts, { ttl: 3600, fresh: false, key: null }, take, () => t)).status).toBe('MISS');
  });
});

describe('cache entries', () => {
  it('pack and unpack', () => {
    const entry = unpack(pack(result, 1, 2));
    expect(entry).toMatchObject({ contentType: 'image/png', info: result.info, storedAt: 1, expiresAt: 2 });
    expect(entry!.image).toEqual(result.image);
    expect(unpack(new Uint8Array([0, 0, 0, 9, 1]))).toBeNull();
  });

  it('get one key for the same options however they were written', async () => {
    const a = await cacheKey(parseOptions({ url: 'example.com', full_page: 'true' }), null);
    const b = await cacheKey(parseOptions({ full_page: true, url: 'https://example.com/' }), null);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await cacheKey(parseOptions({ url: 'example.com' }), 'v2')).not.toBe(await cacheKey(parseOptions({ url: 'example.com' }), null));
  });

  it('split cache options from shot options', () => {
    expect(takeCacheOptions({ url: 'x', cache_ttl: '60', fresh: 'true', cache_key: 'a' }, 3600)).toEqual({
      cache: { ttl: 60, fresh: true, key: 'a' }, rest: { url: 'x' },
    });
    expect(takeCacheOptions({ url: 'x' }, 3600).cache).toEqual({ ttl: 3600, fresh: false, key: null });
  });
});

describe('kvStore', () => {
  it('stores bytes with a TTL of at least 60 seconds', async () => {
    const put = vi.fn(async () => undefined);
    const kv: KvNamespace = { get: async () => new Uint8Array([1, 2]).buffer, put };
    const store = kvStore(kv);
    await store.put('k', new Uint8Array([1]), 10);
    expect(put).toHaveBeenCalledWith('k', new Uint8Array([1]), { expirationTtl: 60 });
    expect(await store.get('k')).toEqual(new Uint8Array([1, 2]));
  });
});

describe('openDiskStore', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  const key = (n: number) => String(n).repeat(64).slice(0, 64);

  it('keeps entries across restarts and drops the least recently used past the cap', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'shot-cache-'));
    const store = await openDiskStore(dir, 250);
    await store.put(key(1), new Uint8Array(100).fill(1), 60);
    await store.put(key(2), new Uint8Array(100).fill(2), 60);
    expect(await store.get(key(1))).toEqual(new Uint8Array(100).fill(1)); // 1 is now the most recent
    await store.put(key(3), new Uint8Array(100).fill(3), 60);
    expect(await store.get(key(2))).toBeNull();
    expect((await readdir(dir)).sort()).toEqual([key(1), key(3)]);

    const reopened = await openDiskStore(dir, 250);
    expect(await reopened.get(key(3))).toEqual(new Uint8Array(100).fill(3));
  });

  it('skips entries larger than the cap and refuses keys that are not hashes', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'shot-cache-'));
    const store = await openDiskStore(dir, 50);
    await store.put(key(1), new Uint8Array(100), 60);
    await store.put('../escape', new Uint8Array(1), 60);
    expect(await readdir(dir)).toEqual([]);
    expect(await store.get('../escape')).toBeNull();
  });
});

describe('cache with retries', () => {
  const bot = () => new CaptureError('blocked', 'example.com showed a bot check.', 'bot_check');

  it('keeps a shot that came through on a retry, and never a blocked one', async () => {
    const tries = [new CaptureError('blank', 'example.com rendered an empty page.', 'blank'), result];
    const attempt = vi.fn(async (_opts: ScreenshotOptions) => {
      const next = tries.shift() ?? bot();
      if (next instanceof CaptureError) throw next;
      return next;
    });
    const { call } = setup(vi.fn((opts: ScreenshotOptions) => withRetries(opts, attempt)));

    const first = await call('url=example.com');
    expect(first.status).toBe(200);
    expect(first.headers.get('x-cache')).toBe('MISS');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect((await call('url=example.com')).headers.get('x-cache')).toBe('HIT');
    expect(attempt).toHaveBeenCalledTimes(2);

    // A page that stays blocked is reported each time and never kept.
    for (let i = 0; i < 2; i++) expect((await call('url=example.org')).status).toBe(422);
    expect(attempt).toHaveBeenCalledTimes(4);
  });

  it('checks the key before the cache, so a cached shot never skips it', async () => {
    const { app, call, screenshot } = setup();
    await call('url=example.com');
    const res = await app.request('/screenshot?url=example.com');
    expect(res.status).toBe(401);
    expect(screenshot).toHaveBeenCalledTimes(1);
  });

  it('keeps a shot with "fail_on_status" apart, so a listed status is never served from the cache', async () => {
    const notFound: CaptureResult = { ...result, info: { ...result.info, status: 404 } };
    const { call, screenshot } = setup(vi.fn((opts: ScreenshotOptions) => withRetries(opts, async () => notFound)));
    expect((await call('url=example.com')).status).toBe(200);
    expect((await call('url=example.com&fail_on_status=404')).status).toBe(422);
    expect(screenshot).toHaveBeenCalledTimes(2);
  });
});
