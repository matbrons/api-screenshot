// A list of your own proxies, in a real Chromium: rotation, a retry through the
// next proxy when a page comes back blocked or a proxy fails, a dead proxy
// rested, the guard still in front of every proxy, and the browser presenting
// as a desktop Chrome. Skipped when no Chrome or Chromium is installed.
//
// As in proxy.browser.test.ts, the "sites" live behind small local test
// proxies, so nothing leaves this machine.

import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CaptureError } from '../src/errors.ts';
import {
  browserSettingsFromEnv, desktopChromeArgs, findChrome, startNodeBrowser, type NodeBrowserOptions, type NodeScreenshotter,
} from '../src/node-browser.ts';
import { parseOptions } from '../src/options.ts';
import { parseProxyUrl, type ProxySettings } from '../src/proxy.ts';
import { startHttpProxy, type TestProxy } from './helpers/test-proxies.ts';

let chrome: string | null = null;
try {
  chrome = findChrome();
} catch {
  chrome = null;
}

const PUBLIC_IP = '93.184.215.14';
const resolve = async (host: string) => (host === 'site.example.com' ? [PUBLIC_IP] : ['127.0.0.1']);
const longText = '<p>' + 'This is the real content of the page, long enough to count as a page. '.repeat(30) + '</p>';

/** What the page reported about the browser, and the headers it sent. */
let reported: Record<string, unknown> | null = null;
let reportHeaders: http.IncomingHttpHeaders = {};

const probePage = `<!doctype html><html><body><h1>Probe</h1>${longText}<script>
  fetch('/report?d=' + encodeURIComponent(JSON.stringify({
    ua: navigator.userAgent, webdriver: navigator.webdriver, languages: navigator.languages,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, screen: [screen.width, screen.height],
    webgl: !!document.createElement('canvas').getContext('webgl'),
  })));
</script></body></html>`;

/** Requests for /hang, which get no answer until the tests end. */
const hanging: http.ServerResponse[] = [];

const site = http.createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url ?? '/', 'http://site.example.com');
  if (pathname === '/hang') return void hanging.push(res);
  if (pathname === '/report') {
    reported = JSON.parse(searchParams.get('d') ?? 'null');
    reportHeaders = req.headers;
    return res.writeHead(204).end();
  }
  if (pathname === '/redirect') return res.writeHead(302, { location: 'http://sneaky.example.com/' }).end();
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(pathname === '/probe' ? probePage : `<!doctype html><html><body><h1>Real page</h1>${longText}</body></html>`);
});

