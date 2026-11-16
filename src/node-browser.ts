// Runs the engine on a local Chromium: one browser, a fresh incognito context
// per screenshot, a cap on how many run at once, and all traffic through the
// egress proxy. A shot that goes through your own proxy gets an egress proxy
// of its own, chained to yours, so a failure of your proxy is told apart from
// a failure of the site. With a list of proxies, shots take them in turn, and
// a retry goes out through the next one.
//
// The browser is a real Chromium in Chrome's new headless mode, with a few
// changes so it reads as a desktop Chrome: its own user agent without
// "HeadlessChrome", navigator.webdriver false, a desktop-sized screen, and a
// language and time zone of your choice. Nothing beyond that: no faked
// hardware, canvas, WebGL or fonts, no captcha solving.

import dns from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';
import { createBlocker } from './blocklists.ts';
import { fetchBlocklists, ruleCount } from './blocklists-build.ts';
import { capture, closeWithin, type CaptureResult, type EngineDeps } from './capture.ts';
import type { ConsentAssets } from './consent.ts';
import { startEgressProxy, type EgressProxy } from './egress-proxy.ts';
import { CaptureError } from './errors.ts';
import { checkHost, type Resolver } from './guard.ts';
import type { ScreenshotOptions } from './options.ts';
import { describeProxy, type ProxySettings } from './proxy.ts';
import { ProxyPool } from './proxy-pool.ts';
import { withRetries } from './retry.ts';

const CHROME_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

export function findChrome(): string {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv) return fromEnv;
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error('No Chrome or Chromium found. Install one or set CHROME_PATH.');
  return found;
}

export function loadConsentAssets(): ConsentAssets {
  const require = createRequire(import.meta.url);
  const dist = path.dirname(require.resolve('@duckduckgo/autoconsent'));
  return {
    script: readFileSync(path.join(dist, 'autoconsent.playwright.js'), 'utf8'),
    compactRules: require('@duckduckgo/autoconsent/rules/compact-rules.json'),
  };
}

export interface NodeBrowserOptions {
  executablePath?: string;
  /** Screenshots that may run at the same time. */
  concurrency?: number;
  /** Requests that may wait for a free slot before new ones get "busy". */
  queueLimit?: number;
  /** Chromium's sandbox. Turn off only where it cannot run, such as some containers. */
  sandbox?: boolean;
  /** The operator's proxies (PROXY_URL, PROXY_URLS), taken in turn. Every shot goes through one unless a request brings its own. */
  proxies?: ProxySettings[];
  /** Looks up host names for the SSRF guard. Defaults to the system resolver; tests replace it. */
  resolve?: Resolver;
  /** Read as a desktop Chrome (see the top of this file). Default true. */
  desktopChrome?: boolean;
  /** The browser's language, such as "en-US" or "nl-NL". Default "en-US". */
  language?: string;
  /** The browser's time zone, such as "Europe/Amsterdam". Default "America/New_York". */
  timezone?: string;
  /**
   * Fetch the ad, tracker and cookie filter lists at start and once a day
   * after. Until they arrive, or when they can't be fetched, the small
   * built-in list applies.
   */
  fetchBlocklists?: boolean;
  /** Told when a proxy from the list fails and is rested. Defaults to a warning in the log. */
  onProxyRest?: (proxy: ProxySettings, reason: string, restMs: number) => void;
}

const DEFAULT_LANGUAGE = 'en-US';
const DEFAULT_TIMEZONE = 'America/New_York';

interface BrowserSettings {
  desktopChrome: boolean;
  language: string;
  timezone: string;
  /** Settings that couldn't be used, each with the default used instead. */
  warnings: string[];
}

/** Reads DESKTOP_CHROME, BROWSER_LANGUAGE and BROWSER_TIMEZONE. A bad value falls back to the default, with a warning. */
export function browserSettingsFromEnv(env: Record<string, string | undefined>): BrowserSettings {
  const warnings: string[] = [];
  const language = env.BROWSER_LANGUAGE?.trim() || DEFAULT_LANGUAGE;
  const timezone = env.BROWSER_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
  const goodLanguage = isLanguageTag(language);
  const goodTimezone = isTimeZone(timezone);
  if (!goodLanguage) warnings.push(`BROWSER_LANGUAGE is not a language tag such as en-US or nl-NL. Using ${DEFAULT_LANGUAGE}.`);
  if (!goodTimezone) warnings.push(`BROWSER_TIMEZONE is not a time zone such as Europe/Amsterdam. Using ${DEFAULT_TIMEZONE}.`);
  return {
    desktopChrome: !/^(0|false|no|off)$/i.test(env.DESKTOP_CHROME?.trim() ?? ''),
    language: goodLanguage ? language : DEFAULT_LANGUAGE,
    timezone: goodTimezone ? timezone : DEFAULT_TIMEZONE,
    warnings,
  };
}

