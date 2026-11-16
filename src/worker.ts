// Runs the API as a Cloudflare Worker with Browser Rendering.
// Deploy with the button in the README, or `npx wrangler deploy`.

import puppeteer, { type Browser, type BrowserWorker } from '@cloudflare/puppeteer';
import autoconsentScript from './generated/autoconsent-script.ts';
import compactRules from '@duckduckgo/autoconsent/rules/compact-rules.json' with { type: 'json' };
import blocklists from './generated/blocklists.ts';
import type { Page } from 'puppeteer-core';
import { configFromEnv, createApp } from './app.ts';
import { createBlocker } from './blocklists.ts';
import { kvStore, type KvNamespace } from './cache.ts';
import { capture, closeWithin, type EngineDeps } from './capture.ts';
import { CaptureError } from './errors.ts';
import type { Resolver } from './guard.ts';
import type { ScreenshotOptions } from './options.ts';
import { withRetries } from './retry.ts';
import { getBrowser, keepAliveSeconds, keepRetryAfter, LaunchRefused, type BrowserRun } from './worker-browser.ts';

interface Env {
  BROWSER: BrowserWorker;
  API_KEY?: string;
  SIGNING_SECRET?: string;
  ALLOW_PUBLIC_ACCESS?: string;
  /** Workers KV for finished shots. Without it, every request takes a new shot. */
  CACHE?: KvNamespace;
  CACHE_TTL_SECONDS?: string;
  MAX_TIMEOUT_SECONDS?: string;
  MAX_FULL_PAGE_HEIGHT?: string;
  BROWSER_KEEP_ALIVE_SECONDS?: string;
  /** Not supported here: Browser Rendering has no way to use your own proxy, so setting it stops screenshots. */
  PROXY_URL?: string;
  /** Not supported here either, for the same reason. */
  PROXY_URLS?: string;
}

/**
 * Resolves host names over DNS-over-HTTPS, so the guard sees the addresses a
 * host points to. Browser Rendering resolves the name again on its own, and
 * gives no way to pin it to the address checked here, so a name that changes
 * its answer in between is not caught (the README says so under Safety). The
 * server runtime has no such gap: its egress proxy connects to the address it checked.
 */
const resolveOverHttps: Resolver = async (host) => {
  const lookup = async (type: 'A' | 'AAAA') => {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: 'application/dns-json' },
    });
    if (!res.ok) throw new Error(`DNS lookup failed with ${res.status}`);
    const body = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
    return (body.Answer ?? []).filter((a) => a.type === 1 || a.type === 28).map((a) => a.data);
  };
  const [v4, v6] = await Promise.all([lookup('A'), lookup('AAAA')]);
  return [...v4, ...v6];
};

const deps: EngineDeps = {
  resolve: resolveOverHttps,
  consent: { script: autoconsentScript, compactRules },
  // Filter lists fetched when the Worker was built (scripts/blocklists.ts). Set up
  // once when the Worker starts, not on each request.
  blocker: createBlocker(blocklists),
};

function browserRun(binding: BrowserWorker): BrowserRun<Browser> {
  return {
    sessions: () => puppeteer.sessions(binding),
    connect: (sessionId) => puppeteer.connect(binding, sessionId),
    launch: async (keepAliveMs) => {
      // Read Cloudflare's answer through a wrapper: a refusal's Retry-After tells
      // a used-up day from a short wait, and puppeteer's error drops it.
      const { endpoint, retryAfter } = keepRetryAfter(binding);
      try {
        return await puppeteer.launch(endpoint as BrowserWorker, keepAliveMs ? { keep_alive: keepAliveMs } : {});
      } catch (err) {
        throw new LaunchRefused(String((err as Error)?.message ?? err), retryAfter());
      }
    },
    limits: () => puppeteer.limits(binding),
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const keepAlive = keepAliveSeconds(env.BROWSER_KEEP_ALIVE_SECONDS);
    async function shoot(opts: ScreenshotOptions) {
      if (!env.BROWSER) throw new CaptureError('browser_unavailable', 'The BROWSER binding is missing from wrangler.jsonc.');
      const browser = await getBrowser(browserRun(env.BROWSER), { keepAliveSeconds: keepAlive });
      const context = await browser.createBrowserContext();
      try {
        const page = await context.newPage();
        // Cloudflare's puppeteer is a build of puppeteer-core with the same page API,
        // but it ships its own copy of the classes, and their private fields make
        // TypeScript treat the two as unrelated. This is the one place they meet.
        return await capture(page as unknown as Page, opts, deps);
      } finally {
        // Tidy up after the response is sent. Closing frees the browser time at once;
        // with a keep-alive, disconnecting leaves the browser warm for the next request.
        ctx.waitUntil(
          (async () => {
            await closeWithin(context.close(), 5000);
            if (keepAlive) await browser.disconnect().catch(() => undefined);
            else await closeWithin(browser.close(), 5000);
          })(),
        );
      }
    }
    const { BROWSER: _browser, CACHE: _cache, ...settings } = env;
    const app = createApp({
      // Browser Rendering can't send traffic through an upstream proxy, so PROXY_URL, PROXY_URLS and "proxy" are refused.
      ...configFromEnv(settings, { proxy: false }),
      ...(env.CACHE ? { cache: kvStore(env.CACHE) } : {}),
      // A retry here goes out from the same Cloudflare addresses: there is no proxy to switch to.
      screenshot: (opts) => withRetries(opts, shoot),
    });
    return app.fetch(request);
  },
};
