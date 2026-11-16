import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEgressProxy, type EgressProxy } from '../src/egress-proxy.ts';
import { parseProxyUrl } from '../src/proxy.ts';
import { startHttpProxy, startSite, startSocks5Proxy, type TestProxy } from './helpers/test-proxies.ts';

let proxy: EgressProxy;
let target: http.Server;
let targetPort: number;

beforeAll(async () => {
  proxy = await startEgressProxy();
  target = http.createServer((_req, res) => res.end('private'));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  targetPort = (target.address() as net.AddressInfo).port;
});
afterAll(async () => {
  await proxy.close();
  await new Promise((r) => target.close(r));
});

function viaProxy(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, path: url, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

function connectVia(hostPort: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, '127.0.0.1', () => socket.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`));
    socket.once('data', (d) => {
      resolve(d.toString().split('\r\n')[0]!);
      socket.destroy();
    });
    socket.on('error', reject);
  });
}

describe('egress proxy', () => {
  it('refuses plain HTTP to a private address', async () => {
    expect(await viaProxy(`http://127.0.0.1:${targetPort}/`)).toBe(403);
  });
  it('refuses a name that resolves to a private address', async () => {
    // "localtest.me" style names are not needed: "localhost" is refused by name, and a
    // name that resolves to loopback is refused by the lookup.
    expect(await viaProxy(`http://localhost:${targetPort}/`)).toBe(403);
  });
  it('refuses CONNECT tunnels to private addresses', async () => {
    expect(await connectVia(`127.0.0.1:${targetPort}`)).toMatch(/403/);
    expect(await connectVia(`[::1]:${targetPort}`)).toMatch(/403/);
    expect(await connectVia(`169.254.169.254:80`)).toMatch(/403/);
  });
  it('refuses requests that are not proxy requests', async () => {
    expect(await viaProxy('/relative')).toBe(400);
  });
});

describe('egress proxy lookups', () => {
  it('never connects to a public-looking name that resolves to loopback', async () => {
    let reached = 0;
    const site = http.createServer((_req, res) => { reached++; res.end('private'); });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const port = (site.address() as net.AddressInfo).port;
    const rebinding = await startEgressProxy({ resolve: async () => ['127.0.0.1'] });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: rebinding.port, path: `http://site.example.com:${port}/`, method: 'GET' },
          (res) => { res.resume(); resolve(res.statusCode ?? 0); },
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(502);
      expect(reached).toBe(0);
    } finally {
      await rebinding.close();
      await new Promise((r) => site.close(r));
    }
  });
});

