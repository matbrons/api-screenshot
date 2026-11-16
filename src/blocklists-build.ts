// Fetches the public filter lists and cuts them down to what blocklists.ts
// matches: hosts and CSS selectors. Lines are parsed with Ghostery's adblocker
// (MPL-2.0), which reads EasyList syntax the way ad blockers do.
// https://github.com/ghostery/adblocker
//
// Runs in Node only: when the Worker is built (scripts/blocklists.ts) and when
// the server starts. The lists are GPL or Creative Commons, so they are always
// fetched from their own homes and never stored in this repository.

import { parseFilters } from '@ghostery/adblocker';
import { fetch as undiciFetch } from 'undici';
import { emptyListSet, type Blocklists, type ListKind, type ListSet } from './blocklists.ts';

interface ListSource {
  kind: ListKind;
  name: string;
  url: string;
}

const LIST_SOURCES: ListSource[] = [
  { kind: 'ads', name: 'EasyList', url: 'https://easylist.to/easylist/easylist.txt' },
  { kind: 'trackers', name: 'EasyPrivacy', url: 'https://easylist.to/easylist/easyprivacy.txt' },
  { kind: 'cookies', name: 'EasyList Cookie List', url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt' },
];

/**
 * Drops lines inside "!#if ... !#endif" blocks. Those are meant for one ad
 * blocker or browser, and are often a different version of a rule nearby.
 */
function withoutConditionals(text: string): string {
  let depth = 0;
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('!#if')) depth++;
    else if (t.startsWith('!#endif')) depth = Math.max(0, depth - 1);
    else if (depth === 0) kept.push(line);
  }
  return kept.join('\n');
}

/** The host names before "##" or "#@#": the ones it applies to, and the ones it skips ("~host"). */
function ruleHosts(rawLine: string): { on: string[]; off: string[] } {
  const prefix = rawLine.slice(0, rawLine.search(/#@?#/)).trim();
  const hosts = prefix ? prefix.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean) : [];
  return {
    on: hosts.filter((h) => !h.startsWith('~')),
    off: hosts.filter((h) => h.startsWith('~')).map((h) => h.slice(1)),
  };
}

/**
 * Turns one filter list into a ListSet. Network rules are kept when they name
 * a whole host ("||ads.example^") and apply to every kind of request, at most
 * limited to third-party use; cosmetic rules when they are plain CSS.
 * With `network: false` only the cosmetic part is kept.
 */
export function compileList(text: string, { network = true } = {}): ListSet {
  const out = emptyListSet();
  const { networkFilters, cosmeticFilters } = parseFilters(withoutConditionals(text), {
    debug: true, // keeps each rule's own line, which holds the host names
    loadExtendedSelectors: false,
    loadNetworkFilters: network,
  });

  for (const f of networkFilters) {
    const whole = f.isHostnameAnchor() && f.isRightAnchor() && !f.hasFilter() && !f.isRegex();
    if (!whole || !f.fromAny() || f.hasDomains() || f.isRedirect() || f.isCSP() || f.isRemoveParam() ||
      f.isReplace() || f.isHtmlFilteringRule() || f.isBadFilter()) continue;
    const host = f.getHostname().toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(host)) continue;
    if (f.isException()) out.allow.push(host);
    else if (f.firstParty() && f.thirdParty()) out.block.push(host);
    else if (f.thirdParty()) out.blockThirdParty.push(host);
  }

  const add = (map: Record<string, string[]>, host: string, selector: string) => (map[host] ??= []).push(selector);
  const generic = new Set<string>();
  const unhidden = new Set<string>();
  for (const f of cosmeticFilters) {
    if (f.isScriptInject() || f.isExtended() || f.isHtmlFiltering() || f.hasCustomStyle() || f.isRemove()) continue;
    const selector = f.getSelector();
    const { on, off } = ruleHosts(f.rawLine ?? '');
    if (f.isUnhide()) {
      if (!on.length) unhidden.add(selector);
      for (const h of on) add(out.showOn, h, selector);
      continue;
    }
    if (on.length) for (const h of on) add(out.hideOn, h, selector);
    else generic.add(selector);
    for (const h of off) add(out.showOn, h, selector);
  }
  out.hide = [...generic].filter((s) => !unhidden.has(s));
  return out;
}

