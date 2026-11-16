// The capture pipeline. It takes a fresh page from any puppeteer-compatible
// browser (Cloudflare's in a Worker, Chromium on a server) and turns a URL into
// a clean screenshot or PDF, or into an honest error when there is no clean page
// to show.
//
//   guard the URL  ->  set up the page  ->  load (or render the given html)
//   ->  handle consent  ->  check for walls and errors  ->  clean  ->  click,
//   run scripts  ->  scroll and load images (full page)  ->  clean again
//   ->  check for blank  ->  final check for a banner or pop-up that is still
//   there  ->  screenshot or PDF

import type { HTTPRequest, Page, Protocol } from 'puppeteer-core';
import { createBlocker, type Blocker, type ListKind } from './blocklists.ts';
import { GENERIC_CONSENT, consentToolName, installConsent, type ConsentAssets, type ConsentTracker } from './consent.ts';
import { CaptureError, toCaptureError, unreachableError } from './errors.ts';
import { cachedHostCheck, checkUrl, type Resolver, type Verdict } from './guard.ts';
import { DEVICES, requestPatterns, type ScreenshotOptions } from './options.ts';
import {
  SELECTORS, WORDS, addStyles, cleanPage, closeOverlay, expandScrollContainer, findOverlay, initScript, pageTokens, readMetadata,
  readSignals, restorePage, scrollBackUp, scrollStep, waitForImages, type CleanConfig, type CleanResult, type OverlayConfig,
  type OverlayKind, type PageMetadata,
} from './page-scripts.ts';
import { classifyPage } from './verdict.ts';

export interface EngineDeps {
  /** DNS lookup used by the SSRF guard. Without it, only literal addresses and names are checked. */
  resolve?: Resolver;
  /** Autoconsent's script and rules. Without them, banners are only hidden, never answered. */
  consent?: ConsentAssets;
  /**
   * Send Chrome's own user agent, without "HeadlessChrome". On unless false;
   * "viewport_mobile" and "viewport_device" always set the device's own, "user_agent" the one given.
   */
  presentAsChrome?: boolean;
  /** The filter lists for ads, trackers and cookie banners. Without them, only the small built-in list applies. */
  blocker?: Blocker;
}

interface CaptureInfo {
  finalUrl: string;
  /** HTTP status of the main document, 0 when unknown. */
  status: number;
  /**
   * Things removed from the shot: a cookie banner answered by autoconsent,
   * plus each visible banner, pop-up, backdrop, chat widget or ad hidden by
   * the cleanup. A banner and its own parts count once.
   */
  removed: number;
  /**
   * The consent tool whose banner was removed, such as "OneTrust", or
   * "generic" for a banner recognised by its look and words. Null when no
   * cookie banner was removed.
   */
  consentManager: string | null;
  /** Full height of the page in CSS pixels. */
  pageHeight: number | null;
  /**
   * True when the shot was cut: the page (or the element) was taller than
   * full_page_max_height, or than Chromium can draw in one image.
   */
  truncated: boolean;
  /**
   * A cookie banner or pop-up that was still on screen when the shot was
   * taken, after every attempt to remove it. Null when none was seen.
   */
  overlayRemaining: OverlayKind | null;
  /** Title, description, Open Graph tags and icon of the page. */
  metadata?: PageMetadata;
}

export interface CaptureResult {
  image: Uint8Array;
  contentType: string;
  info: CaptureInfo;
}

/**
 * Chromium can't draw an image taller than this many device pixels: beyond it
 * a screenshot repeats or tiles the page. With device_scale_factor 2 that is
 * 8192 CSS pixels.
 */
const MAX_IMAGE_HEIGHT = 16384;

const BUILT_IN_ONLY = createBlocker(null);

/** Chat-widget hosts. Blocking the request is cleaner than hiding what it draws. */
const CHAT_HOSTS = [
  'widget.intercom.io', 'js.intercomcdn.com', 'js.driftt.com', 'client.crisp.chat', 'embed.tawk.to',
  'static.zdassets.com', 'js.usemessages.com', 'code.tidio.co', 'wchat.freshchat.com', 'cdn.livechatinc.com',
  'static.olark.com', 'beacon-v2.helpscout.net', 'config.gorgias.chat', 'widget-mediator.zopim.com',
  'cdn.chatlio.com', 'widget.manychat.com', 'js.hs-scripts.com',
];

