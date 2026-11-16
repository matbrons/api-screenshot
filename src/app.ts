// The HTTP API, shared by the Cloudflare Worker and the Node server.
//
//   GET  /screenshot?url=https://example.com&full_page=true
//   POST /screenshot   {"url": "https://example.com", "full_page": true}
//
// A request needs the API key, or a signature made with the signing secret
// (src/signing.ts). Success is the image or PDF itself (or JSON with
// response_type=json), from the cache when the same shot was taken recently
// (src/cache.ts). Anything else is JSON: {"error", "message", "reason"}.
//
// AI agents use the same shots over MCP at /mcp (src/mcp.ts), with the API key.
// /openapi.json describes the API (src/openapi.ts).

import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { DEFAULT_CACHE_TTL, MAX_CACHE_TTL, cachedScreenshot, takeCacheOptions, type CacheStore, type CachedShot } from './cache.ts';
import type { CaptureResult } from './capture.ts';
import { jsonBody } from './details.ts';
import { CaptureError, msUntilUtcMidnight } from './errors.ts';
import { handleMcp, type Shoot } from './mcp.ts';
import { openApiDocument } from './openapi.ts';
import { DEFAULT_LIMITS, REQUEST_PROXY_OFF, parseOptions, queryOptions, type Limits, type ScreenshotOptions } from './options.ts';
import { ProxyUrlError, parseProxyList, parseProxyUrl, type ProxySettings, type RequestProxyPolicy } from './proxy.ts';
import { verifySignedQuery } from './signing.ts';

export interface AppConfig {
  /** Takes the screenshot; each runtime brings its own browser. */
  screenshot: (opts: ScreenshotOptions, signal: AbortSignal) => Promise<CaptureResult>;
  /** When set, every screenshot request must carry this key. */
  apiKey?: string;
  /** When set, a GET request may carry a signature made with this secret instead of the key. */
  signingSecret?: string;
  /** Serve screenshots without a key. With no key, no signing secret and not this, screenshots are refused. */
  allowPublicAccess?: boolean;
  /** Why the API_KEY or SIGNING_SECRET setting can't be used. Screenshots are refused until it is fixed. */
  keyProblem?: string;
  /** Why the PROXY_URL or PROXY_URLS setting can't be used. Screenshots are refused until it is fixed. */
  proxyProblem?: string;
  /** Whether a request may bring its own proxy. Off unless the operator turns it on. */
  requestProxy?: RequestProxyPolicy;
  limits?: Limits;
  /** Where finished shots are kept. Without it, every request takes a new shot. */
  cache?: CacheStore;
  /** Seconds a shot is reused when the request doesn't say (cache_ttl). 0 turns the cache off. */
  cacheTtl?: number;
}

/** Shortest API key accepted. Anything shorter can be guessed. */
const MIN_KEY_LENGTH = 16;

/** Example values from the docs and config files, which must never guard a live install. */
const EXAMPLE_KEYS = new Set(['change-me', 'changeme', 'replace-me', 'your-api-key', 'replace-with-a-long-random-string']);

const NOT_CONFIGURED =
  'No API key is set, so screenshots are turned off. Set API_KEY to a long random string ' +
  '(for example from `openssl rand -hex 32`), or set ALLOW_PUBLIC_ACCESS=true to let anyone use it without a key.';

