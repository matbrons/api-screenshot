import { describe, expect, it, vi } from 'vitest';
import { configFromEnv, createApp } from '../src/app.ts';
import type { CaptureResult } from '../src/capture.ts';
import { CaptureError } from '../src/errors.ts';
import { parseOptions, type ScreenshotOptions } from '../src/options.ts';
import { MAX_PROXIES, ProxyUrlError, describeProxy, parseProxyList, parseProxyUrl } from '../src/proxy.ts';
import { proxyAuthorization } from '../src/upstream-proxy.ts';

const SECRET = 's3cr3t-Pa55';
const KEY = 'a'.repeat(32);

describe('parseProxyUrl', () => {
  it('reads http, https and socks5 proxies, with default ports', () => {
    expect(parseProxyUrl('http://proxy.example.com:8080')).toEqual({ protocol: 'http', host: 'proxy.example.com', port: 8080 });
    expect(parseProxyUrl('http://proxy.example.com')).toMatchObject({ protocol: 'http', port: 80 });
    expect(parseProxyUrl('https://proxy.example.com')).toMatchObject({ protocol: 'https', port: 443 });
    expect(parseProxyUrl('socks5://proxy.example.com')).toMatchObject({ protocol: 'socks5', port: 1080 });
    expect(parseProxyUrl('SOCKS5H://proxy.example.com:9050')).toMatchObject({ protocol: 'socks5', port: 9050 });
    expect(parseProxyUrl('http://[2001:db8::1]:3128')).toMatchObject({ host: '2001:db8::1', port: 3128 });
  });

  it('reads a login, percent-decoded', () => {
    expect(parseProxyUrl(`http://user%40example.com:${encodeURIComponent('p@ss:w/rd')}@proxy.example.com:8080/`)).toEqual({
      protocol: 'http', host: 'proxy.example.com', port: 8080, username: 'user@example.com', password: 'p@ss:w/rd',
    });
    expect(parseProxyUrl('socks5://only-user@proxy.example.com')).toMatchObject({ username: 'only-user' });
  });

  it('refuses what it cannot use, without repeating the URL', () => {
    const bad = [
      `ftp://u:${SECRET}@hidden-proxy.example.org`,
      `socks4://u:${SECRET}@hidden-proxy.example.org`,
      `http://u:${SECRET}@hidden-proxy.example.org/path`,
      `http://u:${SECRET}@hidden-proxy.example.org/?q=1`,
      `u:${SECRET}@hidden-proxy.example.org:8080`,
      `http://u:%E0%A4%A@hidden-proxy.example.org`,
      'not a url',
      '',
      `http://${'x'.repeat(600)}.hidden-proxy.example.org`,
    ];
    for (const input of bad) {
      let message = '';
      try {
        parseProxyUrl(input);
      } catch (err) {
        expect(err).toBeInstanceOf(ProxyUrlError);
        message = (err as Error).message;
      }
      expect(message, input).not.toBe('');
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain('hidden-proxy');
    }
  });
});

describe('parseProxyList', () => {
  it('reads proxies separated by commas, spaces or new lines', () => {
    const list = parseProxyList(`http://u:${SECRET}@a.example.com:8080,socks5://b.example.com\n  https://c.example.com ,`);
    expect(list.map(describeProxy)).toEqual([
      'http://a.example.com:8080 (with login)', 'socks5://b.example.com:1080', 'https://c.example.com:443',
    ]);
  });

  it('names a bad entry by its place, never by its text', () => {
    let message = '';
    try {
      parseProxyList(`http://a.example.com, ftp://u:${SECRET}@hidden-proxy.example.org`);
    } catch (err) {
      expect(err).toBeInstanceOf(ProxyUrlError);
      message = (err as Error).message;
    }
    expect(message).toMatch(/^entry 2 must start with/);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain('hidden-proxy');
    expect(() => parseProxyList(' , ')).toThrow(/is empty/);
    expect(() => parseProxyList(Array(MAX_PROXIES + 1).fill('http://a.example.com').join(','))).toThrow(/more than/);
  });
});

describe('describeProxy', () => {
  it('shows scheme, host and port, never the login', () => {
    const p = parseProxyUrl(`socks5://user:${SECRET}@proxy.example.com:1080`);
    expect(describeProxy(p)).toBe('socks5://proxy.example.com:1080 (with login)');
    expect(describeProxy(p)).not.toContain('user');
    expect(describeProxy(parseProxyUrl('http://[2001:db8::1]:3128'))).toBe('http://[2001:db8::1]:3128');
  });
  it('builds the Basic login for HTTP proxies', () => {
    expect(proxyAuthorization(parseProxyUrl('http://a:b@proxy.example.com'))).toBe(`Basic ${btoa('a:b')}`);
    expect(proxyAuthorization(parseProxyUrl('http://proxy.example.com'))).toBeUndefined();
  });
});

