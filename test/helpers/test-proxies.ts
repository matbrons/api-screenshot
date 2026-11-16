// Small local proxies that stand in for a user's own proxy in tests. They
// don't reach the internet: whatever comes through them is answered by a local
// "site", and every connection is recorded so a test can see what went where.

import http from 'node:http';
import net from 'node:net';

export interface Seen {
  /** "CONNECT 1.2.3.4:443", "GET http://1.2.3.4:80/path" or "SOCKS 1.2.3.4:80" */
  line: string;
  /** Host header of a plain HTTP request, when there was one. */
  host?: string;
  /** Whether the login matched. */
  authorized: boolean;
}

export interface TestProxy {
  url: string;
  port: number;
  seen: Seen[];
  close(): Promise<void>;
}

/** The "site" behind the proxy: every request gets the same page. */
export function startSite(body: string): http.Server {
  return http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  });
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

function closer(server: net.Server, sockets: Set<net.Socket>) {
  server.on('connection', (s: net.Socket) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  return () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
}

/** An HTTP proxy with Basic login: absolute-form requests and CONNECT tunnels. */
export async function startHttpProxy(site: http.Server, login = { username: 'user', password: 'pass word' }): Promise<TestProxy> {
  const seen: Seen[] = [];
  const expected = `Basic ${Buffer.from(`${login.username}:${login.password}`).toString('base64')}`;
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    const authorized = req.headers['proxy-authorization'] === expected;
    seen.push({ line: `${req.method} ${req.url}`, host: req.headers.host, authorized });
    if (!authorized) return res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' }).end();
    site.emit('request', req, res);
  });
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    const authorized = req.headers['proxy-authorization'] === expected;
    seen.push({ line: `CONNECT ${req.url}`, authorized });
    if (!authorized) return client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) client.unshift(head);
    site.emit('connection', client);
  });
  const port = await listen(server);
  const auth = `${encodeURIComponent(login.username)}:${encodeURIComponent(login.password)}`;
  return { url: `http://${auth}@127.0.0.1:${port}`, port, seen, close: closer(server, sockets) };
}

/** A SOCKS5 proxy with user name and password login (RFC 1928 and 1929). */
export async function startSocks5Proxy(site: http.Server, login = { username: 'user', password: 'secret' }): Promise<TestProxy> {
  const seen: Seen[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let stage: 'greeting' | 'login' | 'request' = 'greeting';
    let authorized = false;
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting' && buf.length >= 2 && buf.length >= 2 + buf[1]!) {
        const methods = [...buf.subarray(2, 2 + buf[1]!)];
        buf = buf.subarray(2 + buf[1]!);
        if (!methods.includes(2)) return socket.end(Buffer.from([5, 0xff]));
        socket.write(Buffer.from([5, 2]));
        stage = 'login';
      }
      if (stage === 'login' && buf.length >= 2) {
        const ulen = buf[1]!;
        if (buf.length < 3 + ulen) return;
        const plen = buf[2 + ulen]!;
        if (buf.length < 3 + ulen + plen) return;
        const user = buf.subarray(2, 2 + ulen).toString();
        const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.subarray(3 + ulen + plen);
        authorized = user === login.username && pass === login.password;
        if (!authorized) {
          seen.push({ line: 'SOCKS login refused', authorized });
          return socket.end(Buffer.from([1, 1]));
        }
        socket.write(Buffer.from([1, 0]));
        stage = 'request';
      }
      if (stage === 'request' && buf.length >= 5) {
        const type = buf[3]!;
        const addrLen = type === 1 ? 4 : type === 4 ? 16 : 1 + buf[4]!;
        if (buf.length < 4 + addrLen + 2) return;
        const addr = buf.subarray(4, 4 + addrLen);
        const host = type === 1 ? [...addr].join('.') : type === 3 ? addr.subarray(1).toString() : addr.toString('hex');
        const port = buf.readUInt16BE(4 + addrLen);
        const rest = buf.subarray(4 + addrLen + 2);
        seen.push({ line: `SOCKS ${host}:${port}`, authorized });
        socket.off('data', onData);
        socket.pause();
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (rest.length) socket.unshift(rest);
        site.emit('connection', socket);
        socket.resume();
      }
    };
    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
  });
  const port = await listen(server);
  return { url: `socks5://${login.username}:${login.password}@127.0.0.1:${port}`, port, seen, close: closer(server, sockets) };
}
