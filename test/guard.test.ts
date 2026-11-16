import { describe, expect, it, vi } from 'vitest';
import { cachedHostCheck, checkHost, checkHostName, checkUrl, isPublicIp, parseIPv6 } from '../src/guard.ts';

describe('isPublicIp', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1',
    '172.31.255.255', '192.168.1.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
  ])('refuses private IPv4 %s', (ip) => expect(isPublicIp(ip)).toBe(false));

  it.each(['1.1.1.1', '8.8.8.8', '93.184.215.14', '172.15.255.255', '172.32.0.1', '100.128.0.1'])(
    'accepts public IPv4 %s',
    (ip) => expect(isPublicIp(ip)).toBe(true),
  );

  it.each(['::', '::1', 'fe80::1', 'fd00::1', 'fc00::abcd', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1',
    '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b::169.254.169.254', '[::1]', 'fe80::1%eth0'])(
    'refuses private IPv6 %s',
    (ip) => expect(isPublicIp(ip)).toBe(false),
  );

  it.each(['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '64:ff9b::808:808'])(
    'accepts public IPv6 %s',
    (ip) => expect(isPublicIp(ip)).toBe(true),
  );

  it('refuses anything that is not an address', () => {
    expect(isPublicIp('example.com')).toBe(false);
    expect(isPublicIp('256.1.1.1')).toBe(false);
    expect(isPublicIp('1:2:3')).toBe(false);
  });
});

describe('parseIPv6', () => {
  it('expands :: and a dotted tail', () => {
    expect(parseIPv6('::1')).toEqual([...Array(15).fill(0), 1]);
    expect(parseIPv6('::ffff:1.2.3.4')?.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
  });
  it('refuses malformed input', () => {
    expect(parseIPv6('1::2::3')).toBeNull();
    expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIPv6('12345::')).toBeNull();
    expect(parseIPv6('::ffff:127.0.0.01')).toBeNull();
  });
});

describe('checkHostName', () => {
  it.each(['localhost', 'LOCALHOST.', 'foo.localhost', 'printer.local', 'metadata.google.internal', 'nas.lan',
    'router.home.arpa', 'intranet', '10.0.0.1', '[::1]'.slice(1, -1), ''])(
    'refuses %s',
    (host) => expect(checkHostName(host).ok).toBe(false),
  );
  it.each(['example.com', 'www.bbc.co.uk', '8.8.8.8'])('accepts %s', (host) => expect(checkHostName(host).ok).toBe(true));

  // A host name reaches the guard as written when it comes from the browser's
  // request list or a proxy, so it must be read the way the browser reads it.
  it.each(['012.0.0.1', '0177.0.0.1', '0x7f.1', '127.1', '0x7f000001', '017700000001', '2130706433', '0.0.0.0x0'])(
    'refuses %s, another way to write a private address',
    (host) => expect(checkHostName(host).ok).toBe(false),
  );
  it.each(['08.8.8.8', '1.2.3.256', '1.2.3.4.5', '1..2.3', 'example.0x1f'])('refuses %s, not a valid address', (host) =>
    expect(checkHostName(host).ok).toBe(false),
  );
  it.each(['134744072', '010.010.010.010', '8.8.8.8.'])('accepts %s, a public address', (host) =>
    expect(checkHostName(host).ok).toBe(true),
  );
  it('accepts names with numbers in them', () => {
    expect(checkHostName('1password.com').ok).toBe(true);
    expect(checkHostName('123.example.com').ok).toBe(true);
  });
});

describe('checkUrl', () => {
  it('refuses schemes that reach files or other services', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com', 'gopher://example.com', 'chrome://settings', 'view-source:https://example.com']) {
      expect(checkUrl(url).ok, url).toBe(false);
    }
  });
  it('lets data, blob and about through', () => {
    expect(checkUrl('data:image/png;base64,AAAA').ok).toBe(true);
    expect(checkUrl('about:blank').ok).toBe(true);
  });
  it('checks the host of web URLs, including WebSockets', () => {
    expect(checkUrl('http://127.0.0.1:8080/').ok).toBe(false);
    expect(checkUrl('http://[::ffff:127.0.0.1]/').ok).toBe(false);
    expect(checkUrl('http://2130706433/').ok).toBe(false); // decimal form of 127.0.0.1, normalised by URL
    expect(checkUrl('http://0x7f.1/').ok).toBe(false);
    expect(checkUrl('ws://localhost:9222/devtools').ok).toBe(false);
    expect(checkUrl('https://example.com/').ok).toBe(true);
  });
  it('refuses garbage', () => expect(checkUrl('not a url').ok).toBe(false));
});

describe('checkHost', () => {
  it('refuses a public name that resolves to a private address', async () => {
    const v = await checkHost('evil.example', async () => ['93.184.215.14', '127.0.0.1']);
    expect(v).toMatchObject({ ok: false });
  });
  it('accepts a name whose addresses are all public', async () => {
    expect(await checkHost('example.com', async () => ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'])).toEqual({ ok: true });
  });
  it('fails closed when the lookup fails or finds nothing', async () => {
    expect(await checkHost('example.com', async () => { throw new Error('SERVFAIL'); })).toMatchObject({ ok: false, unresolved: true });
    expect(await checkHost('example.com', async () => [])).toMatchObject({ ok: false, unresolved: true });
  });
  it('does not resolve literals or local names', async () => {
    const resolve = vi.fn(async () => ['1.1.1.1']);
    expect((await checkHost('localhost', resolve)).ok).toBe(false);
    expect((await checkHost('8.8.8.8', resolve)).ok).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });
  it('looks each host up once per capture', async () => {
    const resolve = vi.fn(async () => ['1.1.1.1']);
    const check = cachedHostCheck(resolve);
    await Promise.all([check('a.example.com'), check('A.example.com'), check('b.example.com')]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