/** Room for "html" and the other options, in bytes as sent. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** Compares two secrets in constant time, whatever their lengths. */
export async function sameSecret(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * The key from the Authorization or X-API-Key header. Never from the URL: a
 * URL ends up in logs, browser history and Referer headers. A page that needs
 * a shot in an <img> tag uses a signed URL instead.
 */
function presentedKey(c: Context): string | null {
  if (c.req.query('access_key') !== undefined) {
    throw new CaptureError(
      'unauthorized',
      'The API key goes in the Authorization or X-API-Key header, never in the URL. To put a shot in a page, use a signed URL.',
    );
  }
  const auth = c.req.header('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return c.req.header('x-api-key') ?? null;
}

/** How a request got in: with a signature (and maybe an expiry, in Unix seconds), or not. */
interface Access {
  signed: boolean;
  expires: number | null;
}

/** Why a weak secret can't be used, or nothing when it is fine. */
function secretProblem(name: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (EXAMPLE_KEYS.has(value.toLowerCase())) {
    return `${name} is still the example value. Set your own long random string, for example from \`openssl rand -hex 32\`.`;
  }
  if (value.length < MIN_KEY_LENGTH) {
    return `${name} is too short. Use at least ${MIN_KEY_LENGTH} random characters, for example from \`openssl rand -hex 32\`.`;
  }
  return undefined;
}

function errorResponse(c: Context, err: CaptureError) {
  c.header('cache-control', 'no-store');
  // Tells clients that honour Retry-After not to try again before the reset.
  if (err.code === 'quota_exceeded') c.header('retry-after', String(Math.ceil(msUntilUtcMidnight(Date.now()) / 1000)));
  return c.json({ error: err.code, message: err.message, ...(err.reason ? { reason: err.reason } : {}) }, err.status as ContentfulStatusCode);
}

const BODY_TOO_LARGE = `The request body is too large: at most ${MAX_BODY_BYTES / 1024 / 1024} MB.`;

/**
 * Reads a request body, stopping as soon as it passes `max` bytes. A chunked
 * body has no Content-Length to check up front, so the count is kept while
 * reading and nothing more is held in memory than the limit.
 */
async function readBodyText(body: ReadableStream<Uint8Array> | null, max: number): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new CaptureError('invalid_options', BODY_TOO_LARGE);
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(whole);
}

async function readOptions(c: Context): Promise<Record<string, unknown>> {
  if (c.req.method === 'GET') return queryOptions(new URL(c.req.url).searchParams);
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new CaptureError('invalid_options', BODY_TOO_LARGE);
  const text = await readBodyText(c.req.raw.body, MAX_BODY_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new CaptureError('invalid_options', 'The body must be JSON, for example {"url": "https://example.com"}.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CaptureError('invalid_options', 'The body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

export function createApp(config: AppConfig): Hono {
  const app = new Hono();
  const limits = config.limits ?? DEFAULT_LIMITS;
  const requestProxy = config.requestProxy ?? REQUEST_PROXY_OFF;

  const cacheTtl = Math.min(config.cacheTtl ?? DEFAULT_CACHE_TTL, MAX_CACHE_TTL);
  const needsAuth = Boolean(config.apiKey || config.signingSecret);
  const setupProblem =
    config.keyProblem ?? config.proxyProblem ?? (!needsAuth && !config.allowPublicAccess ? NOT_CONFIGURED : undefined);

  const authHelp = [
    config.apiKey ? 'Authorization: Bearer <key> or X-API-Key' : '',
    config.signingSecret ? 'a signed URL (?signature=)' : '',
  ].filter(Boolean).join(', or ');

  app.get('/', (c) =>
    c.json({
      name: 'api-screenshot',
      usage: 'GET /screenshot?url=https://example.com',
      mcp: '/mcp',
      openapi: '/openapi.json',
      auth: setupProblem ? `not configured: ${setupProblem}` : needsAuth ? `required: ${authHelp}` : 'none: public access is on',
    }),
  );

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/openapi.json', (c) => {
    const url = new URL(c.req.url);
    if (c.req.header('x-forwarded-proto') === 'https') url.protocol = 'https:';
    c.header('access-control-allow-origin', '*');
    return c.json(openApiDocument({
      limits, cacheTtl, apiKey: Boolean(config.apiKey), signing: Boolean(config.signingSecret), origin: url.origin,
    }));
  });

  /** Throws unless an unsigned request may in: with the key, or on a server with public access. */
  async function checkKey(c: Context): Promise<void> {
    if (config.apiKey) {
      const key = presentedKey(c);
      if (!key || !(await sameSecret(key, config.apiKey))) {
        throw new CaptureError('unauthorized', 'A valid API key is required.');
      }
    } else if (config.signingSecret) {
      throw new CaptureError('unauthorized', 'This server only takes signed URLs.');
    }
  }

  /** Checks the options and takes the shot, or serves it from the cache. Call only after the request is let in. */
  const shoot: Shoot = async (raw, signal) => {
    const { cache, rest } = takeCacheOptions(raw, cacheTtl);
    const opts = parseOptions(rest, limits, requestProxy);
    const shot = await cachedScreenshot(config.cache, opts, cache, () => config.screenshot(opts, signal));
    return { opts, shot };
  };

  /**
   * Lets the request through or throws, and returns its options. A signed
   * request's options are read from exactly the parameters that were signed.
   */
  async function authorize(c: Context): Promise<Access & { raw: Record<string, unknown> }> {
    const params = new URL(c.req.url).searchParams;
    if (params.has('signature')) {
      if (c.req.method !== 'GET') throw new CaptureError('invalid_options', 'Only GET requests can be signed.');
      if (!config.signingSecret) {
        throw new CaptureError('unauthorized', 'Signed URLs are turned off on this server. Whoever runs it can turn them on with SIGNING_SECRET.');
      }
      const expires = await verifySignedQuery(params, config.signingSecret, sameSecret);
      const { signature: _signature, expires: _expires, ...raw } = Object.fromEntries(params);
      return { signed: true, expires, raw };
    }
    await checkKey(c);
    return { signed: false, expires: null, raw: await readOptions(c) };
  }

  app.on(['GET', 'POST'], '/screenshot', async (c) => {
    try {
      if (setupProblem) throw new CaptureError('not_configured', setupProblem);
      const access = await authorize(c);
      const { opts, shot } = await shoot(access.raw, c.req.raw.signal);
      const { result } = shot;
      const { info } = result;
      if (opts.responseType !== 'by_format') return c.json(jsonBody(opts, result), 200, cacheHeaders(shot, access));
      return c.body(result.image as Uint8Array<ArrayBuffer>, 200, {
        'content-type': result.contentType,
        ...cacheHeaders(shot, access),
        'x-final-url': info.finalUrl,
        'x-target-status': String(info.status),
        'x-removed-elements': String(info.removed),
        ...(info.consentManager ? { 'x-consent-manager': info.consentManager } : {}),
        ...(info.pageHeight !== null ? { 'x-page-height': String(info.pageHeight) } : {}),
        ...(info.truncated ? { 'x-truncated': 'true' } : {}),
        ...(info.overlayRemaining ? { 'x-overlay-remaining': info.overlayRemaining } : {}),
      });
    } catch (err) {
      if (err instanceof CaptureError) return errorResponse(c, err);
      console.error('screenshot failed', err);
      return errorResponse(c, new CaptureError('internal', 'The capture failed.'));
    }
  });

  // MCP over Streamable HTTP. It takes the API key only: a signed URL is made
  // for one shot, not for a client that asks for any.
  app.all('/mcp', async (c) => {
    try {
      if (setupProblem) throw new CaptureError('not_configured', setupProblem);
      if (new URL(c.req.url).searchParams.has('signature')) {
        throw new CaptureError('unauthorized', 'MCP takes the API key, not a signed URL.');
      }
      if (!config.apiKey && config.signingSecret) {
        throw new CaptureError('unauthorized', 'MCP needs an API key, and this server only takes signed URLs. Whoever runs it can set API_KEY as well.');
      }
      await checkKey(c);
    } catch (err) {
      if (!(err instanceof CaptureError)) throw err;
      if (err.code === 'unauthorized') c.header('www-authenticate', 'Bearer realm="api-screenshot"');
      return errorResponse(c, err);
    }
    return handleMcp(c.req.raw, shoot, limits, cacheTtl);
  });

  app.notFound((c) => c.json({ error: 'not_found', message: 'Try GET /screenshot?url=https://example.com' }, 404));
  return app;
}

/**
 * Headers that say where the shot came from and how long others may keep it.
 * A signed URL is made to be shared, so shared caches may keep its shot (never
 * past its expiry). A request with the key gets "private": a shared cache must
 * not hand its shot to someone without the key.
 */
function cacheHeaders(shot: CachedShot, access: Access): Record<string, string> {
  let maxAge = shot.maxAge;
  if (access.expires !== null) maxAge = Math.min(maxAge, access.expires - Math.floor(Date.now() / 1000));
  return {
    'x-cache': shot.status,
    ...(shot.status === 'HIT' ? { age: String(shot.age) } : {}),
    'cache-control': maxAge > 0 ? `${access.signed ? 'public' : 'private'}, max-age=${maxAge}` : 'no-store',
  };
}

interface EnvConfig extends Pick<AppConfig, 'apiKey' | 'signingSecret' | 'allowPublicAccess' | 'keyProblem' | 'proxyProblem'> {
  limits: Limits;
  cacheTtl: number;
  requestProxy: RequestProxyPolicy;
  /** The operator's proxies from PROXY_URL and PROXY_URLS, when set and usable here. Shots take them in turn. */
  proxies?: ProxySettings[];
}

interface RuntimeSupport {
  /** Whether this runtime's browser can send its traffic through a proxy. */
  proxy: boolean;
}

const CLOUDFLARE_NO_PROXY =
  "Cloudflare's browser can't send its traffic through your own proxy. Run the Docker version on a server to use one.";

/** Reads the shared settings from environment variables (Worker bindings or process.env). */
export function configFromEnv(env: Record<string, string | undefined>, runtime: RuntimeSupport = { proxy: false }): EnvConfig {
  const number = (name: string, fallback: number) => {
    const n = Number(env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const apiKey = env.API_KEY?.trim() || undefined;
  const signingSecret = env.SIGNING_SECRET?.trim() || undefined;
  const keyProblem = secretProblem('API_KEY', apiKey) ?? secretProblem('SIGNING_SECRET', signingSecret);
  const ttl = Number(env.CACHE_TTL_SECONDS?.trim() || NaN);

  // The operator's proxies: PROXY_URL for one, PROXY_URLS for a list; both may
  // be set. A setting that can't be honoured stops screenshots rather than
  // letting them go out directly, which the operator didn't ask for.
  const proxies: ProxySettings[] = [];
  let proxyProblem: string | undefined;
  for (const [name, read] of [['PROXY_URL', (v: string) => [parseProxyUrl(v)]], ['PROXY_URLS', parseProxyList]] as const) {
    const value = env[name]?.trim();
    if (!value || proxyProblem) continue;
    if (!runtime.proxy) {
      proxyProblem = `${name} is set, but ${CLOUDFLARE_NO_PROXY} Remove ${name} to take screenshots without it.`;
      continue;
    }
    try {
      proxies.push(...read(value));
    } catch (err) {
      if (!(err instanceof ProxyUrlError)) throw err;
      proxyProblem = `${name} ${err.message}.`;
    }
  }

  let requestProxy: RequestProxyPolicy = REQUEST_PROXY_OFF;
  if (!runtime.proxy) {
    requestProxy = { allowed: false, reason: `The "proxy" option can't be used here: ${CLOUDFLARE_NO_PROXY}` };
  } else if (isTrue(env.ALLOW_REQUEST_PROXY)) {
    // Anyone who may call the API could route its browser anywhere, so only callers with the key may.
    requestProxy = apiKey && !keyProblem
      ? { allowed: true }
      : { allowed: false, reason: 'The "proxy" option needs an API key on this server. Whoever runs it must set API_KEY as well as ALLOW_REQUEST_PROXY.' };
  }

  return {
    apiKey,
    ...(signingSecret ? { signingSecret } : {}),
    allowPublicAccess: isTrue(env.ALLOW_PUBLIC_ACCESS),
    ...(keyProblem ? { keyProblem } : {}),
    ...(proxyProblem ? { proxyProblem } : {}),
    ...(proxies.length && !proxyProblem ? { proxies } : {}),
    requestProxy,
    limits: {
      maxTimeoutSeconds: Math.max(5, number('MAX_TIMEOUT_SECONDS', DEFAULT_LIMITS.maxTimeoutSeconds)),
      maxFullPageHeight: Math.max(100, number('MAX_FULL_PAGE_HEIGHT', DEFAULT_LIMITS.maxFullPageHeight)),
    },
    cacheTtl: Number.isInteger(ttl) && ttl >= 0 ? Math.min(ttl, MAX_CACHE_TTL) : DEFAULT_CACHE_TTL,
  };
}

/** Whether a setting is turned on: 1, true, yes or on, in any case. */
export function isTrue(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '');
}