function isLanguageTag(tag: string): boolean {
  if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(tag)) return false;
  try {
    return Intl.getCanonicalLocales(tag).length === 1;
  } catch {
    return false;
  }
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Chromium flags that make headless Chrome read as a desktop one. Puppeteer
 * already starts Chrome's new headless mode; its "--enable-automation" is left
 * out separately.
 */
export function desktopChromeArgs(language: string): string[] {
  const base = language.split('-')[0]!;
  return [
    '--disable-blink-features=AutomationControlled', // navigator.webdriver stays false
    `--lang=${language}`,
    `--accept-lang=${base === language ? language : `${language},${base}`}`,
    '--window-size=1920,1080',
    '--screen-info={1920x1080}', // headless otherwise reports an 800x600 screen, smaller than the page
  ];
}

/** How often a long-running server fetches the filter lists again. */
const BLOCKLIST_REFRESH_MS = 24 * 60 * 60 * 1000;

const closedByClient = () =>
  new CaptureError('internal', 'The request was closed before the screenshot was taken.', 'client_closed');

/** Errors that a failing proxy causes on the page. When the proxy failed too, the proxy is the cause. */
const PROXY_SYMPTOMS = new Set(['unreachable', 'blank', 'error_page', 'timeout']);

export interface NodeScreenshotter {
  /** Takes a shot. When `signal` aborts (the client went away), the shot stops and its slot frees at once. */
  screenshot(opts: ScreenshotOptions, signal?: AbortSignal): Promise<CaptureResult>;
  /** Settles once the first fetch of the filter lists has finished, whatever the outcome. */
  blocklistsReady: Promise<void>;
  close(): Promise<void>;
}

/** One line for the server log about the operator's proxies, without their logins. */
export function proxyLogLine(proxies: ProxySettings[]): string {
  if (proxies.length === 1) return `Sending browser traffic through ${describeProxy(proxies[0]!)}.`;
  const shown = proxies.slice(0, 5).map(describeProxy).join(', ');
  return `Sending browser traffic through ${proxies.length} proxies in turn: ${shown}${proxies.length > 5 ? ', ...' : ''}.`;
}