/** Count of rules in a ListSet, for the log. */
export function ruleCount(set: ListSet): number {
  const sum = (m: Record<string, string[]>) => Object.values(m).reduce((n, v) => n + v.length, 0);
  return set.block.length + set.blockThirdParty.length + set.allow.length + set.hide.length + sum(set.hideOn) + sum(set.showOn);
}

interface FetchResult {
  lists: Blocklists;
  /** One line per list that could not be used. Its part stays empty; the built-in floor still applies. */
  problems: string[];
}

type FetchLike = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Downloads one list, trying again after a network error, a timeout or a 5xx
 * or 429 answer. A 404 fails at once.
 */
async function download(
  url: string,
  { timeoutMs, retries, retryDelayMs, fetchImpl }: { timeoutMs: number; retries: number; retryDelayMs: number; fetchImpl: FetchLike },
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    let retryable = true;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        retryable = res.status >= 500 || res.status === 429;
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.text();
    } catch (err) {
      if (!retryable || attempt > retries) {
        throw attempt > 1 ? new Error(`${(err as Error).message} (after ${attempt} tries)`) : err;
      }
      await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
    }
  }
}

/**
 * Fetches and compiles every list. A list that fails (network, HTTP error,
 * not a filter list) is left empty and named in `problems`; the others are
 * still used.
 *
 * Every download finishes before the first list is compiled: compiling holds
 * the event loop, and a download whose last bytes and close arrive meanwhile
 * crashes the HTTP client built into Node 22 and 24 (nodejs/undici#5360). The
 * undici package, where that is fixed, does the fetching for the same reason.
 */
export async function fetchBlocklists(
  sources: ListSource[] = LIST_SOURCES,
  {
    timeoutMs = 30_000,
    retries = 2,
    retryDelayMs = 2_000,
    fetchImpl = undiciFetch as FetchLike,
  }: { timeoutMs?: number; retries?: number; retryDelayMs?: number; fetchImpl?: FetchLike } = {},
): Promise<FetchResult> {
  const lists: Blocklists = { ads: emptyListSet(), trackers: emptyListSet(), cookies: emptyListSet(), source: '' };
  const problems: string[] = [];
  const loaded: string[] = [];
  const downloads = await Promise.allSettled(
    sources.map((source) => download(source.url, { timeoutMs, retries, retryDelayMs, fetchImpl })),
  );
  sources.forEach((source, i) => {
    try {
      const result = downloads[i]!;
      if (result.status === 'rejected') throw result.reason;
      const text = result.value;
      if (!/^\s*(\[Adblock|!)/.test(text)) throw new Error('not a filter list');
      const set = compileList(text, { network: source.kind !== 'cookies' });
      if (ruleCount(set) < 10) throw new Error('almost no usable rules');
      lists[source.kind] = set;
      const modified = /^!\s*Last modified:\s*(.{6,30}?)\s*$/m.exec(text)?.[1];
      loaded.push(`${source.name}${modified ? ` (${modified})` : ''}`);
    } catch (err) {
      problems.push(`${source.name} could not be loaded from ${source.url}: ${(err as Error).message}`);
    }
  });
  lists.source = loaded.length ? loaded.sort().join(', ') : 'built-in list only';
  return { lists, problems };
}

/**
 * Source of the generated module the Worker imports. The data is one JSON
 * string: parsing JSON is faster than parsing the same data as code.
 */
export function blocklistsModule(lists: Blocklists | null): string {
  const head =
    '// Generated by scripts/blocklists.ts from public filter lists when the Worker is built.\n' +
    '// The lists keep their own licences: do not edit or commit this file.\n' +
    "import type { Blocklists } from '../blocklists.ts';\n\n";
  if (!lists) return `${head}const lists: Blocklists | null = null;\nexport default lists;\n`;
  // A "/*!" comment is kept by the bundler, so the notice stays in the built Worker.
  const notice =
    '/*! Host names and CSS selectors from EasyList, EasyPrivacy and the EasyList Cookie List,\n' +
    ' * by The EasyList authors (https://easylist.to/). EasyList and EasyPrivacy: GPL 3.0 or later, or\n' +
    ' * CC BY-SA 3.0 or later. Cookie List: CC BY 3.0. See https://easylist.to/pages/licence.html */\n';
  const data = `JSON.parse(${JSON.stringify(JSON.stringify(lists))})`;
  return `${head}${notice}const lists: Blocklists | null = ${data};\nexport default lists;\n`;
}
