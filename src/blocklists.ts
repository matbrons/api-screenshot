// Ad and tracker blocking, and cookie-banner hiding, from public filter lists
// (EasyList, EasyPrivacy and the EasyList Cookie List). The lists are fetched
// when the service is built or started, never kept in this repository; see
// blocklists-build.ts. This file only matches against them, so it runs the
// same in a Cloudflare Worker and in Node.
//
// The lists are cut down to what a screenshot needs and can match cheaply:
//   - hosts to block, with their subdomains (most of EasyList and EasyPrivacy)
//   - CSS selectors to hide, on every site or on one site
// Rules that need a full filtering engine (URL paths, request types, scripts
// injected into the page) are left out.

export type ListKind = 'ads' | 'trackers' | 'cookies';

export interface ListSet {
  /** Hosts whose requests are blocked, subdomains included. */
  block: string[];
  /** Hosts blocked only when a page on another site loads them. */
  blockThirdParty: string[];
  /** Hosts never blocked: the list's own exceptions. */
  allow: string[];
  /** CSS selectors hidden on every site. */
  hide: string[];
  /** CSS selectors hidden on one site. Keys are host names, or "name.*" for every top-level domain. */
  hideOn: Record<string, string[]>;
  /** CSS selectors that stay visible on one site, overriding `hide` and `hideOn`. */
  showOn: Record<string, string[]>;
}

export type Blocklists = Record<ListKind, ListSet> & {
  /** Which lists were loaded and how recent they are, for the log. */
  source: string;
};

/**
 * The floor: a few ad and tracker hosts that are blocked even when the lists
 * could not be fetched. The cookie-banner and ad-slot selectors that go with
 * them are in page-scripts.ts.
 */
const BUILT_IN_HOSTS: Partial<Record<ListKind, string[]>> = {
  ads: [
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com', 'amazon-adsystem.com',
    'taboola.com', 'outbrain.com', 'criteo.com', 'criteo.net', 'adnxs.com', 'pubmatic.com', 'rubiconproject.com',
    'moatads.com', 'adsrvr.org', 'casalemedia.com', 'openx.net', 'smartadserver.com', 'teads.tv', 'media.net',
  ],
  trackers: [
    'google-analytics.com', 'analytics.google.com', 'connect.facebook.net', 'static.hotjar.com', 'script.hotjar.com',
    'bat.bing.com', 'clarity.ms', 'cdn.segment.com', 'api.segment.io', 'snap.licdn.com', 'static.ads-twitter.com',
    'analytics.tiktok.com', 'sb.scorecardresearch.com', 'cdn.mxpnl.com', 'js.hs-analytics.net', 'cdn.heapanalytics.com',
  ],
};

export function emptyListSet(): ListSet {
  return { block: [], blockThirdParty: [], allow: [], hide: [], hideOn: {}, showOn: {} };
}

export interface Blocker {
  /** Whether a request to `host`, made by a page on `pageHost`, is blocked by any of these lists. */
  blocks(host: string, pageHost: string, kinds: ListKind[]): boolean;
  /**
   * CSS selectors to hide on a page at `host`. Given the classes and ids on
   * the page (".name", "#name", see pageTokens), the lists' thousands of
   * selectors for every site are cut down to those that can match there.
   */
  selectors(host: string, kind: ListKind, tokens?: string[]): string[];
  /** What was loaded, for the log. */
  source: string;
}

/** The host and each parent domain: a.b.example.com, b.example.com, example.com, com. */
function suffixes(host: string): string[] {
  const out = [host];
  for (let i = host.indexOf('.'); i !== -1; i = host.indexOf('.', i + 1)) out.push(host.slice(i + 1));
  return out;
}

/** Keys a site-specific rule may use for `host`: the host, its parents, and "name.*" forms. */
function siteKeys(host: string): string[] {
  const keys = suffixes(host);
  for (const s of keys.slice(0, -1)) {
    keys.push(s.replace(/\.[^.]+$/, '.*'));
    if (s.split('.').length > 2) keys.push(s.replace(/\.[^.]+\.[^.]+$/, '.*'));
  }
  return keys;
}

/** The class or id a selector needs on the page (".name" or "#name"), when it starts with one. */
function selectorKey(selector: string): string | null {
  return /^[.#][\w-]+(?![\w\\-])/.exec(selector)?.[0] ?? null;
}

/** Builds the matcher. With no lists, only the built-in floor applies. */
export function createBlocker(lists: Blocklists | null): Blocker {
  const kinds: ListKind[] = ['ads', 'trackers', 'cookies'];
  const sets = Object.fromEntries(
    kinds.map((kind) => {
      const list = lists?.[kind] ?? emptyListSet();
      const byKey = new Map<string, string[]>();
      const unkeyed: string[] = [];
      for (const selector of list.hide) {
        const key = selectorKey(selector);
        const group = key ? byKey.get(key) : unkeyed;
        if (group) group.push(selector);
        else byKey.set(key!, [selector]);
      }
      return [kind, {
        block: new Set([...list.block, ...(BUILT_IN_HOSTS[kind] ?? [])]),
        blockThirdParty: new Set(list.blockThirdParty),
        allow: new Set(list.allow),
        list,
        byKey,
        unkeyed,
      }];
    }),
  ) as Record<ListKind, {
    block: Set<string>; blockThirdParty: Set<string>; allow: Set<string>; list: ListSet;
    byKey: Map<string, string[]>; unkeyed: string[];
  }>;

  return {
    source: lists?.source ?? 'built-in list only',
    blocks(host, pageHost, wanted) {
      const names = suffixes(host.toLowerCase());
      for (const kind of wanted) {
        const s = sets[kind];
        if (names.some((n) => s.allow.has(n))) continue;
        if (names.some((n) => s.block.has(n))) return true;
        // Third-party only: a site may load its own domain, others may not.
        const own = names.find((n) => s.blockThirdParty.has(n));
        if (own && pageHost !== own && !pageHost.endsWith(`.${own}`)) return true;
      }
      return false;
    },
    selectors(host, kind, tokens) {
      const { list, byKey, unkeyed } = sets[kind];
      const keys = siteKeys(host.toLowerCase());
      const generic = tokens ? [...unkeyed, ...[...new Set(tokens)].flatMap((t) => byKey.get(t) ?? [])] : list.hide;
      const specific = keys.flatMap((k) => list.hideOn[k] ?? []);
      const shown = new Set(keys.flatMap((k) => list.showOn[k] ?? []));
      const all = specific.length ? [...generic, ...specific] : generic;
      return shown.size ? all.filter((s) => !shown.has(s)) : all;
    },
  };
}
