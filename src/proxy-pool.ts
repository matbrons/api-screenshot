// The operator's list of proxies (PROXY_URLS). Each shot takes the next one in
// turn. A proxy that fails is rested for a while, longer each time it fails
// again, so a dead proxy isn't tried on every request. A page that comes back
// blocked doesn't rest a proxy: its address may still be fine for other sites.

import type { ProxySettings } from './proxy.ts';

/** How long a proxy rests after its first failure; each failure after that doubles it. */
export const FIRST_REST_MS = 30_000;
export const LONGEST_REST_MS = 10 * 60_000;

interface Entry {
  proxy: ProxySettings;
  failures: number;
  restUntil: number;
}

export class ProxyPool {
  readonly #entries: Entry[];
  readonly #now: () => number;
  #cursor = 0;

  constructor(proxies: ProxySettings[], now: () => number = Date.now) {
    if (proxies.length === 0) throw new Error('A proxy pool needs at least one proxy.');
    this.#entries = proxies.map((proxy) => ({ proxy, failures: 0, restUntil: 0 }));
    this.#now = now;
  }

  get size(): number {
    return this.#entries.length;
  }

  /**
   * The proxy for the next attempt: the next one in turn that is not resting
   * and not in `tried`. Failing that, a working one already tried; failing
   * that, the one whose rest ends first, so the server keeps trying rather
   * than refusing every shot while all proxies rest.
   */
  pick(tried: ReadonlySet<ProxySettings> = new Set()): ProxySettings {
    const now = this.#now();
    const n = this.#entries.length;
    const inTurn = Array.from({ length: n }, (_, i) => this.#entries[(this.#cursor + i) % n]!);
    const working = inTurn.filter((e) => e.restUntil <= now);
    const chosen =
      working.find((e) => !tried.has(e.proxy)) ??
      working[0] ??
      inTurn.reduce((soonest, e) => (e.restUntil < soonest.restUntil ? e : soonest));
    this.#cursor = (this.#entries.indexOf(chosen) + 1) % n;
    return chosen.proxy;
  }

  /** Whether a working proxy is left that is not in `tried`. */
  hasUntried(tried: ReadonlySet<ProxySettings>): boolean {
    const now = this.#now();
    return this.#entries.some((e) => e.restUntil <= now && !tried.has(e.proxy));
  }

  /** The proxy failed (refused, unreachable, wrong login). Returns how long it rests, in ms. */
  failed(proxy: ProxySettings): number {
    const entry = this.#find(proxy);
    if (!entry) return 0;
    entry.failures++;
    const rest = Math.min(LONGEST_REST_MS, FIRST_REST_MS * 2 ** (entry.failures - 1));
    entry.restUntil = this.#now() + rest;
    return rest;
  }

  /** The proxy carried a shot, whatever the site answered. */
  worked(proxy: ProxySettings): void {
    const entry = this.#find(proxy);
    if (entry) {
      entry.failures = 0;
      entry.restUntil = 0;
    }
  }

  #find(proxy: ProxySettings): Entry | undefined {
    return this.#entries.find((e) => e.proxy === proxy);
  }
}
