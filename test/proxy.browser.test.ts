// Shots through your own proxy, in a real Chromium. Skipped when no Chrome or
// Chromium is installed.
//
// The "site" lives behind small local test proxies, so nothing leaves this
// machine. The guard is given a resolver that says site.example.com is public
// (93.184.215.14) and that every other name points at this machine, and the
// test checks that the proxy is only ever asked for the public address.

import type http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CaptureError } from '../src/errors.ts';
import { findChrome, startNodeBrowser, type NodeScreenshotter } from '../src/node-browser.ts';
import { parseOptions } from '../src/options.ts';
import { parseProxyUrl } from '../src/proxy.ts';
import { startHttpProxy, startSite, startSocks5Proxy, type TestProxy } from './helpers/test-proxies.ts';

let chrome: string | null = null;
try {
  chrome = findChrome();
} catch {
  chrome = null;
}

const PUBLIC_IP = '93.184.215.14';
const resolve = async (host: string) => (host === 'site.example.com' ? [PUBLIC_IP] : ['127.0.0.1']);

const longText = '<p>' + 'This is the real content of the page, long enough to count as a page. '.repeat(30) + '</p>';

let site: http.Server;
let intranet: net.Server;
let intranetPort = 0;
let intranetHits = 0;

/** The page also tries to reach this machine over WebSockets, which request interception never sees. */
const sitePage = (port: number) => `<!doctype html><html><body><h1>Through the proxy</h1>${longText}<script>
  for (const host of ['127.0.0.1', 'localhost', 'sneaky.example.com']) {
    try { new WebSocket('ws://' + host + ':${port}/'); } catch {}
  }
</script></body></html>`;

beforeAll(async () => {
  if (!chrome) return;
  intranet = net.createServer((s) => {
    intranetHits++;
    s.destroy();
  });
  await new Promise<void>((r) => intranet.listen(0, '127.0.0.1', r));
  intranetPort = (intranet.address() as net.AddressInfo).port;
  site = startSite(sitePage(intranetPort));
});

afterAll(async () => {
  intranet?.close();
});

async function failure(promise: Promise<unknown>): Promise<CaptureError> {
  try {
    await promise;
  } catch (err) {
    return err as CaptureError;
  }
  throw new Error('expected the shot to fail');
}

const shotOf = (path: string, extra: Record<string, unknown> = {}) =>
  // A port of its own keeps Chrome from trying https:// first (HTTPS upgrades).
  parseOptions({ url: `http://site.example.com:8080${path}`, timeout: 20, wait_until: 'load', delay: 1, ...extra });

describe.skipIf(!chrome)('shots through your own proxy, in a real browser', () => {
 for (const kind of ['http', 'socks5'] as const) describe(kind, () => {
  let upstream: TestProxy;
  let browser: NodeScreenshotter;

  beforeAll(async () => {
    upstream = kind === 'http' ? await startHttpProxy(site) : await startSocks5Proxy(site);
    browser = await startNodeBrowser({ proxies: [parseProxyUrl(upstream.url)], resolve, sandbox: false });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await upstream?.close();
  });

  it('sends the traffic through the proxy, with its login, to the checked address only', async () => {
    upstream.seen.length = 0;
    intranetHits = 0;
    const { image, info } = await browser.screenshot(shotOf('/page'));
    expect(image.byteLength).toBeGreaterThan(1000);
    expect(info.status).toBe(200);
    expect(upstream.seen.length).toBeGreaterThan(0);
    for (const seen of upstream.seen) {
      expect(seen.authorized).toBe(true);
      expect(seen.line).toMatch(kind === 'http' ? `GET http://${PUBLIC_IP}:8080/` : `SOCKS ${PUBLIC_IP}:8080`);
    }
    if (kind === 'http') expect(upstream.seen[0]!.host).toBe('site.example.com:8080');
    // The WebSockets to this machine were refused before they reached the proxy or the target.
    expect(intranetHits).toBe(0);
  }, 40_000);

  it('still refuses a page that sends the browser to a private address', async () => {
    upstream.seen.length = 0;
    const err = await failure(browser.screenshot(parseOptions({ url: 'http://127.0.0.1:1/', timeout: 10 })));
    expect(err.code).toBe('url_not_allowed');
    const named = await failure(browser.screenshot(parseOptions({ url: 'http://sneaky.example.com/', timeout: 10 })));
    expect(named.code).toBe('url_not_allowed');
    expect(upstream.seen).toEqual([]);
  }, 40_000);

  it('refuses a proxy from a request that points at this machine', async () => {
    const opts = { ...shotOf('/page'), proxy: parseProxyUrl(upstream.url) };
    const err = await failure(browser.screenshot(opts));
    expect(err.code).toBe('proxy_not_allowed');
  }, 20_000);
 });
});

describe.skipIf(!chrome)('a proxy that fails, in a real browser', () => {
  let upstream: TestProxy;
  let browser: NodeScreenshotter;
  const WRONG = 'wrong-password-123';

  beforeAll(async () => {
    upstream = await startHttpProxy(site);
    const proxy = { ...parseProxyUrl(upstream.url), password: WRONG };
    browser = await startNodeBrowser({ proxies: [proxy], resolve, sandbox: false, onProxyRest: () => {} });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await upstream?.close();
  });

  it('says the proxy refused the login, without the password', async () => {
    const err = await failure(browser.screenshot(shotOf('/page')));
    expect(err).toMatchObject({ code: 'proxy_error', status: 502, reason: 'proxy' });
    expect(err.message).toMatch(/refused the login/);
    expect(err.message).not.toContain(WRONG);
  }, 40_000);
});
