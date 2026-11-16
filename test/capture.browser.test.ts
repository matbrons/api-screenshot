// End-to-end tests of the capture engine against small local pages, in a real
// Chromium. Skipped when no Chrome or Chromium is installed.
//
// The pages are served from 127.0.0.1 under the name site.example.com: Chromium
// is told to map that name to localhost, and the guard is given a resolver that
// says it is public. That way the guard is tested on what the page does next.

import http from 'node:http';
import type net from 'node:net';
import puppeteer, { type Browser } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlocker, emptyListSet } from '../src/blocklists.ts';
import { capture, type EngineDeps } from '../src/capture.ts';
import { CaptureError } from '../src/errors.ts';
import { findChrome, loadConsentAssets } from '../src/node-browser.ts';
import { parseOptions } from '../src/options.ts';
import { readPng } from './helpers/png.ts';

let chrome: string | null = null;
try {
  chrome = findChrome();
} catch {
  chrome = null;
}

const LAZY_SECTIONS = 8;
const TALL_BANDS = 12;
const bandColour = (i: number) => [i * 20, 40, 255 - i * 20] as const;
const RED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#e00000"/></svg>';
const longText = '<p>' + 'This is the real content of the page, long enough to count as a page. '.repeat(30) + '</p>';
const PAGES: Record<string, [number, string]> = {
  '/redirect': [302, ''],
  '/js-escape': [200, `${longText}<script>location.href = "http://127.0.0.1:1/secret"</script>`],
  // The page sends itself on to a site that doesn't exist, or to one that redirects forever.
  '/dead-end': [200, `${longText}<script>setTimeout(() => location.href = "http://gone.example.com:{PORT}/", 100)</script>`],
  '/loop-later': [200, `${longText}<script>setTimeout(() => location.href = "/loop", 100)</script>`],
  '/banner': [200, `<h1>Article</h1>${longText}
    <div id="cookie-bar" style="position:fixed;bottom:0;left:0;right:0;padding:20px;background:#333;color:#fff;z-index:99">
      We use cookies to improve your experience. <button>Accept all</button> <button>Reject</button>
    </div>
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100"></div>
    <div role="dialog" style="position:fixed;top:20%;left:25%;width:50%;height:50%;background:#fff;z-index:101">
      Join our newsletter and get 10% off! <input type="email" placeholder="Your email"> <button aria-label="Close">×</button>
    </div>
    <script>document.body.style.overflow = 'hidden'</script>`],
  // A banner the consent library knows (CookieYes) and answers by clicking "Reject All".
  '/consent-tool': [200, `<h1>Article</h1>${longText}
    <div class="cky-consent-container" style="position:fixed;bottom:0;left:0;right:0;padding:20px;background:#fff;z-index:99">
      We use cookies to improve your experience.
      <button data-cky-tag="reject-button" onclick="this.closest('.cky-consent-container').remove()">Reject All</button>
      <button data-cky-tag="accept-button">Accept All</button>
    </div>`],
  // A Cookiebot banner. Autoconsent finds and answers it only through its own
  // snippets that run in the page (window.Cookiebot), not by clicking.
  '/cookiebot': [200, `<h1>Article</h1>${longText}
    <div id="CybotCookiebotDialog" style="position:fixed;bottom:0;left:0;right:0;height:150px;background:#fff;z-index:99">
      We use cookies. <button>Allow all</button></div>
    <script>
      window.Cookiebot = {
        hasResponse: false, declined: false, dialog: { visible: true },
        withdraw() { this.hasResponse = true; this.declined = true; },
        hide() { this.dialog.visible = false; document.getElementById('CybotCookiebotDialog').remove(); },
      };
    </script>`],
  // A page script that calls the bridge autoconsent talks to, asking it to run code of its own.
  '/consent-bridge': [200, `<h1>Article</h1>${longText}
    <script>
      const ask = () => window.autoconsentSendMessage?.({ type: 'eval', id: 'x', code: 'document.body.dataset.ran = "yes"; true' });
      ask();
      setTimeout(ask, 100);
      addEventListener('load', ask);
    </script>`],
  // A consent box made of two known containers, one inside the other, and a closed one.
  '/nested-banner': [200, `<h1>Article</h1>${longText}
    <div id="onetrust-consent-sdk"><div id="onetrust-banner-sdk" style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#eee">
      We use cookies. <button>Accept all</button></div></div>
    <div id="cookie-notice" style="display:none">We use cookies. <button>OK</button></div>`],
  // Each section fetches its content when scrolled into view, then adds a lazy
  // image; both arrive slowly, as on a large travel or shop page.
  '/lazy': [200, `<style>body { margin: 0 } section { height: 700px } img { display: block }</style>
    <div style="height: 800px; overflow: hidden">${longText}</div>
    ${Array.from({ length: LAZY_SECTIONS }, (_, i) => `<section data-n="${i}"></section>`).join('')}
    <script>
      const seen = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          seen.unobserve(entry.target);
          fetch('/section').then(() => {
            const img = document.createElement('img');
            img.loading = 'lazy';
            img.width = 400;
            img.height = 300;
            img.src = '/img/' + entry.target.dataset.n + '.svg';
            entry.target.appendChild(img);
          });
        }
      });
      document.querySelectorAll('section').forEach((s) => seen.observe(s));
    </script>`],
  // Twelve 1000px bands, each its own colour, so a repeated or tiled part of
  // the page shows up as the wrong colour.
  '/tall': [200, `<style>body { margin: 0 } section { height: 1000px; color: #fff; font: 20px sans-serif }</style>
    <main>${Array.from({ length: TALL_BANDS }, (_, i) => `<section style="background: rgb(${bandColour(i).join(',')})">Part ${i + 1} of a long page with real words in it.</section>`).join('')}</main>`],
  // Ads and a tracker from other hosts, and boxes the filter lists below name.
  '/ads': [200, `<h1>News</h1>${longText}
    <img id="ad-image" src="http://ads.example.net:{PORT}/ad.svg" width="300" height="250">
    <script src="http://tracker.example.org:{PORT}/t.js"></script>
    <div id="sponsored" class="sponsored-box">Sponsored</div>
    <div id="site-ad" class="site-ad">Advertisement</div>
    <div id="house-promo" class="house-promo">Our own spring sale</div>`],
  // A consent wall without a word the heuristics know; only the cookie list names it.
  '/cmp-wall': [200, `<h1>Article</h1>${longText}
    <div id="wall" class="cmp-wall" style="position:fixed;bottom:0;left:0;right:0;height:150px;background:#eee">
      Your choices matter to us. <button>Agree</button></div>`],
  // A cookie banner with no button the engine may press.
  '/stubborn-banner': [200, `<h1>Article</h1>${longText}
    <div style="position:fixed;bottom:0;left:0;right:0;height:200px;background:#eee;z-index:9">
      We use cookies to measure our audience. <button>Manage options</button></div>`],
  // Dialogs the first cleanup leaves alone: no pitch and no close button it knows.
  '/escape-popup': [200, `<h1>Article</h1>${longText}
    <div id="pop" role="dialog" style="position:fixed;top:25%;left:25%;width:50%;height:50%;background:#fff;z-index:9">
      Before you go, read our guide.</div>
    <script>addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('pop').remove() })</script>`],
  '/no-thanks-popup': [200, `<h1>Article</h1>${longText}
    <div id="pop" role="dialog" style="position:fixed;top:20%;left:20%;width:60%;height:60%;background:#fff;z-index:9">
      Our app is faster. <button onclick="this.parentElement.remove()">No thanks</button></div>`],
  // A site's own headers: pinned to the top, with sign-up words in the menu. They must stay.
  '/headers': [200, `<style>body { margin: 0 }</style>
    <header id="top" style="position:fixed;top:0;left:0;right:0;height:90px;background:rgb(0,160,0);z-index:5">
      Our cookies · Cakes · <a href="#">Sign up</a> · <a href="#">Subscribe</a></header>
    <nav id="nav" style="position:sticky;top:90px;height:50px;background:rgb(0,0,160)"><a href="#">Join our club</a> <a href="#">Newsletter</a></nav>
    <main style="padding-top:90px">${longText}${longText}</main>`],
  '/plain': [200, `<div id="box" style="width:100px;height:100px;background:rgb(0,0,0)"></div><h1>Plain page</h1>${longText}
    <button id="go" onclick="document.getElementById('box').style.background = 'rgb(200,0,0)'">Go</button>`],
  '/meta': [200, `<title>Meta page</title><meta name="description" content="A page about tests.">
    <meta property="og:title" content="Shared title"><meta property="og:image" content="http://site.example.com/og.png">
    <link rel="icon" href="/icon.png"><h1>Meta</h1>${longText}`],
  '/blank': [200, '<div></div>'],
  '/challenge': [403, '<title>Just a moment...</title><p>Verifying you are human. This may take a few seconds.</p>'],
  '/down': [503, '<h1>Service Unavailable</h1>'],
};