describe('egress proxy chained to your own proxy', () => {
  // site.example.com stands for a public site; everything else resolves to this machine.
  const PUBLIC_IP = '93.184.215.14';
  const resolve = async (host: string) =>
    host === 'site.example.com' ? [PUBLIC_IP] : host === 'intranet.example.com' ? ['10.0.0.5'] : ['127.0.0.1'];
  const site = startSite('<p>through the proxy</p>');

  /** Sends a CONNECT, then a plain HTTP request inside the tunnel; returns the status line and body. */
  function throughTunnel(port: number, hostPort: string): Promise<{ status: string; body: string }> {
    return new Promise((done, fail) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`));
      let text = '';
      let sent = false;
      socket.on('data', (d) => {
        text += d.toString();
        if (!sent && text.includes('\r\n\r\n')) {
          sent = true;
          const status = text.split('\r\n')[0]!;
          if (!/ 200 /.test(status)) {
            socket.destroy();
            return done({ status, body: '' });
          }
          text = '';
          socket.write(`GET / HTTP/1.1\r\nHost: ${hostPort.split(':')[0]}\r\nConnection: close\r\n\r\n`);
        }
      });
      socket.on('end', () => done({ status: 'HTTP/1.1 200 Connection Established', body: text }));
      socket.on('error', fail);
    });
  }

  function plainVia(port: number, url: string): Promise<{ status: number; body: string }> {
    return new Promise((done, fail) => {
      const req = http.request({ host: '127.0.0.1', port, path: url, method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => done({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', fail);
      req.end();
    });
  }

  for (const kind of ['http', 'socks5'] as const) {
    describe(`through ${kind}`, () => {
      let upstream: TestProxy;
      let egress: EgressProxy;
      const failures: string[] = [];
      beforeAll(async () => {
        upstream = kind === 'http' ? await startHttpProxy(site) : await startSocks5Proxy(site);
        egress = await startEgressProxy({ resolve, upstream: parseProxyUrl(upstream.url), onUpstreamFailure: (r) => failures.push(r) });
      });
      afterAll(async () => {
        await egress.close();
        await upstream.close();
      });

      it('tunnels to the checked address, with the login', async () => {
        upstream.seen.length = 0;
        const { status, body } = await throughTunnel(egress.port, 'site.example.com:443');
        expect(status).toMatch(/ 200 /);
        expect(body).toContain('through the proxy');
        expect(upstream.seen).toEqual([
          expect.objectContaining({ line: kind === 'http' ? `CONNECT ${PUBLIC_IP}:443` : `SOCKS ${PUBLIC_IP}:443`, authorized: true }),
        ]);
      });

      it('forwards plain HTTP to the checked address, keeping the Host header', async () => {
        upstream.seen.length = 0;
        const { status, body } = await plainVia(egress.port, 'http://site.example.com/page?x=1');
        expect(status).toBe(200);
        expect(body).toContain('through the proxy');
        const expected = kind === 'http'
          ? { line: `GET http://${PUBLIC_IP}:80/page?x=1`, host: 'site.example.com', authorized: true }
          : { line: `SOCKS ${PUBLIC_IP}:80`, authorized: true };
        expect(upstream.seen).toEqual([expect.objectContaining(expected)]);
      });

      it('still refuses private addresses, and the proxy never hears of them', async () => {
        upstream.seen.length = 0;
        expect(await connectVia2(egress.port, '127.0.0.1:22')).toMatch(/403/);
        expect(await connectVia2(egress.port, 'localhost:443')).toMatch(/403/);
        expect(await connectVia2(egress.port, 'intranet.example.com:443')).toMatch(/403/);
        expect(await connectVia2(egress.port, '169.254.169.254:80')).toMatch(/403/);
        expect((await plainVia(egress.port, 'http://intranet.example.com/')).status).toBe(403);
        expect((await plainVia(egress.port, 'http://10.1.2.3/')).status).toBe(403);
        expect(upstream.seen).toEqual([]);
        expect(failures).toEqual([]);
      });
    });
  }

  it('reports a refused login without the password', async () => {
    const upstream = await startHttpProxy(site);
    const wrong = parseProxyUrl(upstream.url.replace('pass%20word', 'not-the-password'));
    const failures: string[] = [];
    const egress = await startEgressProxy({ resolve, upstream: wrong, onUpstreamFailure: (r) => failures.push(r) });
    try {
      expect(await connectVia2(egress.port, 'site.example.com:443')).toMatch(/502/);
      expect(failures[0]).toMatch(/refused the login \(407\)/);
      expect(failures.join(' ')).not.toContain('not-the-password');
    } finally {
      await egress.close();
      await upstream.close();
    }
  });

  it('reports a refused SOCKS5 login', async () => {
    const upstream = await startSocks5Proxy(site);
    const failures: string[] = [];
    const egress = await startEgressProxy({
      resolve, upstream: parseProxyUrl(upstream.url.replace(':secret@', ':nope@')), onUpstreamFailure: (r) => failures.push(r),
    });
    try {
      expect(await connectVia2(egress.port, 'site.example.com:443')).toMatch(/502/);
      expect(failures[0]).toMatch(/refused the login/);
    } finally {
      await egress.close();
      await upstream.close();
    }
  });

  it('refuses a proxy from a request when it is on a private address', async () => {
    const upstream = await startHttpProxy(site);
    const failures: string[] = [];
    const egress = await startEgressProxy({
      resolve, upstream: parseProxyUrl(upstream.url), guardUpstream: true, onUpstreamFailure: (r) => failures.push(r),
    });
    try {
      expect(await connectVia2(egress.port, 'site.example.com:443')).toMatch(/502/);
      expect(failures[0]).toMatch(/private or local address/);
      expect(upstream.seen).toEqual([]);
    } finally {
      await egress.close();
      await upstream.close();
    }
  });

  it('reports a proxy that is not there', async () => {
    const failures: string[] = [];
    const egress = await startEgressProxy({
      resolve, upstream: parseProxyUrl('socks5://127.0.0.1:1'), onUpstreamFailure: (r) => failures.push(r),
    });
    try {
      expect(await connectVia2(egress.port, 'site.example.com:443')).toMatch(/502/);
      expect(failures[0]).toBe('refused the connection');
    } finally {
      await egress.close();
    }
  });
});

function connectVia2(port: number, hostPort: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`));
    socket.once('data', (d) => {
      resolve(d.toString().split('\r\n')[0]!);
      socket.destroy();
    });
    socket.on('error', reject);
  });
}