/** Errors that mean the page navigated while a step ran in it. */
const NAVIGATED = /Execution context was destroyed|Cannot find context|detached Frame|context with specified id/i;

/** Time kept back from every wait so the screenshot itself still fits inside the timeout. */
const SCREENSHOT_RESERVE_MS = 3000;

function hostMatches(host: string, list: string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

type Identity = { userAgent: string; userAgentMetadata?: Protocol.Emulation.UserAgentMetadata };

/**
 * The user agent for this shot: the one asked for, the device's own, or the
 * browser's own minus the word that tells sites it runs headless. Null keeps
 * the browser's as it is.
 */
async function chooseIdentity(page: Page, opts: ScreenshotOptions, deps: EngineDeps): Promise<Identity | null> {
  if (opts.userAgent) return { userAgent: opts.userAgent };
  const device = opts.device ? DEVICES[opts.device.replace(/_landscape$/, '')] : undefined;
  if (device?.kind === 'iphone' || device?.kind === 'ipad') {
    const os = device.kind === 'iphone' ? 'iPhone; CPU iPhone OS 17_5' : 'iPad; CPU OS 17_5';
    return { userAgent: `Mozilla/5.0 (${os} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1` };
  }
  const android = opts.viewportMobile;
  if (deps.presentAsChrome === false && !android) return null;
  const real = await page.browser().userAgent();
  const version = /Chrome\/([\d.]+)/.exec(real)?.[1] ?? '130.0.0.0';
  const major = version.split('.')[0]!;
  const phone = android && device?.kind !== 'android_tablet';
  const model = android ? (device?.model ?? 'Pixel 8') : '';
  const userAgent = android
    ? `Mozilla/5.0 (Linux; Android 14; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 ${phone ? 'Mobile ' : ''}Safari/537.36`
    : real.replace('HeadlessChrome', 'Chrome');
  const platform = android ? 'Android' : /Windows/.test(real) ? 'Windows' : /Mac OS/.test(real) ? 'macOS' : 'Linux';
  const brands = [
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
    { brand: 'Not-A.Brand', version: '99' },
  ];
  return {
    userAgent,
    userAgentMetadata: {
      brands,
      fullVersionList: brands.map((b) => ({ ...b, version: b.version === '99' ? '99.0.0.0' : version })),
      fullVersion: version,
      platform,
      platformVersion: '',
      architecture: android ? '' : 'x86',
      model,
      mobile: phone,
    },
  };
}

/** Sets the user agent, and the language when "accept_language" asks for one (header, navigator.language and Intl). */
async function presentIdentity(page: Page, opts: ScreenshotOptions, deps: EngineDeps): Promise<void> {
  const identity = await chooseIdentity(page, opts, deps);
  if (!opts.acceptLanguage) {
    if (identity) await page.setUserAgent(identity.userAgent, identity.userAgentMetadata);
    return;
  }
  const cdp = await page.createCDPSession();
  await cdp.send('Network.setUserAgentOverride', {
    userAgent: identity?.userAgent ?? (await page.browser().userAgent()),
    acceptLanguage: opts.acceptLanguage,
    ...(identity?.userAgentMetadata ? { userAgentMetadata: identity.userAgentMetadata } : {}),
  });
  const locale = /^[a-z]{1,8}(-[a-z0-9]{1,8})*/i.exec(opts.acceptLanguage)?.[0];
  if (locale) await cdp.send('Emulation.setLocaleOverride', { locale: locale.replace(/-/g, '_') }).catch(() => undefined);
}

/** Closing a context can hang on a page in a bad state; never let that hold up the next request. */
export async function closeWithin(closing: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([closing.catch(() => undefined), new Promise((r) => (timer = setTimeout(r, ms)))]);
  clearTimeout(timer);
}

/** Takes a screenshot. The caller owns the page and closes it afterwards, also on error. */
export async function capture(page: Page, opts: ScreenshotOptions, deps: EngineDeps = {}): Promise<CaptureResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CaptureError('timeout', `The capture did not finish within ${opts.timeoutMs / 1000} seconds.`)),
      opts.timeoutMs,
    );
  });
  const work = run(page, opts, deps, Date.now() + opts.timeoutMs);
  work.catch(() => undefined); // if the timeout wins, the page is closed and this rejects unseen
  try {
    return await Promise.race([work, timeout]);
  } catch (err) {
    throw toCaptureError(err);
  } finally {
    clearTimeout(timer);
  }
}

