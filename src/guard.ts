// SSRF guard: decides whether the browser may load a URL. A screenshot API
// fetches whatever URL it is given, so without this anyone could point it at
// localhost, a cloud metadata endpoint or a private network. Every request the
// page makes (the first URL, each redirect, every image and script) passes
// through `checkUrl`, and through `checkHost` when a DNS resolver is available.

/** Schemes that never touch the network, so they are always safe. */
const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'about:']);
const WEB_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

const BLOCKED_NAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa', '.corp', '.private'];

/** IPv4 ranges that are not the public internet (RFC 6890 and friends). */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

/** IPv6 ranges that are not the public internet. IPv4-mapped and NAT64 addresses are checked as IPv4. */
const BLOCKED_V6: Array<[string, number]> = [
  ['::', 96], // unspecified, loopback, IPv4-compatible
  ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
];

export type Verdict = { ok: true } | { ok: false; reason: string; unresolved?: boolean };

const OK: Verdict = { ok: true };
const deny = (reason: string): Verdict => ({ ok: false, reason });
const unresolved = (host: string): Verdict => ({ ok: false, reason: `could not resolve ${host}`, unresolved: true });

/**
 * Parses an IPv4 address the way the URL standard, and so the browser, reads
 * one: one to four parts, each decimal, hex (0x7f) or octal (017), the last
 * part filling the bytes left. So 0x7f.1 and 017700000001 are both 127.0.0.1.
 */
function parseIPv4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length > 1 && parts.at(-1) === '') parts.pop();
  if (parts.length > 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(part)) n = part.length === 2 ? 0 : parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) n = parseInt(part.slice(1), 8);
    else if (/^(0|[1-9]\d*)$/.test(part)) n = Number(part);
    else return null;
    numbers.push(n);
  }
  const last = numbers.pop()!;
  if (numbers.some((n) => n > 255) || last >= 256 ** (4 - numbers.length)) return null;
  const bytes = [...numbers];
  for (let i = 3 - numbers.length; i >= 0; i--) bytes.push(Math.floor(last / 256 ** i) % 256);
  return bytes;
}

/** Strict dotted decimal, no leading zeros: the only form allowed inside an IPv6 address. */
function parseDottedQuad(s: string): number[] | null {
  const byte = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
  return new RegExp(`^${byte}\\.${byte}\\.${byte}\\.${byte}$`).test(s) ? s.split('.').map(Number) : null;
}

/** Parses an IPv6 address (with optional brackets, zone id or trailing dotted IPv4) into 16 bytes. */
export function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!s.includes(':')) return null;
  // A trailing dotted IPv4 part (::ffff:1.2.3.4) stands for the last two groups.
  let tail: number[] | null = null;
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    tail = parseDottedQuad(dotted[2]!);
    if (!tail) return null;
    s = `${dotted[1]}0:0`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array<string>(fill).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tail) bytes.splice(12, 4, ...tail);
  return bytes;
}

function inRange(bytes: number[], base: number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3;
    const mask = 0x80 >> (i & 7);
    if ((bytes[byte]! & mask) !== (base[byte]! & mask)) return false;
  }
  return true;
}

const V4_RANGES = BLOCKED_V4.map(([ip, bits]) => [parseIPv4(ip)!, bits] as const);
const V6_RANGES = BLOCKED_V6.map(([ip, bits]) => [parseIPv6(ip)!, bits] as const);

/** True when the address is on the public internet. Anything that does not parse is not. */
export function isPublicIp(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return !V4_RANGES.some(([base, bits]) => inRange(v4, base, bits));
  const v6 = parseIPv6(address);
  if (!v6) return false;
  const embeddedV4 = (prefix: string) => inRange(v6, parseIPv6(prefix)!, 96);
  if (embeddedV4('::ffff:0:0') || embeddedV4('64:ff9b::')) {
    return isPublicIp(v6.slice(12).join('.'));
  }
  return !V6_RANGES.some(([base, bits]) => inRange(v6, base, bits));
}

export function isIpLiteral(host: string): boolean {
  return parseIPv4(host) !== null || parseIPv6(host) !== null;
}

/** Checks a host name or IP literal without DNS. */
export function checkHostName(rawHost: string): Verdict {
  const host = rawHost.toLowerCase().replace(/\.$/, '');
  if (!host) return deny('empty host');
  if (isIpLiteral(host)) return isPublicIp(host) ? OK : deny(`private address ${host}`);
  // The URL standard reads a host whose last label is a number as an IPv4
  // address, and refuses it when that fails (08.8.8.8, 1.2.3.256).
  if (/^(0x[0-9a-f]*|\d+)$/i.test(host.split('.').at(-1)!)) return deny(`invalid IPv4 address ${host}`);
  if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return deny(`local name ${host}`);
  // A name without a dot is resolved through local search domains, so it can reach internal hosts.
  if (!host.includes('.')) return deny(`single-label name ${host}`);
  return OK;
}

/** Checks a URL's scheme and host without DNS. Used on every request the page makes. */
export function checkUrl(url: string): Verdict {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return deny('invalid URL');
  }
  if (LOCAL_SCHEMES.has(u.protocol)) return OK;
  if (!WEB_SCHEMES.has(u.protocol)) return deny(`scheme ${u.protocol} is not allowed`);
  return checkHostName(u.hostname);
}

/** Looks up the addresses of a host name. Each runtime supplies its own. */
export type Resolver = (host: string) => Promise<string[]>;

/**
 * Checks a host after DNS: every address it resolves to must be public, so a
 * public-looking name that points at 127.0.0.1 is refused. Fails closed when
 * the lookup itself fails.
 */
export async function checkHost(host: string, resolve: Resolver): Promise<Verdict> {
  const named = checkHostName(host);
  if (!named.ok || isIpLiteral(host)) return named;
  let addresses: string[];
  try {
    addresses = await resolve(host.replace(/\.$/, ''));
  } catch {
    return unresolved(host);
  }
  if (addresses.length === 0) return unresolved(host);
  const bad = addresses.find((a) => !isPublicIp(a));
  return bad ? deny(`${host} resolves to private address ${bad}`) : OK;
}

/** Caches lookups for the length of one capture, so a page with 200 images costs one lookup per host. */
export function cachedHostCheck(resolve: Resolver): (host: string) => Promise<Verdict> {
  const cache = new Map<string, Promise<Verdict>>();
  return (host) => {
    const key = host.toLowerCase();
    let hit = cache.get(key);
    if (!hit) {
      hit = checkHost(key, resolve);
      cache.set(key, hit);
    }
    return hit;
  };
}
