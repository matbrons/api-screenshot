// Your own proxy, for sites that only answer from certain networks or
// countries. Parsing and display only, so both runtimes can share it; the
// connections themselves are in upstream-proxy.ts (server only).
//
// A proxy URL often carries a password. It is kept only in memory: never in a
// log line, an error message or a response. describeProxy() is the one way to
// show a proxy, and it leaves the login out.

import { checkHostName } from './guard.ts';

type ProxyProtocol = 'http' | 'https' | 'socks5';

export interface ProxySettings {
  /** How we talk to the proxy itself: plain HTTP, HTTP over TLS, or SOCKS5. */
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

const DEFAULT_PORTS: Record<ProxyProtocol, number> = { http: 80, https: 443, socks5: 1080 };
const MAX_PROXY_URL_LENGTH = 500;

/** Why a proxy URL can't be used. The message never repeats the URL, so it can't leak a password. */
export class ProxyUrlError extends Error {}

/**
 * Parses "http://user:pass@host:port", "https://…" or "socks5://…". socks5h is
 * taken as socks5: either way the proxy is handed the address the guard checked.
 * User name and password may be percent-encoded.
 */
export function parseProxyUrl(input: string): ProxySettings {
  const text = input.trim();
  if (!text) throw new ProxyUrlError('is empty');
  if (text.length > MAX_PROXY_URL_LENGTH) throw new ProxyUrlError('is too long');
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new ProxyUrlError('is not a valid URL, for example http://user:pass@proxy.example.com:8080');
  }
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  const protocol: ProxyProtocol | undefined =
    scheme === 'http' || scheme === 'https' ? scheme : scheme === 'socks5' || scheme === 'socks5h' ? 'socks5' : undefined;
  if (!protocol) throw new ProxyUrlError('must start with http://, https:// or socks5://');
  if (!u.hostname) throw new ProxyUrlError('has no host');
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) {
    throw new ProxyUrlError('must be just scheme, login, host and port, with no path');
  }
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      throw new ProxyUrlError('has a user name or password that is not valid percent-encoding');
    }
  };
  const username = u.username ? decode(u.username) : undefined;
  const password = u.password ? decode(u.password) : undefined;
  if (protocol === 'socks5' && ((username?.length ?? 0) > 255 || (password?.length ?? 0) > 255)) {
    throw new ProxyUrlError('has a user name or password longer than SOCKS5 allows (255 bytes)');
  }
  return {
    protocol,
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: u.port ? Number(u.port) : DEFAULT_PORTS[protocol],
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

/** The most proxies PROXY_URLS takes. */
export const MAX_PROXIES = 100;

/**
 * Parses a list of proxy URLs, separated by commas, spaces or new lines. An
 * error names the entry by its place in the list, never by its text.
 */
export function parseProxyList(input: string): ProxySettings[] {
  const items = input.split(/[\s,]+/).filter(Boolean);
  if (items.length === 0) throw new ProxyUrlError('is empty');
  if (items.length > MAX_PROXIES) throw new ProxyUrlError(`has more than ${MAX_PROXIES} proxies`);
  return items.map((item, i) => {
    try {
      return parseProxyUrl(item);
    } catch (err) {
      if (err instanceof ProxyUrlError && items.length > 1) throw new ProxyUrlError(`entry ${i + 1} ${err.message}`);
      throw err;
    }
  });
}

/** The proxy as it may be shown or logged: scheme, host and port, never the login. */
export function describeProxy(p: ProxySettings): string {
  const host = p.host.includes(':') ? `[${p.host}]` : p.host;
  return `${p.protocol}://${host}:${p.port}${p.username !== undefined ? ' (with login)' : ''}`;
}

/**
 * Checks a proxy given in a request before any DNS: it must not point at this
 * machine or its network. The server checks its resolved address again when it
 * connects.
 */
export function checkRequestProxyHost(p: ProxySettings): { ok: true } | { ok: false; reason: string } {
  return checkHostName(p.host);
}

/** Where a request-level proxy stands on this install. */
export type RequestProxyPolicy =
  | { allowed: true }
  | { allowed: false; reason: string };