let server: http.Server;
let port = 0;
let browser: Browser;
const resolve = async (host: string) => (host === 'site.example.com' ? ['93.184.215.14'] : ['127.0.0.1']);
/** Every host the tests serve counts as public, so only the filter lists can stop a request. */
const allPublic = async () => ['93.184.215.14'];
/** Requests the server saw, as "host/path". */
let hits: string[] = [];
/** The headers of each request, by "host/path". */
const seen = new Map<string, http.IncomingHttpHeaders>();

const ads = emptyListSet();
ads.block = ['ads.example.net'];
ads.hide = ['.sponsored-box', '.house-promo'];
ads.hideOn = { 'site.example.com': ['.site-ad'] };
ads.showOn = { 'site.example.com': ['.house-promo'] };
const trackers = emptyListSet();
trackers.block = ['tracker.example.org'];
const cookies = emptyListSet();
cookies.hide = ['.cmp-wall'];
const blocker = createBlocker({ ads, trackers, cookies, source: 'test lists' });

beforeAll(async () => {
  if (!chrome) return;
  server = http.createServer((req, res) => {
    hits.push(`${(req.headers.host ?? '').split(':')[0]}${req.url}`);
    seen.set(hits.at(-1)!, req.headers);
    if (req.url === '/section') return void setTimeout(() => res.writeHead(200).end('ok'), 300);
    if (req.url === '/loop') return res.writeHead(302, { location: '/loop' }).end();
    if (req.url === '/redirect-dead') return res.writeHead(302, { location: `http://gone.example.com:${port}/` }).end();
    if (req.url?.startsWith('/img/')) {
      return void setTimeout(() => res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(RED_SVG), 400);
    }
    const page = PAGES[req.url ?? ''];
    if (!page) return res.writeHead(404).end();
    if (page[0] === 302) return res.writeHead(302, { location: `http://127.0.0.1:${port}/blank` }).end();
    const body = page[1].replaceAll('{PORT}', String(port));
    res.writeHead(page[0], { 'content-type': 'text/html' }).end(`<!doctype html><html><body>${body}</body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as net.AddressInfo).port;
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    // The pages come from this machine: without the first flag, Chromium refuses a blank page's requests to it.
    args: ['--no-sandbox', '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests', '--host-resolver-rules=MAP site.example.com 127.0.0.1, MAP ads.example.net 127.0.0.1, MAP tracker.example.org 127.0.0.1, MAP gone.example.com ~NOTFOUND'],
  });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

async function shoot(path: string, extra: Record<string, unknown> = {}, deps: Partial<EngineDeps> = {}) {
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    const opts = parseOptions({ url: `http://site.example.com:${port}${path}`, timeout: 15, ...extra });
    const result = await capture(page, opts, { resolve, ...deps });
    const bannerInPage = await page.evaluate(() => document.querySelector('.cky-consent-container') !== null);
    const visible = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[id]')).filter((el) => el.checkVisibility()).map((el) => el.id),
    );
    return { ...result, bannerInPage, visible };
  } finally {
    await context.close();
  }
}

async function failure(path: string): Promise<CaptureError> {
  try {
    await shoot(path);
  } catch (err) {
    return err as CaptureError;
  }
  throw new Error(`expected ${path} to fail`);
}

describe.skipIf(!chrome)('capture in a real browser', () => {
  it('refuses a redirect to a private address', async () => {
    expect((await failure('/redirect')).code).toBe('url_not_allowed');
  }, 30_000);

  it('refuses a script navigation to a private address', async () => {
    expect((await failure('/js-escape')).code).toBe('url_not_allowed');
  }, 30_000);

  it("never returns Chrome's own error page as a shot", async () => {
    const failed = async (path: string) => {
      try {
        await shoot(path, {}, { resolve: allPublic });
      } catch (err) {
        return err as CaptureError;
      }
      throw new Error(`expected ${path} to fail`);
    };
    // A redirect, or a later navigation by script, to a site that can't be found.
    for (const path of ['/redirect-dead', '/dead-end']) {
      expect(await failed(path)).toMatchObject({ code: 'unreachable', reason: 'ERR_NAME_NOT_RESOLVED' });
    }
    expect(await failed('/loop-later')).toMatchObject({ code: 'error_page', reason: 'ERR_TOO_MANY_REDIRECTS' });
  }, 60_000);

  it('removes a cookie bar and a newsletter pop-up, and unlocks scrolling', async () => {
    const { image, info } = await shoot('/banner', { full_page: true });
    expect(info.removed).toBeGreaterThanOrEqual(2);
    expect(info.status).toBe(200);
    expect(image.byteLength).toBeGreaterThan(1000);
  }, 30_000);

  it('keeps the banner when asked to', async () => {
    const { info } = await shoot('/banner', { block_cookie_banners: false, block_popups: false });
    expect(info.removed).toBe(0);
  }, 30_000);

  it('counts a banner the consent library answered, and names its tool', async () => {
    const { info, bannerInPage } = await shoot('/consent-tool', { block_popups: false }, { consent: loadConsentAssets() });
    expect(bannerInPage).toBe(false); // answered with "Reject All", not hidden by the cleanup
    expect(info.consentManager).toBe('CookieYes');
    expect(info.removed).toBe(1);
  }, 30_000);

  it('answers a banner through the consent library\'s own in-page snippets', async () => {
    const { info, visible } = await shoot('/cookiebot', { block_popups: false }, { consent: loadConsentAssets() });
    expect(info.consentManager).toBe('Cookiebot');
    expect(visible).not.toContain('CybotCookiebotDialog');
    expect(info.removed).toBe(1);
  }, 30_000);

  it('runs no code a page script sends to the consent library\'s bridge', async () => {
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      const opts = parseOptions({ url: `http://site.example.com:${port}/consent-bridge`, timeout: 15 });
      await capture(page, opts, { resolve, consent: loadConsentAssets() });
      const bridge = await page.evaluate(() => typeof (window as { autoconsentSendMessage?: unknown }).autoconsentSendMessage);
      expect(bridge).toBe('function'); // the page could reach it
      expect(await page.evaluate(() => document.body.dataset.ran ?? null)).toBeNull();
    } finally {
      await context.close();
    }
  }, 30_000);

  it('counts a banner once, and not one that was already closed', async () => {
    const { info } = await shoot('/nested-banner', { block_popups: false });
    expect(info.removed).toBe(1);
    expect(info.consentManager).toBe('generic');
  }, 30_000);

  it('names no consent tool when no banner was removed', async () => {
    const { info } = await shoot('/lazy');
    expect(info.consentManager).toBeNull();
    expect(info.removed).toBe(0);
  }, 30_000);

  it('loads lazy images all the way down before a full-page shot', async () => {
    const { image, info } = await shoot('/lazy', { full_page: true, format: 'png' });
    const png = readPng(image);
    expect(png.height).toBe(info.pageHeight);
    const missing: number[] = [];
    for (let i = 0; i < LAZY_SECTIONS; i++) {
      const [r, g, b] = png.pixel(200, 800 + i * 700 + 150);
      if (!(r > 200 && g < 60 && b < 60)) missing.push(i);
    }
    expect(missing).toEqual([]);
  }, 30_000);

  it('cuts a shot where Chromium would start repeating the page', async () => {
    // 12000 CSS pixels at scale 2 is 24000 device pixels; Chromium draws 16384.
    const near = (got: number[], want: readonly number[]) => got.every((v, k) => Math.abs(v - want[k]!) < 8);
    for (const extra of [{ full_page: true }, { selector: 'main' }]) {
      const { image, info } = await shoot('/tall', {
        ...extra, format: 'png', device_scale_factor: 2, viewport_width: 300, full_page_max_height: 20000,
      });
      const shot = readPng(image);
      expect(info.truncated).toBe(true);
      expect(shot.height).toBe(16384);
      // The last rows hold band 9 (CSS 8000 to 9000), not a copy of the top.
      expect(near(shot.pixel(100, 16380), bandColour(8))).toBe(true);
      expect(near(shot.pixel(100, 15000), bandColour(7))).toBe(true);
    }
  }, 60_000);

  it('blocks ad and tracker hosts the lists name, unless asked not to', async () => {
    hits = [];
    await shoot('/ads', {}, { resolve: allPublic, blocker });
    expect(hits).not.toContain('ads.example.net/ad.svg');
    expect(hits).not.toContain('tracker.example.org/t.js');
    hits = [];
    await shoot('/ads', { block_trackers: false }, { resolve: allPublic, blocker });
    expect(hits).not.toContain('ads.example.net/ad.svg');
    expect(hits).toContain('tracker.example.org/t.js');
    hits = [];
    await shoot('/ads', { block_ads: false, block_trackers: false }, { resolve: allPublic, blocker });
    expect(hits).toEqual(expect.arrayContaining(['ads.example.net/ad.svg', 'tracker.example.org/t.js']));
  }, 30_000);

  it('hides the boxes the ad list names, and keeps its exceptions', async () => {
    const { visible } = await shoot('/ads', {}, { resolve: allPublic, blocker });
    expect(visible).not.toContain('sponsored');
    expect(visible).not.toContain('site-ad');
    expect(visible).toContain('house-promo');
    const kept = await shoot('/ads', { block_ads: false }, { resolve: allPublic, blocker });
    expect(kept.visible).toEqual(expect.arrayContaining(['sponsored', 'site-ad']));
  }, 30_000);

  it('hides a consent wall the heuristics miss when the cookie list names it', async () => {
    const without = await shoot('/cmp-wall');
    expect(without.visible).toContain('wall');
    const { visible, info } = await shoot('/cmp-wall', {}, { blocker });
    expect(visible).not.toContain('wall');
    expect(info.removed).toBe(1);
    expect(info.overlayRemaining).toBeNull();
  }, 30_000);

  it('says so when a cookie banner survives', async () => {
    const { info } = await shoot('/stubborn-banner');
    expect(info.overlayRemaining).toBe('cookie_banner');
    const off = await shoot('/stubborn-banner', { block_cookie_banners: false });
    expect(off.info.overlayRemaining).toBeNull(); // not asked to remove it, so not reported
  }, 30_000);

  it('closes a dialog the cleanup left with Escape or a "No thanks" button', async () => {
    for (const path of ['/escape-popup', '/no-thanks-popup']) {
      const { info, visible } = await shoot(path);
      expect(visible).not.toContain('pop');
      expect(info.overlayRemaining).toBeNull();
    }
  }, 30_000);

  it('keeps a site\'s own pinned header and menu, sign-up words and all', async () => {
    const { image, info, visible } = await shoot('/headers', { format: 'png' }, { blocker });
    expect(info.removed).toBe(0);
    expect(info.overlayRemaining).toBeNull();
    expect(visible).toEqual(expect.arrayContaining(['top', 'nav']));
    const shot = readPng(image);
    expect(shot.pixel(5, 5)).toEqual([0, 160, 0]);
    expect(shot.pixel(5, 110)).toEqual([0, 0, 160]);
  }, 30_000);

  it('adds styles, clicks and runs scripts before the shot', async () => {
    const styled = readPng((await shoot('/plain', { styles: '#box { background: rgb(0,0,200) !important }' })).image);
    expect(styled.pixel(20, 20)).toEqual([0, 0, 200]);
    const clicked = readPng((await shoot('/plain', { click: '#go' })).image);
    expect(clicked.pixel(20, 20)).toEqual([200, 0, 0]);
    const scripted = await shoot('/plain', { scripts: "await new Promise((r) => setTimeout(r, 50)); document.getElementById('box').style.background = 'rgb(0,200,0)'" });
    expect(readPng(scripted.image).pixel(20, 20)).toEqual([0, 200, 0]);
  }, 30_000);

  it('says so when a click target is missing or a script throws', async () => {
    const missing = await shoot('/plain', { click: '#nope' }).catch((err: CaptureError) => err);
    expect(missing).toMatchObject({ code: 'selector_not_found' });
    const thrown = await shoot('/plain', { scripts: 'throw new Error("boom")' }).catch((err: CaptureError) => err);
    expect(thrown).toMatchObject({ code: 'script_error' });
    expect((thrown as CaptureError).message).toMatch(/boom/);
  }, 30_000);

  it('sends headers to the page\'s own site only, and sets cookies', async () => {
    seen.clear();
    await shoot('/ads', { headers: 'X-Test: yes', cookies: 'session=abc' }, { resolve: allPublic });
    expect(seen.get('site.example.com/ads')).toMatchObject({ 'x-test': 'yes', cookie: 'session=abc' });
    expect(seen.get('ads.example.net/ad.svg')).toBeDefined();
    expect(seen.get('ads.example.net/ad.svg')!['x-test']).toBeUndefined();
  }, 30_000);

  it('sets the user agent, language and time zone', async () => {
    seen.clear();
    const report = "document.title = [navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.userAgent].join('|')";
    const { info } = await shoot('/plain', {
      user_agent: 'TestAgent/1.0', accept_language: 'de-DE,de;q=0.9', time_zone: 'Asia/Tokyo', scripts: report,
    });
    expect(info.metadata?.title).toBe('de-DE|Asia/Tokyo|TestAgent/1.0');
    expect(seen.get('site.example.com/plain')).toMatchObject({ 'user-agent': 'TestAgent/1.0', 'accept-language': 'de-DE,de;q=0.9' });
  }, 30_000);

  it('takes a device preset\'s size and user agent', async () => {
    seen.clear();
    const { image } = await shoot('/plain', { viewport_device: 'iphone_13' });
    const png = readPng(image);
    expect([png.width, png.height]).toEqual([390 * 3, 844 * 3]);
    expect(seen.get('site.example.com/plain')?.['user-agent']).toMatch(/iPhone/);
  }, 30_000);

  it('blocks the requests and kinds of request it is told to', async () => {
    hits = [];
    await shoot('/ads', { block_requests: 'ads.example.net', block_resources: 'script' }, { resolve: allPublic });
    expect(hits).toContain('site.example.com/ads');
    expect(hits).not.toContain('ads.example.net/ad.svg');
    expect(hits).not.toContain('tracker.example.org/t.js');
    hits = [];
    await shoot('/ads', { block_requests: '*/t.js' }, { resolve: allPublic });
    expect(hits).toContain('ads.example.net/ad.svg');
    expect(hits).not.toContain('tracker.example.org/t.js');
  }, 30_000);

  it('renders given html, still guarding what it loads', async () => {
    hits = [];
    const context = await browser.createBrowserContext();
    try {
      const html = `<body style="margin:0;background:rgb(0,120,0)"><img src="http://site.example.com:${port}/img/1.svg">` +
        `<img src="http://127.0.0.1:${port}/img/2.svg"></body>`;
      const result = await capture(await context.newPage(), parseOptions({ html, timeout: 15 }), { resolve });
      expect(readPng(result.image).pixel(600, 600)).toEqual([0, 120, 0]);
      expect(hits).toContain('site.example.com/img/1.svg');
      expect(hits).not.toContain('127.0.0.1/img/2.svg');
    } finally {
      await context.close();
    }
  }, 30_000);

  it('makes a PDF on paper or as one long page', async () => {
    const paper = await shoot('/plain', { format: 'pdf', pdf_paper_format: 'a4' });
    expect(paper.contentType).toBe('application/pdf');
    expect(Buffer.from(paper.image.subarray(0, 5)).toString()).toBe('%PDF-');
    const one = await shoot('/tall', { format: 'pdf', pdf_fit_one_page: true });
    const text = Buffer.from(one.image).toString('latin1');
    expect(text.match(/\/Type\s*\/Page[^s]/g)).toHaveLength(1);
    expect(one.info.pageHeight).toBe(TALL_BANDS * 1000);
  }, 30_000);

  it('clips a part of the page, also below the window', async () => {
    const { image } = await shoot('/tall', { clip_x: 10, clip_y: 2500, clip_width: 100, clip_height: 50 });
    const png = readPng(image);
    expect([png.width, png.height]).toEqual([100, 50]);
    expect(png.pixel(50, 25)).toEqual([...bandColour(2)]);
  }, 30_000);

  it('reads the page\'s title, description, Open Graph tags and icon', async () => {
    const { info, image } = await shoot('/meta', { response_type: 'metadata' });
    expect(image.byteLength).toBe(0);
    expect(info.metadata).toMatchObject({
      title: 'Meta page',
      description: 'A page about tests.',
      openGraph: { title: 'Shared title', image: 'http://site.example.com/og.png' },
      icon: `http://site.example.com:${port}/icon.png`,
    });
    expect(info.pageHeight).toBeGreaterThan(0);
  }, 30_000);

  it('reports a blank page', async () => {
    expect((await failure('/blank')).code).toBe('blank');
  }, 30_000);

  it('reports a bot challenge', async () => {
    expect(await failure('/challenge')).toMatchObject({ code: 'blocked', reason: 'bot_check' });
  }, 30_000);

  it('reports a server error page', async () => {
    expect(await failure('/down')).toMatchObject({ code: 'error_page', reason: 'http_503' });
  }, 30_000);
});
