import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlocker, emptyListSet, type Blocklists } from '../src/blocklists.ts';
import { blocklistsModule, compileList, fetchBlocklists, ruleCount } from '../src/blocklists-build.ts';

const SAMPLE = `[Adblock Plus 2.0]
! Title: Sample list
! Last modified: 15 Nov 2026 12:00 UTC
||ads.example.net^
||tracker.example.org^$third-party
@@||ok.ads.example.net^
||scripts.example.net^$script
||page.example.net^$document
||only-on.example.net^$domain=example.com
||path.example.net/banner/
/generic-path/*
!#if env_firefox
||firefox-only.example.net^
!#endif
##.ad-slot
##.sponsored-box
example.com##.site-ad
~news.example.com##.sponsored-box
google.*##.top-ad
#@#.ad-slot
shop.example.com#@#.sponsored-box
##.promo:has-text(Sale)
example.com##+js(set-constant, foo, true)
`;

const sampleLists = (): Blocklists => ({
  ads: compileList(SAMPLE),
  trackers: emptyListSet(),
  cookies: emptyListSet(),
  source: 'sample',
});

describe('compileList', () => {
  const set = compileList(SAMPLE);

  it('keeps rules that block a whole host', () => {
    expect(set.block).toEqual(['ads.example.net']);
    expect(set.blockThirdParty).toEqual(['tracker.example.org']);
    expect(set.allow).toEqual(['ok.ads.example.net']);
  });

  it('leaves out rules limited to a request type, a site or a path, and browser-only blocks', () => {
    const hosts = [...set.block, ...set.blockThirdParty, ...set.allow];
    for (const h of ['scripts.example.net', 'page.example.net', 'only-on.example.net', 'path.example.net', 'firefox-only.example.net']) {
      expect(hosts).not.toContain(h);
    }
  });

  it('sorts hiding rules into every site, one site, and exceptions', () => {
    expect(set.hide).toEqual(['.sponsored-box']); // .ad-slot is undone by "#@#.ad-slot"
    expect(set.hideOn['example.com']).toEqual(['.site-ad']);
    expect(set.hideOn['google.*']).toEqual(['.top-ad']);
    expect(set.showOn['news.example.com']).toEqual(['.sponsored-box']);
    expect(set.showOn['shop.example.com']).toEqual(['.sponsored-box']);
  });

  it('leaves out rules a browser cannot apply as plain CSS', () => {
    const all = [...set.hide, ...Object.values(set.hideOn).flat()];
    expect(all.some((s) => s.includes('has-text') || s.includes('set-constant'))).toBe(false);
  });

  it('keeps only the hiding rules when asked', () => {
    const cosmetic = compileList(SAMPLE, { network: false });
    expect(cosmetic.block).toEqual([]);
    expect(cosmetic.hide).toEqual(['.sponsored-box']);
  });
});

describe('createBlocker', () => {
  const blocker = createBlocker(sampleLists());

  it('blocks a listed host and its subdomains', () => {
    expect(blocker.blocks('ads.example.net', 'example.com', ['ads'])).toBe(true);
    expect(blocker.blocks('cdn.ads.example.net', 'example.com', ['ads'])).toBe(true);
    expect(blocker.blocks('example.net', 'example.com', ['ads'])).toBe(false);
  });

  it('lets exceptions through', () => {
    expect(blocker.blocks('ok.ads.example.net', 'example.com', ['ads'])).toBe(false);
  });

  it('blocks a third-party host only on other sites', () => {
    expect(blocker.blocks('tracker.example.org', 'example.com', ['ads'])).toBe(true);
    expect(blocker.blocks('tracker.example.org', 'tracker.example.org', ['ads'])).toBe(false);
    expect(blocker.blocks('tracker.example.org', 'www.tracker.example.org', ['ads'])).toBe(false);
  });

  it('only checks the kinds asked for', () => {
    expect(blocker.blocks('ads.example.net', 'example.com', ['trackers'])).toBe(false);
  });

  it('keeps a built-in list when the lists could not be fetched', () => {
    const floor = createBlocker(null);
    expect(floor.source).toBe('built-in list only');
    expect(floor.blocks('securepubads.g.doubleclick.net', 'example.com', ['ads'])).toBe(true);
    expect(floor.blocks('www.google-analytics.com', 'example.com', ['trackers'])).toBe(true);
    expect(floor.blocks('example.org', 'example.com', ['ads', 'trackers'])).toBe(false);
    expect(blocker.blocks('securepubads.g.doubleclick.net', 'example.com', ['ads'])).toBe(true);
  });

  it('gives the selectors for a site', () => {
    expect(blocker.selectors('www.example.com', 'ads')).toEqual(['.sponsored-box', '.site-ad']);
    expect(blocker.selectors('news.example.com', 'ads')).toEqual(['.site-ad']);
    expect(blocker.selectors('www.google.de', 'ads')).toEqual(['.sponsored-box', '.top-ad']);
    expect(blocker.selectors('example.org', 'ads')).toEqual(['.sponsored-box']);
    expect(blocker.selectors('example.org', 'cookies')).toEqual([]);
  });

  it('sends only the selectors the page\'s classes and ids can match', () => {
    const lists = sampleLists();
    lists.ads.hide = ['.banner-ad', '#top-ad', '.ad\\:wide', '[data-ad-slot]', 'AD-SLOT'];
    const b = createBlocker(lists);
    expect(b.selectors('example.org', 'ads', ['.banner-ad', '.content'])).toEqual(['.ad\\:wide', '[data-ad-slot]', 'AD-SLOT', '.banner-ad']);
    expect(b.selectors('example.org', 'ads', ['#top-ad'])).toEqual(['.ad\\:wide', '[data-ad-slot]', 'AD-SLOT', '#top-ad']);
    expect(b.selectors('example.com', 'ads', [])).toEqual(['.ad\\:wide', '[data-ad-slot]', 'AD-SLOT', '.site-ad']);
  });
});

