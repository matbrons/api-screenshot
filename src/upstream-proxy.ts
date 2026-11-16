// Connections through your own proxy (server only). The egress proxy calls
// these after it has resolved and checked the target, and hands the proxy the
// checked IP address rather than the name. So the proxy never resolves a name
// itself, and a name that points into the proxy's own network is refused here
// just as it would be without a proxy.
//
// Errors are ProxyFailure, whose message says what went wrong without the
// proxy's address or login, so it is safe to show to the caller.

import net from 'node:net';
import tls from 'node:tls';
import { parseIPv6 } from './guard.ts';
import type { ProxySettings } from './proxy.ts';

/** A dns.lookup stand-in, the kind net.connect and http.request accept. */
export type Lookup = net.LookupFunction;

/** Longest wait for the proxy to accept a connection and answer the handshake. */
const HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_HEAD = 16 * 1024;

export class ProxyFailure extends Error {}

/** The proxy's own login, for HTTP proxies. */
export function proxyAuthorization(p: ProxySettings): string | undefined {
  if (p.username === undefined && p.password === undefined) return undefined;
  return `Basic ${Buffer.from(`${p.username ?? ''}:${p.password ?? ''}`).toString('base64')}`;
}

function networkReason(err: NodeJS.ErrnoException): string {
  switch (err.code) {
    case 'ECONNREFUSED': return 'refused the connection';
    case 'ENOTFOUND': case 'EAI_AGAIN': return 'could not be found';
    case 'ETIMEDOUT': return 'did not answer in time';
    case 'ECONNRESET': case 'EPIPE': return 'closed the connection';
    case 'EADDRNOTALLOWED': return 'is on a private or local address';
    default:
      if (/CERT|SSL|TLS/i.test(err.code ?? err.message)) return 'has a TLS certificate that could not be verified';
      return 'could not be reached';
  }
}

/** Looks up the proxy's address with the given lookup; Node skips a lookup for IP literals, this doesn't. */
function proxyAddress(p: ProxySettings, lookup: Lookup): Promise<string> {
  return new Promise((resolve, reject) => {
    lookup(p.host, {}, (err, address) => {
      if (err) reject(new ProxyFailure(networkReason(err)));
      else resolve(typeof address === 'string' ? address : address[0]!.address);
    });
  });
}

/**
 * Opens a connection to the proxy itself: plain TCP, or TLS for an https://
 * proxy. With a lookup, the proxy's address is checked by it first and the
 * connection goes to the address it returned.
 */