describe('the "proxy" option', () => {
  const url = 'https://example.com';
  const failure = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return err as CaptureError;
    }
    throw new Error('expected a failure');
  };

  it('is off by default', () => {
    expect(parseOptions({ url }).proxy).toBeNull();
    const err = failure(() => parseOptions({ url, proxy: `http://u:${SECRET}@proxy.example.com:8080` }));
    expect(err).toMatchObject({ code: 'proxy_not_allowed', status: 403 });
    expect(err.message).toMatch(/ALLOW_REQUEST_PROXY/);
    expect(err.message).not.toContain(SECRET);
  });

  it('is read when the server allows it', () => {
    const opts = parseOptions({ url, proxy: `socks5://u:${SECRET}@proxy.example.com:1080` }, undefined, { allowed: true });
    expect(opts.proxy).toEqual({ protocol: 'socks5', host: 'proxy.example.com', port: 1080, username: 'u', password: SECRET });
    expect(parseOptions({ url, proxy: '' }, undefined, { allowed: true }).proxy).toBeNull();
  });

  it('refuses a proxy on this machine or its network', () => {
    for (const proxy of ['http://127.0.0.1:3128', 'http://10.0.0.5:3128', 'socks5://localhost:1080', 'http://squid:3128', 'http://[::1]:8080', 'http://169.254.169.254']) {
      expect(failure(() => parseOptions({ url, proxy }, undefined, { allowed: true })), proxy).toMatchObject({ code: 'proxy_not_allowed' });
    }
  });

  it('refuses a bad value as invalid_options, without repeating it', () => {
    const err = failure(() => parseOptions({ url, proxy: `ftp://u:${SECRET}@proxy.example.com` }, undefined, { allowed: true }));
    expect(err).toMatchObject({ code: 'invalid_options' });
    expect(err.message).not.toContain(SECRET);
    expect(failure(() => parseOptions({ url, proxy: 42 }, undefined, { allowed: true }))).toMatchObject({ code: 'invalid_options' });
  });
});

describe('proxy settings from the environment', () => {
  const node = { proxy: true };

  it('reads PROXY_URL on a server', () => {
    const config = configFromEnv({ API_KEY: KEY, PROXY_URL: `http://u:${SECRET}@proxy.example.com:8080` }, node);
    expect(config.proxies).toEqual([expect.objectContaining({ host: 'proxy.example.com', password: SECRET })]);
    expect(config.proxyProblem).toBeUndefined();
  });

  it('allows the operator a proxy on the local network', () => {
    expect(configFromEnv({ API_KEY: KEY, PROXY_URL: 'socks5://127.0.0.1:9050' }, node).proxies).toEqual([expect.objectContaining({ host: '127.0.0.1' })]);
  });

  it('refuses screenshots when PROXY_URL is broken, without echoing it', () => {
    const config = configFromEnv({ API_KEY: KEY, PROXY_URL: `htp://u:${SECRET}@proxy.example.com` }, node);
    expect(config.proxies).toBeUndefined();
    expect(config.proxyProblem).toMatch(/^PROXY_URL must start with/);
    expect(config.proxyProblem).not.toContain(SECRET);
  });

  it('refuses screenshots on Cloudflare when PROXY_URL is set, rather than going out without it', () => {
    const config = configFromEnv({ API_KEY: KEY, PROXY_URL: `http://u:${SECRET}@proxy.example.com:8080` });
    expect(config.proxies).toBeUndefined();
    expect(config.proxyProblem).toMatch(/Cloudflare's browser can't/);
    expect(config.proxyProblem).not.toContain(SECRET);
  });

  it('reads PROXY_URLS, after PROXY_URL when both are set', () => {
    const config = configFromEnv({
      API_KEY: KEY, PROXY_URL: 'http://a.example.com:8080', PROXY_URLS: `socks5://u:${SECRET}@b.example.com\nhttp://c.example.com`,
    }, node);
    expect(config.proxies?.map((p) => p.host)).toEqual(['a.example.com', 'b.example.com', 'c.example.com']);
    expect(config.proxyProblem).toBeUndefined();
  });

  it('refuses screenshots when one entry of PROXY_URLS is broken, rather than leave it out', () => {
    const config = configFromEnv({ API_KEY: KEY, PROXY_URLS: `http://a.example.com htp://u:${SECRET}@b.example.com` }, node);
    expect(config.proxies).toBeUndefined();
    expect(config.proxyProblem).toMatch(/^PROXY_URLS entry 2 must start with/);
    expect(config.proxyProblem).not.toContain(SECRET);
  });

  it('refuses screenshots on Cloudflare when PROXY_URLS is set', () => {
    const config = configFromEnv({ API_KEY: KEY, PROXY_URLS: `http://u:${SECRET}@a.example.com,http://b.example.com` });
    expect(config.proxies).toBeUndefined();
    expect(config.proxyProblem).toMatch(/^PROXY_URLS is set, but Cloudflare's browser can't .* Remove PROXY_URLS/);
    expect(config.proxyProblem).not.toContain(SECRET);
  });

  it('keeps the per-request proxy off unless ALLOW_REQUEST_PROXY is on and a key is set', () => {
    expect(configFromEnv({ API_KEY: KEY }, node).requestProxy.allowed).toBe(false);
    expect(configFromEnv({ API_KEY: KEY, ALLOW_REQUEST_PROXY: 'true' }, node).requestProxy).toEqual({ allowed: true });
    const open = configFromEnv({ ALLOW_PUBLIC_ACCESS: 'true', ALLOW_REQUEST_PROXY: 'true' }, node).requestProxy;
    expect(open).toMatchObject({ allowed: false, reason: expect.stringMatching(/needs an API key/) });
    const shortKey = configFromEnv({ API_KEY: 'short', ALLOW_REQUEST_PROXY: 'true' }, node).requestProxy;
    expect(shortKey.allowed).toBe(false);
    const cloudflare = configFromEnv({ API_KEY: KEY, ALLOW_REQUEST_PROXY: 'true' }).requestProxy;
    expect(cloudflare).toMatchObject({ allowed: false, reason: expect.stringMatching(/Cloudflare/) });
  });
});