describe('fetchBlocklists', () => {
  // A list with almost no usable rules is taken for a broken download.
  const FULL = SAMPLE + Array.from({ length: 10 }, (_, i) => `||more-${i}.example.net^\n##.more-${i}`).join('\n');
  let server: http.Server;
  let base = '';
  let flakyHits = 0;
  let missingHits = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/list.txt') return void res.writeHead(200).end(FULL);
      if (req.url === '/flaky.txt') return void (++flakyHits < 3 ? res.writeHead(503).end() : res.writeHead(200).end(FULL));
      if (req.url === '/missing.txt') missingHits++;
      if (req.url === '/short.txt') return void res.writeHead(200).end(SAMPLE);
      if (req.url === '/page.html') return void res.writeHead(200).end('<!doctype html><p>Not a list</p>');
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  });
  afterAll(() => void server.close());

  it('loads the lists that answer and names the ones that do not', async () => {
    const { lists, problems } = await fetchBlocklists([
      { kind: 'ads', name: 'Ads', url: `${base}/list.txt` },
      { kind: 'trackers', name: 'Trackers', url: `${base}/missing.txt` },
      { kind: 'cookies', name: 'Cookies', url: `${base}/page.html` },
    ]);
    expect(lists.ads.block).toContain('ads.example.net');
    expect(lists.ads.block).toHaveLength(11);
    expect(ruleCount(lists.trackers)).toBe(0);
    expect(ruleCount(lists.cookies)).toBe(0);
    expect(lists.source).toBe('Ads (15 Nov 2026 12:00 UTC)');
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toMatch(/Trackers .*HTTP 404/);
    expect(problems.join('\n')).toMatch(/Cookies .*not a filter list/);
  });

  it('refuses a list with almost no rules', async () => {
    const { problems } = await fetchBlocklists([{ kind: 'ads', name: 'Ads', url: `${base}/short.txt` }]);
    expect(problems.join('\n')).toMatch(/almost no usable rules/);
  });

  it('tries a failing server again, but not a missing list', async () => {
    flakyHits = 0;
    missingHits = 0;
    const { lists, problems } = await fetchBlocklists([
      { kind: 'ads', name: 'Ads', url: `${base}/flaky.txt` },
      { kind: 'trackers', name: 'Trackers', url: `${base}/missing.txt` },
    ], { retryDelayMs: 0 });
    expect(flakyHits).toBe(3);
    expect(lists.ads.block).toHaveLength(11);
    expect(missingHits).toBe(1);
    expect(problems).toEqual([`Trackers could not be loaded from ${base}/missing.txt: HTTP 404`]);
  });

  it('names a list that keeps failing', async () => {
    flakyHits = -10;
    const { problems } = await fetchBlocklists([{ kind: 'ads', name: 'Ads', url: `${base}/flaky.txt` }], { retryDelayMs: 0 });
    expect(problems.join('\n')).toMatch(/Ads .*HTTP 503 \(after 3 tries\)/);
  });

  it('uses only the hiding rules of the cookie list', async () => {
    const { lists } = await fetchBlocklists([{ kind: 'cookies', name: 'Cookies', url: `${base}/list.txt` }]);
    expect(lists.cookies.block).toEqual([]);
    expect(lists.cookies.hide).toContain('.sponsored-box');
    expect(lists.cookies.hide).toHaveLength(11);
  });
});

describe('the Worker build', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'blocklists-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a module that gives the lists back', async () => {
    const lists = sampleLists();
    for (const [name, data] of [['with.ts', lists], ['without.ts', null]] as const) {
      writeFileSync(path.join(dir, name), blocklistsModule(data));
    }
    expect((await import(pathToFileURL(path.join(dir, 'with.ts')).href)).default).toEqual(lists);
    expect((await import(pathToFileURL(path.join(dir, 'without.ts')).href)).default).toBeNull();
  });

  // wrangler builds with esbuild in the same way; this catches a Worker that
  // no longer bundles, or one that pulls the list parser in with it.
  it('bundles the Worker without the list parser', async () => {
    const result = await build({
      entryPoints: [path.join(import.meta.dirname, '..', 'src', 'worker.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'browser'],
      mainFields: ['browser', 'module', 'main'],
      external: ['cloudflare:*', 'node:*'],
      loader: { '.json': 'json' },
      logLevel: 'silent',
    });
    const code = result.outputFiles[0]!.text;
    expect(code).toContain('x-overlay-remaining');
    expect(code).not.toMatch(/parseFilters|@ghostery/);
    expect(code).toMatch(/\/\*! @duckduckgo\/autoconsent [\d.]+, Copyright DuckDuckGo[\s\S]*?Mozilla Public License/);
  }, 60_000);

  it('keeps the lists\' licence notice with the data', () => {
    expect(blocklistsModule(sampleLists())).toMatch(/\/\*! [\s\S]*The EasyList authors[\s\S]*\*\//);
    expect(blocklistsModule(null)).not.toContain('/*!');
  });
});
