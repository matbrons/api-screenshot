// Keeps finished shots, so the same request again costs no browser time.
// Only real shots are kept: a blocked, blank or failed page is an error and is
// never stored. Each runtime brings a byte store: Workers KV on Cloudflare
// (kvStore below), a folder on a server (src/disk-cache.ts).
//
// An entry is one blob: 4 bytes giving the header's length, the header as
// JSON (content type, capture details, when it was stored), then the image.

import type { CaptureResult } from './capture.ts';
import { CaptureError } from './errors.ts';
import type { ScreenshotOptions } from './options.ts';

export interface CacheStore {
  get(key: string): Promise<Uint8Array | null>;
  /** `ttlSeconds` is a hint for stores that expire entries themselves. */
  put(key: string, value: Uint8Array, ttlSeconds: number): Promise<void>;
}

/** What a request asks of the cache. */
interface CacheRequest {
  /** Seconds a stored shot may be reused, and how long a new one is kept. 0 turns caching off. */
  ttl: number;
  /** Take a new shot even when one is stored, then store it. */
  fresh: boolean;
  /** Any text, to keep separate copies of the same shot. */
  key: string | null;
}

type CacheStatus = 'HIT' | 'MISS' | 'BYPASS';

export interface CachedShot {
  result: CaptureResult;
  /** HIT: served from the cache. MISS: taken and stored. BYPASS: taken, cache not read. */
  status: CacheStatus;
  /** Seconds since the shot was taken. */
  age: number;
  /** Seconds the shot may still be reused; 0 when it was not stored. */
  maxAge: number;
}

/** Longest time a request may ask to keep a shot: 30 days. */
export const MAX_CACHE_TTL = 30 * 24 * 3600;
export const DEFAULT_CACHE_TTL = 24 * 3600;

/** Request options that steer the cache rather than the shot. */
export const CACHE_OPTION_NAMES = ['cache', 'cache_ttl', 'cache_key', 'fresh'] as const;

/** Takes the cache options out of a request's raw options and returns the rest. */
export function takeCacheOptions(raw: Record<string, unknown>, defaultTtl: number): { cache: CacheRequest; rest: Record<string, unknown> } {
  const { cache, cache_ttl, cache_key, fresh, ...rest } = raw;
  const flag = (name: string, v: unknown): boolean | null => {
    if (v === undefined || v === null || v === '') return null;
    if (v === true || v === 'true' || v === '1' || v === 1) return true;
    if (v === false || v === 'false' || v === '0' || v === 0) return false;
    throw new CaptureError('invalid_options', `"${name}" must be true or false.`);
  };
  let ttl = defaultTtl;
  if (cache_ttl !== undefined && cache_ttl !== null && cache_ttl !== '') {
    const n = typeof cache_ttl === 'number' ? cache_ttl : typeof cache_ttl === 'string' ? Number(cache_ttl) : NaN;
    if (!Number.isInteger(n) || n < 0 || n > MAX_CACHE_TTL) {
      throw new CaptureError('invalid_options', `"cache_ttl" must be a whole number of seconds from 0 to ${MAX_CACHE_TTL}.`);
    }
    ttl = n;
  }
  if (flag('cache', cache) === false) ttl = 0;
  if (cache_key !== undefined && cache_key !== null && (typeof cache_key !== 'string' || cache_key.length > 200)) {
    throw new CaptureError('invalid_options', '"cache_key" must be a string of up to 200 characters.');
  }
  return { cache: { ttl, fresh: flag('fresh', fresh) ?? false, key: (cache_key as string) || null }, rest };
}

/** The store key: a hash of the options after defaults are filled in, so equal requests share one entry. */
export async function cacheKey(opts: ScreenshotOptions, extra: string | null): Promise<string> {
  const text = JSON.stringify({ opts, extra });
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface Header {
  contentType: string;
  info: CaptureResult['info'];
  storedAt: number;
  expiresAt: number;
}

export function pack(result: CaptureResult, storedAt: number, expiresAt: number): Uint8Array {
  const header: Header = { contentType: result.contentType, info: result.info, storedAt, expiresAt };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length + result.image.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  out.set(result.image, 4 + json.length);
  return out;
}

export function unpack(blob: Uint8Array): (Header & { image: Uint8Array }) | null {
  try {
    const length = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(0);
    const header = JSON.parse(new TextDecoder().decode(blob.subarray(4, 4 + length))) as Header;
    if (typeof header.contentType !== 'string' || typeof header.storedAt !== 'number') return null;
    return { ...header, image: blob.subarray(4 + length) };
  } catch {
    return null;
  }
}

/**
 * Returns a stored shot when there is one young enough, otherwise takes a new
 * one and stores it. The cache is best effort: when the store fails, the shot
 * is still returned. A failed capture throws and is never stored.
 */
export async function cachedScreenshot(
  store: CacheStore | undefined,
  opts: ScreenshotOptions,
  request: CacheRequest,
  take: () => Promise<CaptureResult>,
  now: () => number = Date.now,
): Promise<CachedShot> {
  if (!store || request.ttl === 0) return { result: await take(), status: 'BYPASS', age: 0, maxAge: 0 };
  const key = await cacheKey(opts, request.key);

  if (!request.fresh) {
    const blob = await store.get(key).catch((err) => {
      console.warn('cache read failed:', String(err));
      return null;
    });
    const entry = blob && unpack(blob);
    if (entry) {
      const until = Math.min(entry.expiresAt, entry.storedAt + request.ttl * 1000);
      const t = now();
      if (t < until) {
        return {
          result: { image: entry.image, contentType: entry.contentType, info: entry.info },
          status: 'HIT',
          age: Math.max(0, Math.floor((t - entry.storedAt) / 1000)),
          maxAge: Math.floor((until - t) / 1000),
        };
      }
    }
  }

  const result = await take();
  const storedAt = now();
  const status = request.fresh ? 'BYPASS' : 'MISS';
  try {
    await store.put(key, pack(result, storedAt, storedAt + request.ttl * 1000), request.ttl);
    return { result, status, age: 0, maxAge: request.ttl };
  } catch (err) {
    console.warn('cache write failed:', String(err));
    return { result, status, age: 0, maxAge: 0 };
  }
}

/** The subset of a Workers KV namespace binding used here. */
export interface KvNamespace {
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  put(key: string, value: Uint8Array, options: { expirationTtl: number }): Promise<void>;
}

/** Largest value Workers KV takes. */
const KV_MAX_BYTES = 25 * 1024 * 1024;

/** A store on Workers KV. KV drops entries itself after the TTL (60 seconds at the least). */
export function kvStore(kv: KvNamespace): CacheStore {
  return {
    async get(key) {
      const value = await kv.get(key, 'arrayBuffer');
      return value ? new Uint8Array(value) : null;
    },
    async put(key, value, ttlSeconds) {
      if (value.length > KV_MAX_BYTES) return;
      await kv.put(key, value, { expirationTtl: Math.max(60, ttlSeconds) });
    },
  };
}