type Refusal = Verdict & { ok: false };

function refuse(v: Refusal): never {
  if (v.unresolved) throw new CaptureError('unreachable', `The site could not be reached: ${v.reason}.`, 'dns');
  throw new CaptureError('url_not_allowed', `This address is not allowed: ${v.reason}.`, 'ssrf');
}

async function run(page: Page, opts: ScreenshotOptions, deps: EngineDeps, deadline: number): Promise<CaptureResult> {
  const shot = new Shot(page, opts, deps, deadline);
  await shot.guardTarget();
  await shot.setUpPage();
  await shot.load();
  await shot.checkPage();
  // Autoconsent can still be at work on a slow banner. If it finishes only
  // after the cleanup hid that banner, the banner was counted there already.
  const dismissedBeforeClean = shot.consent?.dismissed === true;
  await shot.clean();
  await shot.runRequestSteps();
  await shot.scrollAndCleanAgain();
  const overlayRemaining = await shot.finalCheck();
  const consent = shot.consentOutcome(dismissedBeforeClean);
  return shot.take(overlayRemaining, consent);
}

/** One capture: the page, what was asked for, and what was seen along the way. */
class Shot {
  readonly page: Page;
  readonly opts: ScreenshotOptions;
  readonly deps: EngineDeps;
  readonly deadline: number;
  /** The tallest shot in CSS pixels: what was asked, within what Chromium can draw. */
  readonly maxHeight: number;
  readonly hostCheck: ((host: string) => Promise<Verdict>) | null;
  readonly targetHost: string;
  readonly blocker: Blocker;
  consent: ConsentTracker | null = null;
  /** The last main document's status, 0 when unknown. */
  status = 0;
  /** Main-frame navigations so far, to tell when a step sent the page somewhere else. */
  navigations = 0;
  /** The guard's refusal of a main-frame navigation, if there was one. */
  refusedNavigation: Refusal | null = null;
  /** Why the last main-frame navigation failed, for when it ends on Chrome's error page. */
  navigationError = '';
  /** What the cleanup hid, and how many of those were cookie banners. */
  removed = 0;
  cookieBanners = 0;
  pageHeight: number | null = null;

  constructor(page: Page, opts: ScreenshotOptions, deps: EngineDeps, deadline: number) {
    this.page = page;
    this.opts = opts;
    this.deps = deps;
    this.deadline = deadline;
    this.maxHeight = Math.min(opts.fullPageMaxHeight, Math.floor(MAX_IMAGE_HEIGHT / opts.deviceScaleFactor));
    this.hostCheck = deps.resolve ? cachedHostCheck(deps.resolve) : null;
    this.targetHost = opts.url ? new URL(opts.url).hostname : '';
    this.blocker = deps.blocker ?? BUILT_IN_ONLY;
  }

  /** Milliseconds a step may wait, keeping the screenshot reserve. */
  budget(wanted: number): number {
    return Math.max(0, Math.min(wanted, this.deadline - Date.now() - SCREENSHOT_RESERVE_MS));
  }

  pageHost(): string {
    try {
      return new URL(this.page.url()).hostname || this.targetHost;
    } catch {
      return this.targetHost;
    }
  }

  isMainNavigation(req: HTTPRequest): boolean {
    return req.isNavigationRequest() && req.frame() === this.page.mainFrame();
  }

  // 1. Guard the URL before the browser sees it. Given html has no URL, but
  // everything it loads passes the same guard in guardRequests.
  async guardTarget(): Promise<void> {
    if (!this.opts.url) return;
    const first = checkUrl(this.opts.url);
    if (!first.ok) refuse(first);
    if (this.hostCheck) {
      const v = await this.hostCheck(this.targetHost);
      if (!v.ok) refuse(v);
    }
  }