export async function startNodeBrowser(options: NodeBrowserOptions = {}): Promise<NodeScreenshotter> {
  const concurrency = options.concurrency ?? 2;
  const queueLimit = options.queueLimit ?? 20;
  const resolve: Resolver = options.resolve ?? (async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address));
  const proxy: EgressProxy = await startEgressProxy({ resolve });
  const desktop = options.desktopChrome !== false;
  const deps: EngineDeps = { resolve, consent: loadConsentAssets(), presentAsChrome: desktop, blocker: createBlocker(null) };
  const pool = options.proxies?.length ? new ProxyPool(options.proxies) : null;
  const onProxyRest =
    options.onProxyRest ??
    ((p: ProxySettings, reason: string, ms: number) =>
      console.warn(`Proxy ${describeProxy(p)} ${reason}. Skipping it for ${Math.round(ms / 1000)} s.`));

  // The lists are swapped in when they arrive; a failed fetch keeps what was there.
  const loadBlocklists = async () => {
    const { lists, problems } = await fetchBlocklists();
    for (const p of problems) console.warn(`Filter lists: ${p}`);
    const rules = ruleCount(lists.ads) + ruleCount(lists.trackers) + ruleCount(lists.cookies);
    if (rules === 0) return;
    deps.blocker = createBlocker(lists);
    console.log(`Filter lists: ${rules} rules from ${lists.source}.`);
  };
  const blocklistsReady = options.fetchBlocklists ? loadBlocklists().catch(() => undefined) : Promise.resolve();
  const refresh = options.fetchBlocklists
    ? setInterval(() => void loadBlocklists().catch(() => undefined), BLOCKLIST_REFRESH_MS)
    : undefined;
  refresh?.unref();

  const launch = () =>
    puppeteer.launch({
      executablePath: options.executablePath ?? findChrome(),
      headless: true, // Chrome's new headless mode, the full browser
      protocolTimeout: 30_000,
      args: [
        `--proxy-server=http://127.0.0.1:${proxy.port}`,
        '--proxy-bypass-list=<-loopback>', // send localhost through the proxy too, so it is refused
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        '--mute-audio',
        ...(desktop ? desktopChromeArgs(options.language ?? DEFAULT_LANGUAGE) : []),
        ...(options.sandbox === false ? ['--no-sandbox'] : []),
      ],
      ...(desktop
        ? {
            ignoreDefaultArgs: ['--enable-automation'],
            env: { ...process.env, TZ: options.timezone ?? DEFAULT_TIMEZONE },
          }
        : {}),
    });

  let browser: Promise<Browser> = launch();
  const current = async () => {
    const b = await browser;
    if (b.connected) return b;
    browser = launch();
    return browser;
  };

  let running = 0;
  const waiting: Array<() => void> = [];
  const acquire = async (signal: AbortSignal | undefined) => {
    if (signal?.aborted) throw closedByClient();
    if (running < concurrency) {
      running++;
      return;
    }
    if (waiting.length >= queueLimit) throw new CaptureError('busy', 'Too many screenshots in progress. Try again shortly.');
    await new Promise<void>((resolve, reject) => {
      const turn = () => {
        signal?.removeEventListener('abort', leave);
        resolve();
      };
      // A client that goes away while waiting leaves the queue.
      const leave = () => {
        waiting.splice(waiting.indexOf(turn), 1);
        reject(closedByClient());
      };
      waiting.push(turn);
      signal?.addEventListener('abort', leave, { once: true });
    });
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };

  /** One try: through `upstream` when given, with a fresh context and, for a proxy, an egress proxy of its own. */
  const attempt = async (
    opts: ScreenshotOptions,
    upstream: ProxySettings | undefined,
    signal: AbortSignal | undefined,
  ): Promise<CaptureResult> => {
    let own: EgressProxy | null = null;
    let proxyFailure: string | null = null;
    try {
      if (upstream) {
        own = await startEgressProxy({
          resolve,
          upstream,
          guardUpstream: Boolean(opts.proxy),
          onUpstreamFailure: (reason) => (proxyFailure ??= reason),
        });
      }
      const chromium = await current();
      const context = own
        ? await chromium.createBrowserContext({ proxyServer: `http://127.0.0.1:${own.port}`, proxyBypassList: ['<-loopback>'] })
        : await chromium.createBrowserContext();
      // Closing the context ends the capture, so a dropped client frees its slot now.
      const stop = () => void context.close().catch(() => undefined);
      signal?.addEventListener('abort', stop, { once: true });
      try {
        if (signal?.aborted) throw closedByClient();
        const page = await context.newPage();
        return await capture(page, opts, deps);
      } catch (err) {
        if (signal?.aborted) throw closedByClient();
        if (proxyFailure && err instanceof CaptureError && PROXY_SYMPTOMS.has(err.code)) {
          throw new CaptureError('proxy_error', `The proxy ${proxyFailure}.`, 'proxy');
        }
        throw err;
      } finally {
        signal?.removeEventListener('abort', stop);
        await closeWithin(context.close(), 5000);
      }
    } finally {
      await own?.close();
    }
  };

  return {
    async screenshot(opts, signal) {
      if (opts.proxy) {
        // A proxy from a request must be on the public internet, like any site.
        const where = await checkHost(opts.proxy.host, resolve);
        if (!where.ok) {
          throw where.unresolved
            ? new CaptureError('proxy_error', 'The proxy could not be found.', 'proxy')
            : new CaptureError('proxy_not_allowed', '"proxy" must be on the public internet, not on a private or local address.');
        }
      }
      await acquire(signal);
      try {
        // A proxy from the request is used alone. Otherwise each try takes the
        // next proxy from the list, one not yet tried for this shot if it can.
        const tried = new Set<ProxySettings>();
        return await withRetries(
          opts,
          async (tryOpts) => {
            if (signal?.aborted) throw closedByClient();
            const fromPool = opts.proxy ? null : (pool?.pick(tried) ?? null);
            if (!fromPool) return attempt(tryOpts, opts.proxy ?? undefined, signal);
            tried.add(fromPool);
            try {
              const result = await attempt(tryOpts, fromPool, signal);
              pool!.worked(fromPool);
              return result;
            } catch (err) {
              if (err instanceof CaptureError && err.code === 'proxy_error') {
                onProxyRest(fromPool, err.message.replace(/^The proxy /, '').replace(/\.$/, ''), pool!.failed(fromPool));
              } else {
                pool!.worked(fromPool);
              }
              throw err;
            }
          },
          { anotherRoute: () => !opts.proxy && pool !== null && pool.hasUntried(tried) },
        );
      } finally {
        release();
      }
    },
    blocklistsReady,
    async close() {
      clearInterval(refresh);
      await closeWithin((await browser).close(), 10_000);
      await proxy.close();
    },
  };
}
