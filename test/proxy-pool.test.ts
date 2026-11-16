import { describe, expect, it } from 'vitest';
import { FIRST_REST_MS, LONGEST_REST_MS, ProxyPool } from '../src/proxy-pool.ts';
import { parseProxyList } from '../src/proxy.ts';

const [a, b, c] = parseProxyList('http://a.example.com:8080, http://b.example.com:8080 socks5://c.example.com');

function poolAt(start = 1_000_000) {
  let t = start;
  const pool = new ProxyPool([a!, b!, c!], () => t);
  return { pool, advance: (ms: number) => (t += ms) };
}

describe('ProxyPool', () => {
  it('takes the proxies in turn', () => {
    const { pool } = poolAt();
    expect([pool.pick(), pool.pick(), pool.pick(), pool.pick()]).toEqual([a, b, c, a]);
  });

  it('skips proxies already tried for this shot', () => {
    const { pool } = poolAt();
    const tried = new Set([a!]);
    expect(pool.pick(tried)).toBe(b);
    tried.add(b!);
    expect(pool.pick(tried)).toBe(c);
    tried.add(c!);
    expect(pool.hasUntried(tried)).toBe(false);
    // With every one tried, a retry reuses a working one rather than none.
    expect([a, b, c]).toContain(pool.pick(tried));
  });

  it('rests a failed proxy, longer each time, and skips it meanwhile', () => {
    const { pool, advance } = poolAt();
    expect(pool.failed(b!)).toBe(FIRST_REST_MS);
    expect([pool.pick(), pool.pick(), pool.pick()]).toEqual([a, c, a]);
    expect(pool.hasUntried(new Set([a!, c!]))).toBe(false);

    advance(FIRST_REST_MS);
    expect([pool.pick(), pool.pick()]).toEqual([b, c]);

    expect(pool.failed(b!)).toBe(FIRST_REST_MS * 2);
    expect(pool.failed(b!)).toBe(FIRST_REST_MS * 4);
    for (let i = 0; i < 20; i++) pool.failed(b!);
    expect(pool.failed(b!)).toBe(LONGEST_REST_MS);
  });

  it('forgets the failures of a proxy that works again', () => {
    const { pool, advance } = poolAt();
    pool.failed(a!);
    pool.failed(a!);
    advance(FIRST_REST_MS * 2);
    pool.worked(a!);
    expect(pool.failed(a!)).toBe(FIRST_REST_MS);
  });

  it('when all rest, tries the one due back first instead of refusing', () => {
    const { pool, advance } = poolAt();
    pool.failed(a!);
    pool.failed(a!); // 60 s
    pool.failed(b!); // 30 s
    advance(1000);
    pool.failed(c!); // 30 s, from a second later
    expect(pool.hasUntried(new Set())).toBe(false);
    expect(pool.pick()).toBe(b);
  });
});