/** A site that answers every request with a bot wall. */
const wall = http.createServer((_req, res) => {
  res.writeHead(403, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><head><title>Just a moment...</title></head><body>Checking your browser before you continue.</body></html>');
});

/** A "proxy" that accepts connections and drops them at once, counting each. */
async function startDeadProxy(): Promise<{ proxy: ProxySettings; hits: () => number; close: () => void }> {
  let hits = 0;
  const server = net.createServer((s) => {
    hits++;
    s.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  return { proxy: parseProxyUrl(`http://127.0.0.1:${port}`), hits: () => hits, close: () => server.close() };
}

async function failure(promise: Promise<unknown>): Promise<CaptureError> {
  try {
    await promise;
  } catch (err) {
    return err as CaptureError;
  }
  throw new Error('expected the shot to fail');
}

const shotOf = (path: string, extra: Record<string, unknown> = {}) =>
  parseOptions({ url: `http://site.example.com:8080${path}`, timeout: 30, wait_until: 'load', ...extra });

const rests: string[] = [];
const browsers: NodeScreenshotter[] = [];
const proxies: TestProxy[] = [];
const start = async (list: ProxySettings[], extra: NodeBrowserOptions = {}) => {
  const browser = await startNodeBrowser({
    proxies: list, resolve, sandbox: false, onProxyRest: (p) => rests.push(`${p.host}:${p.port}`), ...extra,
  });
  browsers.push(browser);
  return browser;
};
const proxyTo = async (server: http.Server) => {
  const p = await startHttpProxy(server);
  proxies.push(p);
  return p;
};

afterAll(async () => {
  for (const res of hanging) res.end();
  await Promise.all(browsers.map((b) => b.close()));
  await Promise.all(proxies.map((p) => p.close()));
});

describe.skipIf(!chrome)('a list of proxies, in a real browser', () => {
  let one: TestProxy;
  let two: TestProxy;
  let walled: TestProxy;

  beforeAll(async () => {
    [one, two, walled] = await Promise.all([proxyTo(site), proxyTo(site), proxyTo(wall)]);
  });

  it('takes the proxies in turn', async () => {
    const browser = await start([parseProxyUrl(one.url), parseProxyUrl(two.url)]);
    one.seen.length = 0;
    two.seen.length = 0;
    await browser.screenshot(shotOf('/page'));
    expect(one.seen.length).toBeGreaterThan(0);
    expect(two.seen).toEqual([]);
    one.seen.length = 0;
    await browser.screenshot(shotOf('/page'));
    expect(one.seen).toEqual([]);
    expect(two.seen.length).toBeGreaterThan(0);
  }, 60_000);

  it('retries a blocked page through the next proxy, without resting the first', async () => {
    const browser = await start([parseProxyUrl(walled.url), parseProxyUrl(one.url)]);
    walled.seen.length = 0;
    one.seen.length = 0;
    rests.length = 0;
    const { info } = await browser.screenshot(shotOf('/page'));
    expect(info.status).toBe(200);
    expect(walled.seen.length).toBeGreaterThan(0);
    expect(one.seen.length).toBeGreaterThan(0);
    expect(rests).toEqual([]);

    // With "retry" 0 the block is reported as it is, never as a shot.
    const err = await failure(browser.screenshot(shotOf('/page', { retry: 0 })));
    expect(err).toMatchObject({ code: 'blocked', reason: 'bot_check' });
  }, 90_000);

  it('rests a dead proxy instead of trying it on every shot', async () => {
    const dead = await startDeadProxy();
    try {
      const browser = await start([dead.proxy, parseProxyUrl(one.url)]);
      rests.length = 0;
      const first = await browser.screenshot(shotOf('/page'));
      expect(first.info.status).toBe(200);
      expect(dead.hits()).toBeGreaterThan(0);
      expect(rests).toEqual([`127.0.0.1:${dead.proxy.port}`]);

      const hitsBefore = dead.hits();
      await browser.screenshot(shotOf('/page'));
      await browser.screenshot(shotOf('/page'));
      expect(dead.hits()).toBe(hitsBefore);
    } finally {
      dead.close();
    }
  }, 90_000);

  it('keeps the guard in front of every proxy: checked addresses only, redirects included', async () => {
    const browser = await start([parseProxyUrl(one.url), parseProxyUrl(two.url)]);
    one.seen.length = 0;
    two.seen.length = 0;
    await browser.screenshot(shotOf('/page'));
    for (const seen of [...one.seen, ...two.seen]) expect(seen.line).toMatch(`GET http://${PUBLIC_IP}:8080/`);

    one.seen.length = 0;
    two.seen.length = 0;
    for (const url of ['http://127.0.0.1:1/', 'http://sneaky.example.com/']) {
      expect((await failure(browser.screenshot(parseOptions({ url, timeout: 15 })))).code).toBe('url_not_allowed');
    }
    expect([...one.seen, ...two.seen]).toEqual([]);

    // A redirect to a private address is refused too, and never retried through another proxy.
    const err = await failure(browser.screenshot(shotOf('/redirect')));
    expect(err.code).toBe('url_not_allowed');
    expect([...one.seen, ...two.seen].map((s) => s.line)).toEqual([`GET http://${PUBLIC_IP}:8080/redirect`]);
  }, 90_000);
});

describe.skipIf(!chrome)('how the browser presents itself', () => {
  let through: TestProxy;
  beforeAll(async () => {
    through = await proxyTo(site);
  });

  it('as a desktop Chrome by default, in the language and time zone set', async () => {
    const browser = await start([parseProxyUrl(through.url)], { language: 'nl-NL', timezone: 'Europe/Amsterdam' });
    reported = null;
    await browser.screenshot(shotOf('/probe', { delay: 1 }));
    expect(reported).toMatchObject({
      webdriver: false,
      languages: expect.arrayContaining(['nl-NL', 'nl']),
      timezone: 'Europe/Amsterdam',
      webgl: true,
    });
    const { ua, screen } = reported as unknown as { ua: string; screen: number[] };
    expect(ua).toMatch(/ Chrome\/\d+/);
    expect(ua).not.toMatch(/Headless/);
    expect(screen[0]).toBeGreaterThanOrEqual(1280); // not smaller than the 1280 px page
    expect(reportHeaders['accept-language']).toMatch(/^nl-NL,nl/);
    expect(reportHeaders['user-agent']).not.toMatch(/Headless/);
  }, 60_000);

  it('as headless Chromium with DESKTOP_CHROME off', async () => {
    const browser = await start([parseProxyUrl(through.url)], { desktopChrome: false });
    reported = null;
    await browser.screenshot(shotOf('/probe', { delay: 1 }));
    expect((reported as unknown as { ua: string }).ua).toMatch(/HeadlessChrome/);
  }, 60_000);
});

describe.skipIf(!chrome)('a client that goes away, in a real browser', () => {
  it('stops its shot and frees the slot, also while it waits for one', async () => {
    const browser = await start([parseProxyUrl((await proxyTo(site)).url)], { concurrency: 1 });
    const running = new AbortController();
    const queued = new AbortController();
    const first = failure(browser.screenshot(shotOf('/hang'), running.signal));
    const second = failure(browser.screenshot(shotOf('/page'), queued.signal));
    for (let i = 0; i < 100 && hanging.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(hanging.length).toBeGreaterThan(0);

    queued.abort();
    expect((await second).reason).toBe('client_closed');
    const started = Date.now();
    running.abort();
    expect((await first).reason).toBe('client_closed');
    // The next shot gets the one slot at once, long before the 30 s timeout of the first.
    await browser.screenshot(shotOf('/page'));
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);
});

describe('browser settings from the environment', () => {
  it('presents as a desktop Chrome in en-US unless told otherwise', () => {
    expect(browserSettingsFromEnv({})).toEqual({ desktopChrome: true, language: 'en-US', timezone: 'America/New_York', warnings: [] });
    expect(browserSettingsFromEnv({ DESKTOP_CHROME: 'false', BROWSER_LANGUAGE: 'de-DE', BROWSER_TIMEZONE: 'Europe/Berlin' })).toMatchObject({
      desktopChrome: false, language: 'de-DE', timezone: 'Europe/Berlin',
    });
  });

  it('falls back to the default for a value it cannot use, and says so', () => {
    const settings = browserSettingsFromEnv({ BROWSER_LANGUAGE: 'en_US; rm', BROWSER_TIMEZONE: 'Mars/Olympus' });
    expect(settings).toMatchObject({ language: 'en-US', timezone: 'America/New_York' });
    expect(settings.warnings).toEqual([expect.stringMatching(/^BROWSER_LANGUAGE/), expect.stringMatching(/^BROWSER_TIMEZONE/)]);
  });

  it('sends the language with its base as a fallback', () => {
    expect(desktopChromeArgs('nl-NL')).toEqual(expect.arrayContaining(['--lang=nl-NL', '--accept-lang=nl-NL,nl']));
    expect(desktopChromeArgs('fr')).toContain('--accept-lang=fr');
  });
});