export async function connectToProxy(p: ProxySettings, lookup?: Lookup): Promise<net.Socket> {
  const host = lookup ? await proxyAddress(p, lookup) : p.host;
  return new Promise((resolve, reject) => {
    const socket: net.Socket =
      p.protocol === 'https'
        ? tls.connect({ host, port: p.port, servername: net.isIP(p.host) ? undefined : p.host, ALPNProtocols: ['http/1.1'] })
        : net.connect({ host, port: p.port });
    const fail = (reason: string) => {
      socket.destroy();
      reject(new ProxyFailure(reason));
    };
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => fail('did not answer in time'));
    socket.once('error', (err: NodeJS.ErrnoException) => fail(networkReason(err)));
    socket.once(p.protocol === 'https' ? 'secureConnect' : 'connect', () => {
      socket.removeAllListeners('error');
      socket.removeAllListeners('timeout');
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

/**
 * Reads a handshake answer byte by byte as it arrives. When done, whatever
 * came after the answer is put back on the socket, which is left paused for
 * the caller to pipe.
 */
function handshakeReader(socket: net.Socket) {
  let buffer = Buffer.alloc(0);
  let failure: ProxyFailure | null = null;
  let wake: (() => void) | null = null;
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    wake?.();
  };
  const onEnd = () => {
    failure ??= new ProxyFailure('closed the connection');
    wake?.();
  };
  const onError = (err: NodeJS.ErrnoException) => {
    failure ??= new ProxyFailure(networkReason(err));
    wake?.();
  };
  const onTimeout = () => {
    failure ??= new ProxyFailure('did not answer in time');
    wake?.();
  };
  socket.on('data', onData);
  socket.on('end', onEnd);
  socket.on('close', onEnd);
  socket.on('error', onError);
  socket.setTimeout(HANDSHAKE_TIMEOUT_MS, onTimeout);

  return {
    /** Waits until `size(buffer)` returns a length, then takes that many bytes. */
    async take(size: (buf: Buffer) => number | null): Promise<Buffer> {
      for (;;) {
        const n = size(buffer);
        if (n !== null && buffer.length >= n) {
          const out = buffer.subarray(0, n);
          buffer = buffer.subarray(n);
          return out;
        }
        if (failure) throw failure;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    },
    release() {
      socket.pause();
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      socket.off('error', onError);
      socket.setTimeout(0);
      if (buffer.length) socket.unshift(buffer);
    },
  };
}

function hostPort(ip: string, port: number): string {
  return net.isIPv6(ip) ? `[${ip}]:${port}` : `${ip}:${port}`;
}

async function httpConnect(socket: net.Socket, p: ProxySettings, ip: string, port: number): Promise<void> {
  const auth = proxyAuthorization(p);
  const target = hostPort(ip, port);
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`);
  const reader = handshakeReader(socket);
  try {
    const head = await reader.take((buf) => {
      const end = buf.indexOf('\r\n\r\n');
      if (end >= 0) return end + 4;
      if (buf.length > MAX_RESPONSE_HEAD) throw new ProxyFailure('sent an answer that is not HTTP');
      return null;
    });
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.toString('latin1'))?.[1]);
    if (status === 407) throw new ProxyFailure('refused the login (407): check the user name and password');
    if (!(status >= 200 && status < 300)) {
      throw new ProxyFailure(Number.isFinite(status) ? `refused the connection (${status})` : 'sent an answer that is not HTTP');
    }
  } finally {
    reader.release();
  }
}

const SOCKS_REPLIES: Record<number, string> = {
  1: 'failed (general SOCKS server failure)',
  2: 'refused the connection by its rules',
  3: 'could not reach the network',
  4: 'could not reach the host',
  5: 'had the connection refused by the site',
  6: 'timed out reaching the site',
  7: 'does not support CONNECT',
  8: 'does not support this address type',
};

async function socks5Connect(socket: net.Socket, p: ProxySettings, ip: string, port: number): Promise<void> {
  const withLogin = p.username !== undefined || p.password !== undefined;
  const reader = handshakeReader(socket);
  try {
    // Greeting: offer "no login", plus "user name and password" when we have them.
    socket.write(Buffer.from(withLogin ? [5, 2, 0, 2] : [5, 1, 0]));
    const [version, method] = await reader.take(() => 2);
    if (version !== 5) throw new ProxyFailure('is not a SOCKS5 proxy');
    if (method === 2 && withLogin) {
      const user = Buffer.from(p.username ?? '');
      const pass = Buffer.from(p.password ?? '');
      socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
      const [, status] = await reader.take(() => 2);
      if (status !== 0) throw new ProxyFailure('refused the login: check the user name and password');
    } else if (method === 0xff || method === 2) {
      throw new ProxyFailure(withLogin ? 'accepts none of the login methods offered' : 'needs a login: add user:pass to the proxy URL');
    } else if (method !== 0) {
      throw new ProxyFailure('asked for a login method that is not supported');
    }

    // Connect to the checked address, never to a name.
    const address = net.isIPv4(ip)
      ? Buffer.from([1, ...ip.split('.').map(Number)])
      : Buffer.from([4, ...(parseIPv6(ip) ?? [])]);
    if (address.length !== 5 && address.length !== 17) throw new ProxyFailure('was given an address it cannot carry');
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >> 8, port & 0xff])]));
    const reply = await reader.take((buf) => {
      if (buf.length < 5) return null;
      const type = buf[3];
      if (type === 1) return 10;
      if (type === 4) return 22;
      if (type === 3) return 7 + buf[4]!;
      throw new ProxyFailure('sent an answer that is not SOCKS5');
    });
    if (reply[1] !== 0) throw new ProxyFailure(SOCKS_REPLIES[reply[1]!] ?? 'refused the connection');
  } finally {
    reader.release();
  }
}

/**
 * Opens a tunnel through the proxy to ip:port (HTTP CONNECT or SOCKS5) and
 * returns the socket, paused, ready to carry the browser's bytes.
 * `lookup` resolves the proxy's own host name.
 */
export async function openTunnel(p: ProxySettings, ip: string, port: number, lookup?: Lookup): Promise<net.Socket> {
  const socket = await connectToProxy(p, lookup);
  try {
    if (p.protocol === 'socks5') await socks5Connect(socket, p, ip, port);
    else await httpConnect(socket, p, ip, port);
    return socket;
  } catch (err) {
    socket.destroy();
    throw err instanceof ProxyFailure ? err : new ProxyFailure('could not be reached');
  }
}