describe('the API with a proxy', () => {
  const result: CaptureResult = {
    image: new Uint8Array([1]),
    contentType: 'image/png',
    info: { finalUrl: 'https://example.com/', status: 200, removed: 0, consentManager: null, pageHeight: null, truncated: false, overlayRemaining: null },
  };
  const auth = { authorization: `Bearer ${KEY}` };
  const body = (proxy: string) => ({
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com', proxy }),
  });

  it('answers 403 proxy_not_allowed when the server does not allow it, and starts no browser', async () => {
    const screenshot = vi.fn(async () => result);
    const app = createApp({ screenshot, ...configFromEnv({ API_KEY: KEY }, { proxy: true }) });
    const res = await app.request('/screenshot', body(`http://u:${SECRET}@proxy.example.com:8080`));
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'proxy_not_allowed' });
    expect(text).not.toContain(SECRET);
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('passes the proxy on when allowed', async () => {
    const screenshot = vi.fn(async (_opts: ScreenshotOptions) => result);
    const app = createApp({ screenshot, ...configFromEnv({ API_KEY: KEY, ALLOW_REQUEST_PROXY: 'on' }, { proxy: true }) });
    const res = await app.request('/screenshot', body(`https://u:${SECRET}@proxy.example.com:8443`));
    expect(res.status).toBe(200);
    expect(screenshot.mock.calls[0]![0]).toMatchObject({ proxy: { protocol: 'https', host: 'proxy.example.com', port: 8443 } });
  });

  it('refuses every screenshot on Cloudflare when PROXY_URL is set', async () => {
    const screenshot = vi.fn(async () => result);
    const app = createApp({ screenshot, ...configFromEnv({ API_KEY: KEY, PROXY_URL: `http://u:${SECRET}@proxy.example.com` }) });
    const res = await app.request('/screenshot?url=example.com', { headers: auth });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'not_configured' });
    expect(text).not.toContain(SECRET);
    expect(screenshot).not.toHaveBeenCalled();
    const root = await (await app.request('/')).text();
    expect(root).toMatch(/PROXY_URL/);
    expect(root).not.toContain(SECRET);
  });

  it('refuses every screenshot on Cloudflare when PROXY_URLS is set, and says why', async () => {
    const screenshot = vi.fn(async () => result);
    const app = createApp({ screenshot, ...configFromEnv({ API_KEY: KEY, PROXY_URLS: `http://u:${SECRET}@a.example.com,http://b.example.com` }) });
    const res = await app.request('/screenshot?url=example.com', { headers: auth });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'not_configured', message: expect.stringMatching(/PROXY_URLS .*Docker version/) });
    expect(text).not.toContain(SECRET);
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('turns a proxy failure into a 502 proxy_error', async () => {
    const app = createApp({
      screenshot: async () => { throw new CaptureError('proxy_error', 'The proxy refused the connection.', 'proxy'); },
      ...configFromEnv({ API_KEY: KEY, PROXY_URL: 'http://proxy.example.com:8080' }, { proxy: true }),
    });
    const res = await app.request('/screenshot?url=example.com', { headers: auth });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'proxy_error', reason: 'proxy' });
  });
});