  // 2. Set up the page.
  async setUpPage(): Promise<void> {
    const { page, opts } = this;
    await page.setViewport({
      width: opts.viewportWidth,
      height: opts.viewportHeight,
      deviceScaleFactor: opts.deviceScaleFactor,
      isMobile: opts.viewportMobile,
      hasTouch: opts.viewportMobile,
    });
    await presentIdentity(page, opts, this.deps);
    if (opts.timeZone) await page.emulateTimezone(opts.timeZone);
    await page.emulateMediaFeatures([
      { name: 'prefers-color-scheme', value: opts.darkMode ? 'dark' : 'light' },
      { name: 'prefers-reduced-motion', value: opts.reducedMotion ? 'reduce' : 'no-preference' },
    ]);
    // A one-page PDF is a picture of the screen, so it keeps the screen's layout unless asked otherwise.
    const mediaType = opts.mediaType ?? (opts.format === 'pdf' && opts.pdf.fitOnePage ? 'screen' : null);
    if (mediaType) await page.emulateMediaType(mediaType);
    await page.evaluateOnNewDocument(initScript);
    if (opts.styles) await page.evaluateOnNewDocument(addStyles, opts.styles);
    if (opts.cookies.length > 0) {
      await page.setCookie(...opts.cookies.map((c) => (c.domain ? { path: '/', ...c } : { ...c, url: opts.url! })));
    }
    // A shot has one page; a window the page opens is closed at once.
    page.on('popup', (popup) => void popup?.close().catch(() => undefined));
    this.consent = opts.blockCookieBanners && this.deps.consent ? await installConsent(page, this.deps.consent) : null;
    await this.guardRequests();
    this.watchNavigations();
  }

  /** Every request (redirects, frames, images, scripts) passes the guard, then the blocking options. */
  async guardRequests(): Promise<void> {
    const { page, opts, blocker, hostCheck } = this;
    const blockKinds: ListKind[] = [...(opts.blockAds ? ['ads' as const] : []), ...(opts.blockTrackers ? ['trackers' as const] : [])];
    const blockedRequest = requestPatterns(opts.blockRequests);
    const blockedTypes = new Set(opts.blockResources);
    // Extra headers go only to the site that was asked for (and its subdomains),
    // never to the third parties it loads from: they often carry a login.
    const extraHeaders = Object.fromEntries(opts.headers.map(([name, value]) => [name.toLowerCase(), value]));
    const site = this.targetHost.replace(/^www\./, '');
    const ownSite = (host: string) => site !== '' && (host === site || host.endsWith(`.${site}`));

    await page.setRequestInterception(true);
    page.on('request', (req: HTTPRequest) => {
      void (async () => {
        if (req.isInterceptResolutionHandled()) return;
        const url = req.url();
        let verdict = checkUrl(url);
        const { protocol, hostname } = verdict.ok && /^(https?|wss?):/.test(url) ? new URL(url) : { protocol: '', hostname: '' };
        if (verdict.ok && hostCheck && protocol) verdict = await hostCheck(hostname);
        if (!verdict.ok) {
          if (this.isMainNavigation(req)) this.refusedNavigation = verdict;
          return req.abort('accessdenied');
        }
        // Never the page itself, only what it loads.
        const isPage = this.isMainNavigation(req);
        if (!isPage && (blockedTypes.has(req.resourceType()) || (hostname && blockedRequest(url, hostname)))) {
          return req.abort('blockedbyclient');
        }
        if (hostname && !isPage && (blocker.blocks(hostname, this.pageHost(), blockKinds) || (opts.blockChats && hostMatches(hostname, CHAT_HOSTS)))) {
          return req.abort('blockedbyclient');
        }
        if (opts.headers.length > 0 && ownSite(hostname)) return req.continue({ headers: { ...req.headers(), ...extraHeaders } });
        return req.continue();
      })().catch(() => undefined);
    });
  }

