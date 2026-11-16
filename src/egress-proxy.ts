// A tiny forward proxy that Chromium sends all its traffic through when the
// service runs on your own server. It resolves every host name itself, refuses
// private and local addresses, and connects to the exact address it checked.
// That closes the gap a request-level check leaves open: a name that resolves
// to a public address when checked and to 127.0.0.1 when the browser connects
// (DNS rebinding). WebSockets and HTTPS pass as CONNECT tunnels, so they are
// covered too.
//
// With your own proxy set (PROXY_URL, or "proxy" in a request), the checks stay
// here and only the connection goes on through it: the proxy is asked for the
// checked IP address, never the name.

import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { checkHostName, isIpLiteral, isPublicIp, type Resolver } from './guard.ts';
import type { ProxySettings } from './proxy.ts';
import { ProxyFailure, connectToProxy, openTunnel, proxyAuthorization, type Lookup } from './upstream-proxy.ts';

const systemResolve: Resolver = async (host) =>
  (await dns.promises.lookup(host, { all: true })).map((a) => a.address);

function refused(host: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${host} resolves to a private address`);
  err.code = 'EADDRNOTALLOWED';
  return err;
}

/** A drop-in for dns.lookup that fails when any address of the host is not public. */
function guardedLookup(resolve: Resolver): Lookup {
  return (host, options, callback) => {
    if (isIpLiteral(host)) {
      // The browser sends addresses in their plain form; any other spelling is refused.
      const family = net.isIP(host);
      if (!family || !isPublicIp(host)) return callback(refused(host), []);
      return options.all ? callback(null, [{ address: host, family }]) : callback(null, host, family);
    }
    resolve(host).then(
      (addresses) => {
        if (addresses.length === 0 || addresses.some((a) => !isPublicIp(a))) return callback(refused(host), []);
        const all = addresses.map((address) => ({ address, family: net.isIP(address) }));
        if (options.all) return callback(null, all);
        callback(null, all[0]!.address, all[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, []),
    );
  };
}

function allowedName(host: string): boolean {
  return checkHostName(host.replace(/^\[|\]$/g, '')).ok;
}

interface EgressOptions {
  /** Looks up host names for the guard. Defaults to the system resolver. */
  resolve?: Resolver;
  /** Sends every allowed connection on through this proxy, to the address checked here. */
  upstream?: ProxySettings;
  /** The upstream came with a request rather than from the operator, so its own address must be public too. */
  guardUpstream?: boolean;
  /** Told when the upstream proxy fails, with a reason that is safe to show to the caller. */
  onUpstreamFailure?: (reason: string) => void;
}

export interface EgressProxy {
  port: number;
  close(): Promise<void>;
}

export function startEgressProxy(options: EgressOptions = {}): Promise<EgressProxy> {
  const lookup = guardedLookup(options.resolve ?? systemResolve);
  const upstream = options.upstream;
  // The operator's own proxy may sit on the local network; one from a request may not.
  const upstreamLookup = options.guardUpstream ? lookup : undefined;

  /** The one public address to hand the upstream proxy, or why there is none. */
  const pickAddress = (host: string) =>
    new Promise<string>((done, fail) => {
      lookup(host, { all: true }, (err, addresses) => {
        if (err) return fail(err);
        if (typeof addresses === 'string') return done(addresses);
        done((addresses.find((a) => a.family === 4) ?? addresses[0]!).address);
      });
    });

  const upstreamFailed = (err: unknown) => {
    const reason = err instanceof ProxyFailure ? err.message : 'could not be reached';
    options.onUpstreamFailure?.(reason);
  };

  const server = http.createServer((req, res) => {
    // Plain HTTP: the request line carries the full URL.
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (target.protocol !== 'http:' || !allowedName(target.hostname)) {
      res.writeHead(403).end();
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const send = (outgoing: http.ClientRequest) => {
      // A tunnel socket arrives paused; the request's own listeners are on it once "socket" fires.
      outgoing.on('socket', (socket) => socket.resume());
      outgoing.on('response', (up) => {
        if (upstream && up.statusCode === 407) {
          // Passed on, Chromium would take it as a login request from this proxy.
          upstreamFailed(new ProxyFailure('refused the login (407): check the user name and password'));
          up.resume();
          res.writeHead(502).end();
          return;
        }
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      outgoing.on('error', (err) => {
        if (upstream) upstreamFailed(err);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(outgoing);
    };

    if (!upstream) {
      send(http.request(target, { method: req.method, headers, lookup }));
      return;
    }

    const host = target.hostname.replace(/^\[|\]$/g, '');
    const port = Number(target.port || 80);
    pickAddress(host).then(
      (ip) => {
        const path = `${target.pathname}${target.search}`;
        /** Opens the connection to the upstream first, then sends the request over it. */
        const sendOver = (connection: Promise<Duplex>, request: http.RequestOptions) =>
          connection.then(
            (socket) => send(http.request({ ...request, createConnection: () => socket })),
            (err: Error) => {
              upstreamFailed(err);
              if (!res.headersSent) res.writeHead(502);
              res.end();
            },
          );
        if (upstream.protocol === 'socks5') {
          // Through a SOCKS5 tunnel to the checked address, then plain HTTP inside it.
          sendOver(openTunnel(upstream, ip, port, upstreamLookup), { host: ip, port, path, method: req.method, headers });
        } else {
          // An HTTP proxy takes the full URL, with the checked address in place of the name.
          const auth = proxyAuthorization(upstream);
          sendOver(connectToProxy(upstream, upstreamLookup), {
            method: req.method,
            path: `http://${net.isIPv6(ip) ? `[${ip}]` : ip}:${port}${path}`,
            headers: { ...headers, host: target.host, ...(auth ? { 'proxy-authorization': auth } : {}) },
          });
        }
      },
      (err: NodeJS.ErrnoException) => res.writeHead(err.code === 'EADDRNOTALLOWED' ? 403 : 502).end(),
    );
  });

  // HTTPS and WebSockets: an opaque tunnel to host:port.
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? '');
    const host = match?.[1]?.replace(/^\[|\]$/g, '');
    const port = Number(match?.[2]);
    client.on('error', () => client.destroy());
    if (!host || !port || !allowedName(host)) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const join = (upstreamSocket: net.Socket) => {
      track(upstreamSocket);
      upstreamSocket.on('error', () => client.destroy());
      client.on('close', () => upstreamSocket.destroy());
      if (client.destroyed) return upstreamSocket.destroy();
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(client);
      client.pipe(upstreamSocket);
    };

    if (!upstream) {
      const direct = net.connect({ host, port, lookup });
      track(direct);
      direct.once('connect', () => join(direct));
      direct.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
      return;
    }
    pickAddress(host)
      .then(
        (ip) =>
          openTunnel(upstream, ip, port, upstreamLookup).then(join, (err) => {
            upstreamFailed(err);
            client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          }),
        (err: NodeJS.ErrnoException) =>
          client.end(err.code === 'EADDRNOTALLOWED' ? 'HTTP/1.1 403 Forbidden\r\n\r\n' : 'HTTP/1.1 502 Bad Gateway\r\n\r\n'),
      )
      .catch(() => client.destroy());
  });

  // Tunnels leave the HTTP server's bookkeeping, so track every socket to close them on shutdown.
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  server.on('connection', track);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        port,
        close: () => new Promise((done) => {
          server.close(() => done());
          for (const socket of sockets) socket.destroy();
          server.closeAllConnections();
        }),
      });
    });
  });
}