  watchNavigations(): void {
    const { page } = this;
    // The status that counts is the last main document's: a consent gate or a
    // challenge may navigate on to the real page after the first response.
    page.on('response', (res) => {
      if (this.isMainNavigation(res.request()) && (res.status() < 300 || res.status() >= 400)) this.status = res.status();
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.navigations++;
    });
    page.on('requestfailed', (req) => {
      if (this.isMainNavigation(req)) this.navigationError = req.failure()?.errorText ?? '';
    });
  }

  /**
   * A navigation that fails, also a later one (a redirect by script, a
   * consent tool sending the page on), leaves Chrome's own error page in its
   * place. That is never the page asked for.
   */
  refuseErrorPage(): void {
    if (!this.page.url().startsWith('chrome-error://')) return;
    if (this.refusedNavigation) refuse(this.refusedNavigation);
    const code = /ERR_[A-Z_]+/.exec(this.navigationError)?.[0];
    throw unreachableError(this.navigationError) ?? new CaptureError(
      'error_page',
      `The page could not be loaded${code ? ` (${code})` : ''}: the browser showed its own error page.`,
      code ?? 'browser_error_page',
    );
  }

  /** Runs a step in the page, again if the page navigated away under it. */
  async inPage<T>(step: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await step();
      } catch (err) {
        if (!NAVIGATED.test(String(err)) || attempt >= 3) throw err;
        await this.waitForLoad(5000);
      }
    }
  }

  async waitForLoad(ms: number): Promise<void> {
    await this.page
      .waitForFunction('document.readyState === "complete"', { timeout: this.budget(ms) })
      .catch(() => undefined);
    await this.waitForText();
  }

  /** Script-built pages may still be empty for a moment after "load". */
  async waitForText(): Promise<void> {
    await this.page
      .waitForFunction('(document.body?.innerText || "").trim().length >= 100', { timeout: this.budget(3000) })
      .catch(() => undefined);
  }

  /** Waits up to `ms` (within the budget) for the page to stop fetching for `idleTime`. */
  async networkQuiet(idleTime: number, ms: number): Promise<void> {
    const timeout = this.budget(ms);
    if (timeout < 50) return;
    await this.page.waitForNetworkIdle({ idleTime, timeout }).catch(() => undefined);
  }

  // 3. Load. A page that never goes quiet (live tickers, long polling) still gets its shot.
  async load(): Promise<void> {
    const { page, opts } = this;
    const waitUntil = opts.waitUntil === 'domcontentloaded' ? 'domcontentloaded' : 'load';
    try {
      if (opts.url) {
        const response = await page.goto(opts.url, { waitUntil, timeout: this.budget(opts.timeoutMs) });
        this.status = response?.status() ?? this.status;
      } else {
        // A new blank document first, so the scripts set up above run in it.
        await page.goto('about:blank');
        await page.setContent(opts.html ?? '', { waitUntil, timeout: this.budget(opts.timeoutMs) });
      }
    } catch (err) {
      if (this.refusedNavigation) refuse(this.refusedNavigation);
      const isTimeout = /timeout/i.test(String(err));
      const hasContent = isTimeout && (await page.evaluate(() => (document.body?.innerText ?? '').trim().length).catch(() => 0)) > 0;
      if (!hasContent) {
        throw isTimeout ? new CaptureError('timeout', 'The page did not load in time.', 'navigation') : toCaptureError(err);
      }
    }
    if (this.refusedNavigation) refuse(this.refusedNavigation);
    if (opts.waitUntil.startsWith('networkidle')) {
      await page
        .waitForNetworkIdle({ idleTime: 500, concurrency: opts.waitUntil === 'networkidle0' ? 0 : 2, timeout: this.budget(10000) })
        .catch(() => undefined);
    }
    if (opts.url) await this.waitForText();
    const before = this.navigations;
    await this.consent?.settle(this.budget(4000));
    if (this.navigations > before || this.consent?.done) {
      // Answering a consent gate often reloads the page or sends it back to the site.
      await sleep(this.budget(500));
      await this.waitForLoad(10000);
    }

    if (opts.waitForSelector) {
      try {
        await page.waitForSelector(opts.waitForSelector, { timeout: this.budget(opts.timeoutMs) });
      } catch {
        throw new CaptureError('selector_not_found', `Nothing matched "${opts.waitForSelector}" in time.`);
      }
    }
  }

  // 4. Is this the page, or a wall or error page in its place? Given html is taken as it is.
  async checkPage(): Promise<void> {
    if ((await this.judge(true)) === 'blank') {
      await sleep(this.budget(2000)); // give a slow page one more chance before calling it empty
      await this.judge(false);
    }
  }

  async judge(allowBlank: boolean): Promise<string> {
    this.refuseErrorPage();
    if (!this.opts.url) return 'ok';
    const signals = await this.inPage(() => this.page.evaluate(readSignals));
    const verdict = classifyPage({ ...signals, host: this.pageHost(), status: this.status });
    if (verdict.kind === 'ok' || (verdict.kind === 'blank' && allowBlank)) return verdict.kind;
    throw new CaptureError(verdict.kind, verdict.detail, verdict.reason);
  }

  // 5. Clean, scroll, clean again: some pop-ups only appear after scrolling or a delay.
  // The cookie list's selectors come in here, after autoconsent has had its
  // turn: hiding a banner first would keep it from being answered.
  // Only the selectors that can match the page's classes and ids are sent in:
  // the lists hold tens of thousands.
  async cleanConfig(): Promise<CleanConfig> {
    const { opts, blocker } = this;
    const host = this.pageHost();
    const tokens = opts.blockCookieBanners || opts.blockAds ? await this.inPage(() => this.page.evaluate(pageTokens)) : [];
    return {
      cookieBanners: opts.blockCookieBanners,
      popups: opts.blockPopups,
      chats: opts.blockChats,
      ads: opts.blockAds,
      hideSelectors: opts.hideSelectors,
      selectors: {
        cookie: opts.blockCookieBanners ? [...SELECTORS.cookie, ...blocker.selectors(host, 'cookies', tokens)] : [],
        cornerWidget: SELECTORS.cornerWidget,
        ad: opts.blockAds ? [...SELECTORS.ad, ...blocker.selectors(host, 'ads', tokens)] : [],
      },
      words: WORDS,
    };
  }

  async clean(): Promise<void> {
    const { opts } = this;
    const wantsClean = opts.blockCookieBanners || opts.blockPopups || opts.blockChats || opts.blockAds || opts.hideSelectors.length > 0;
    if (!wantsClean) return;
    const config = await this.cleanConfig();
    const result: CleanResult = await this.inPage(() => this.page.evaluate(cleanPage, config));
    // If the cleanup took the content with it, the page lived inside a "pop-up": put it back.
    const tookContent = result.textBefore >= 200 && result.textAfter < Math.max(40, result.textBefore * 0.05);
    if (tookContent) {
      await this.inPage(() => this.page.evaluate(restorePage));
      this.removed = 0;
      this.cookieBanners = 0;
    } else {
      this.removed += result.removed;
      this.cookieBanners += result.cookieBanners;
    }
  }

  async applyStyles(): Promise<void> {
    if (this.opts.styles) await this.inPage(() => this.page.evaluate(addStyles, this.opts.styles!));
  }

  // The request's own steps: clicks in order, then its script, each followed
  // by a moment for what it set off. Styles go on again in case either navigated.
  async runRequestSteps(): Promise<void> {
    const { opts } = this;
    await this.applyStyles();
    for (const selector of opts.click) await this.click(selector);
    if (opts.scripts) await this.runScripts(opts.scripts);
    if (opts.click.length > 0 || opts.scripts) await this.applyStyles();
  }

  async click(selector: string): Promise<void> {
    const element = await this.page.waitForSelector(selector, { timeout: this.budget(5000) }).catch(() => null);
    if (!element) throw new CaptureError('selector_not_found', `Nothing matched "${selector}" to click.`);
    const before = this.navigations;
    await element.click().catch(() => element.evaluate((el) => (el as HTMLElement).click())).catch(() => undefined);
    await sleep(this.budget(300));
    if (this.navigations > before) await this.waitForLoad(10000);
    else await this.networkQuiet(200, 1500);
  }

  async runScripts(scripts: string): Promise<void> {
    const before = this.navigations;
    const script = this.page.evaluate(`(async () => {\n${scripts}\n})()`).then(() => true, (err: unknown) => {
      if (NAVIGATED.test(String(err))) return true;
      const message = String((err as Error)?.message ?? err).split('\n')[0]!.slice(0, 300);
      throw new CaptureError('script_error', `"scripts" failed: ${message}`);
    });
    if (!(await Promise.race([script, sleep(this.budget(this.opts.timeoutMs)).then(() => false)]))) {
      throw new CaptureError('script_error', '"scripts" did not finish in time.');
    }
    if (this.navigations > before) await this.waitForLoad(10000);
    await this.networkQuiet(300, 2000);
  }

  async scrollAndCleanAgain(): Promise<void> {
    const { opts } = this;
    // A PDF, and a clip reaching below the window, need the whole page loaded like a full-page shot.
    const clip = opts.clip;
    const wholePage = opts.fullPage || opts.format === 'pdf' || (clip !== null && clip.y + clip.height > opts.viewportHeight);
    if (wholePage) {
      await this.loadWholePage(15000);
    } else {
      await sleep(this.budget(300));
    }
    await this.clean();
    if (opts.delayMs) await sleep(this.budget(opts.delayMs));
    await this.judge(false);
  }

  /**
   * Scrolls through the page one step at a time so lazy images and
   * scroll-triggered content load, giving each step a moment to fetch what
   * came into view (a page that never stops fetching moves on after half a
   * second), then waits at the top for every image in the shot.
   */
  async loadWholePage(ms: number): Promise<void> {
    const { page, maxHeight } = this;
    const end = Date.now() + this.budget(ms);
    const left = (cap: number) => Math.max(0, Math.min(cap, end - Date.now()));
    for (let step = 0; step < 500 && left(1) > 0; step++) {
      const more = await this.inPage(() => page.evaluate(scrollStep, { maxHeight }));
      await this.networkQuiet(150, left(500));
      if (!more) break;
    }
    await this.inPage(() => page.evaluate(scrollBackUp));
    await this.networkQuiet(300, left(2000));
    await this.inPage(() => page.evaluate(waitForImages, { maxHeight, timeoutMs: Math.max(200, left(4000)) }));
  }

  // 6. The final check: is a banner or pop-up still on screen? If so, one more
  // pass (Escape, then a refusal or close button, then the cleanup again). One
  // that survives that is reported, never passed off as a clean shot.
  async finalCheck(): Promise<OverlayKind | null> {
    const { page, opts } = this;
    if (!opts.blockCookieBanners && !opts.blockPopups) return null;
    const overlayConfig: OverlayConfig = { cookieBanners: opts.blockCookieBanners, popups: opts.blockPopups, words: WORDS };
    const findLeftover = () => this.inPage(() => page.evaluate(findOverlay, overlayConfig));
    if (!(await findLeftover())) return null;
    await page.keyboard.press('Escape').catch(() => undefined);
    await sleep(this.budget(300));
    if (await findLeftover()) {
      const before = this.navigations;
      const pressed = await this.inPage(() => page.evaluate(closeOverlay, overlayConfig)).catch(() => false);
      if (pressed) await sleep(this.budget(700));
      if (this.navigations > before) await this.waitForLoad(10000); // some consent tools reload the page after a choice
    }
    await this.clean();
    return findLeftover();
  }

  /** What was removed in all, and the consent tool behind the cookie banner, if one was removed. */
  consentOutcome(dismissedBeforeClean: boolean): { removed: number; consentManager: string | null } {
    const { consent, cookieBanners } = this;
    // A banner autoconsent answered is gone before the cleanup sees it; count it here.
    const consentDismissed = consent?.dismissed === true;
    const countDismissal = consentDismissed && (dismissedBeforeClean || cookieBanners === 0);
    const consentManager = consentDismissed || (cookieBanners > 0 && consent?.cmp)
      ? consentToolName(consent?.cmp ?? null)
      : cookieBanners > 0 ? GENERIC_CONSENT : null;
    return { removed: this.removed + (countDismissal ? 1 : 0), consentManager };
  }

  // 7. Screenshot or PDF. Metadata alone needs neither.
  async take(
    overlayRemaining: OverlayKind | null,
    { removed, consentManager }: { removed: number; consentManager: string | null },
  ): Promise<CaptureResult> {
    const { opts } = this;
    this.refuseErrorPage();
    await this.applyStyles();
    const metadata = await this.inPage(() => this.page.evaluate(readMetadata));
    const { image, truncated } = opts.responseType === 'metadata' ? { image: new Uint8Array(), truncated: false } : await this.render();
    return {
      image,
      contentType: opts.format === 'pdf' ? 'application/pdf' : `image/${opts.format}`,
      info: {
        finalUrl: this.page.url(),
        status: this.status,
        removed,
        consentManager,
        pageHeight: this.pageHeight ?? metadata.height,
        truncated,
        overlayRemaining,
        metadata,
      },
    };
  }

  shotOptions() {
    const type = this.opts.format === 'pdf' ? 'png' : this.opts.format;
    return { type, quality: type === 'png' ? undefined : this.opts.imageQuality, omitBackground: this.opts.omitBackground } as const;
  }

  /** The image or PDF itself, and whether it was cut. */
  async render(): Promise<{ image: Uint8Array; truncated: boolean }> {
    const { page, opts, maxHeight } = this;
    const shotOptions = this.shotOptions();
    if (opts.format === 'pdf') return this.renderPdf();
    if (opts.clip) {
      const height = Math.min(opts.clip.height, maxHeight);
      return { image: await page.screenshot({ ...shotOptions, clip: { ...opts.clip, height } }), truncated: height < opts.clip.height };
    }
    if (opts.selector) {
      const element = await page.$(opts.selector);
      if (!element) throw new CaptureError('selector_not_found', `Nothing matched "${opts.selector}".`);
      const box = await element.boundingBox();
      const truncated = box !== null && box.height > maxHeight;
      const image = await element.screenshot(
        truncated ? { ...shotOptions, clip: { x: 0, y: 0, width: box!.width, height: maxHeight } } : shotOptions,
      );
      return { image, truncated };
    }
    if (opts.fullPage) return this.renderFullPage();
    return { image: await page.screenshot(shotOptions), truncated: false };
  }

  async renderPdf(): Promise<{ image: Uint8Array; truncated: boolean }> {
    const { page, opts } = this;
    const pageHeight = await this.inPage(() => page.evaluate(expandScrollContainer));
    this.pageHeight = pageHeight;
    const { fitOnePage, paperFormat, landscape, printBackground, margin } = opts.pdf;
    const size = fitOnePage
      ? { width: `${opts.viewportWidth}px`, height: `${Math.min(pageHeight, opts.fullPageMaxHeight)}px`, pageRanges: '1' }
      : { format: paperFormat, landscape };
    const image = await page.pdf({
      ...size,
      printBackground,
      margin,
      omitBackground: opts.omitBackground,
      timeout: Math.max(1000, this.deadline - Date.now()),
    });
    return { image, truncated: fitOnePage && pageHeight > opts.fullPageMaxHeight };
  }

  async renderFullPage(): Promise<{ image: Uint8Array; truncated: boolean }> {
    const { page, opts, maxHeight } = this;
    const shotOptions = this.shotOptions();
    const pageHeight = await this.inPage(() => page.evaluate(expandScrollContainer));
    this.pageHeight = pageHeight;
    if (pageHeight <= maxHeight) return { image: await page.screenshot({ ...shotOptions, fullPage: true }), truncated: false };
    // Grow the window to the cut-off height and shoot that. A clipped capture
    // beyond the viewport drops pinned headers on some sites.
    await page.setViewport({
      width: opts.viewportWidth,
      height: maxHeight,
      deviceScaleFactor: opts.deviceScaleFactor,
      isMobile: opts.viewportMobile,
      hasTouch: opts.viewportMobile,
    });
    await this.inPage(() => page.evaluate(() => window.scrollTo(0, 0)));
    await sleep(this.budget(300));
    await this.inPage(() => page.evaluate(waitForImages, { maxHeight, timeoutMs: this.budget(2000) }));
    return { image: await page.screenshot(shotOptions), truncated: true };
  }
}
