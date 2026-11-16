import { describe, expect, it } from 'vitest';
import { CaptureError } from '../src/errors.ts';
import { DEVICES, normalizeUrl, parseOptions, queryOptions, requestPatterns } from '../src/options.ts';

const fails = (raw: Record<string, unknown>, limits?: Parameters<typeof parseOptions>[1]) => {
  try {
    parseOptions(raw, limits);
  } catch (err) {
    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureError).code).toBe('invalid_options');
    return (err as CaptureError).message;
  }
  throw new Error('expected parseOptions to fail');
};

describe('parseOptions', () => {
  it('fills in defaults', () => {
    expect(parseOptions({ url: 'https://example.com' })).toMatchObject({
      url: 'https://example.com/', format: 'png', fullPage: false, viewportWidth: 1280, viewportHeight: 800,
      deviceScaleFactor: 1, waitUntil: 'networkidle2', delayMs: 0, timeoutMs: 30000,
      blockCookieBanners: true, blockPopups: true, blockChats: true, blockAds: true, blockTrackers: true,
    });
  });

  it('reads query-string values', () => {
    const o = parseOptions({
      url: 'example.com/page', format: 'jpg', image_quality: '70', full_page: 'true', viewport_width: '390',
      device_scale_factor: '2.5', delay: '1.5', timeout: '20', block_cookie_banners: '0', hide_selectors: '.a, #b',
    });
    expect(o).toMatchObject({
      url: 'https://example.com/page', format: 'jpeg', imageQuality: 70, fullPage: true, viewportWidth: 390,
      deviceScaleFactor: 2.5, delayMs: 1500, timeoutMs: 20000, blockCookieBanners: false, hideSelectors: ['.a', '#b'],
    });
  });

  it('reads JSON values', () => {
    const o = parseOptions({ url: 'https://example.com', full_page: true, viewport_width: 1440, hide_selectors: ['.x'] });
    expect(o).toMatchObject({ fullPage: true, viewportWidth: 1440, hideSelectors: ['.x'] });
  });

  it('refuses unknown options and bad values', () => {
    expect(fails({ url: 'https://example.com', fullpage: 'true' })).toMatch(/Unknown option "fullpage"/);
    expect(fails({})).toMatch(/url/);
    expect(fails({ url: 'https://example.com', format: 'gif' })).toMatch(/format/);
    expect(fails({ url: 'https://example.com', full_page: 'yes' })).toMatch(/full_page/);
    expect(fails({ url: 'https://example.com', viewport_width: '99999' })).toMatch(/viewport_width/);
    expect(fails({ url: 'https://example.com', viewport_width: '12.5' })).toMatch(/whole/);
    expect(fails({ url: 'https://example.com', wait_until: 'never' })).toMatch(/wait_until/);
  });

  it('keeps timeouts and heights inside the server limits', () => {
    const limits = { maxTimeoutSeconds: 20, maxFullPageHeight: 5000 };
    expect(parseOptions({ url: 'https://example.com' }, limits)).toMatchObject({ timeoutMs: 20000, fullPageMaxHeight: 5000 });
    expect(fails({ url: 'https://example.com', timeout: '30' }, limits)).toMatch(/timeout/);
    expect(fails({ url: 'https://example.com', full_page_max_height: '6000' }, limits)).toMatch(/full_page_max_height/);
  });

  it('takes no access_key: the key never travels in the URL', () => {
    expect(fails({ url: 'https://example.com', access_key: 'k' })).toMatch(/Unknown option "access_key"/);
  });
});

describe('page options', () => {
  const url = 'https://example.com';

  it('fills a device preset\'s size, which the viewport options can still change', () => {
    expect(parseOptions({ url, viewport_device: 'iphone_13' })).toMatchObject({
      device: 'iphone_13', viewportWidth: 390, viewportHeight: 844, deviceScaleFactor: 3, viewportMobile: true,
    });
    expect(parseOptions({ url, viewport_device: 'ipad_landscape', viewport_width: 1000 })).toMatchObject({
      viewportWidth: 1000, viewportHeight: 768, viewportMobile: true,
    });
    expect(parseOptions({ url, viewport_device: 'desktop' })).toMatchObject({ viewportWidth: 1920, viewportMobile: false });
    expect(fails({ url, viewport_device: 'nokia_3310' })).toMatch(/viewport_device/);
  });

  it('reads headers as lines or an object, and refuses the ones that steer the connection', () => {
    expect(parseOptions({ url, headers: 'Authorization: Bearer abc\nX-Note: a, b' }).headers).toEqual([
      ['Authorization', 'Bearer abc'], ['X-Note', 'a, b'],
    ]);
    expect(parseOptions({ url, headers: { 'X-One': '1' } }).headers).toEqual([['X-One', '1']]);
    expect(fails({ url, headers: 'Host: internal' })).toMatch(/may not set Host/);
    expect(fails({ url, headers: 'Cookie: a=b' })).toMatch(/cookies/);
    expect(fails({ url, headers: 'User-Agent: x' })).toMatch(/user_agent/);
    expect(fails({ url, headers: 'Bad Name: x' })).toMatch(/not a header name/);
    expect(fails({ url, headers: 'no colon' })).toMatch(/lines such as/);
    expect(fails({ html: '<p>x</p>', headers: 'X-A: 1' })).toMatch(/need a "url"/);
  });

  it('reads cookies with their attributes', () => {
    expect(parseOptions({ url, cookies: ['session=a=b; Domain=example.com; Path=/; Secure; HttpOnly; SameSite=lax; Max-Age=60'] }).cookies).toEqual([
      { name: 'session', value: 'a=b', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' },
    ]);
    expect(fails({ url, cookies: 'novalue' })).toMatch(/cookies/);
    expect(fails({ url, cookies: 'a=b; SameSite=Sometimes' })).toMatch(/SameSite/);
    expect(fails({ url, cookies: 'a=b; Colour=red' })).toMatch(/unknown attribute/);
    expect(fails({ html: '<p>x</p>', cookies: 'a=b' })).toMatch(/Domain/);
  });

  it('reads click, styles, scripts, user agent, language and time zone', () => {
    expect(parseOptions({
      url, click: '#accept', styles: 'h1 { color: red }', scripts: 'window.scrollTo(0, 500)', user_agent: 'Bot/1.0',
      accept_language: 'de-DE, de;q=0.9', time_zone: 'Europe/Berlin',
    })).toMatchObject({
      click: ['#accept'], styles: 'h1 { color: red }', scripts: 'window.scrollTo(0, 500)', userAgent: 'Bot/1.0',
      acceptLanguage: 'de-DE,de', timeZone: 'Europe/Berlin',
    });
    expect(fails({ url, time_zone: 'Mars/Olympus' })).toMatch(/time_zone/);
    expect(fails({ url, accept_language: 'not a language!' })).toMatch(/accept_language/);
    expect(fails({ url, click: Array(11).fill('#a') })).toMatch(/at most 10/);
    expect(fails({ url, scripts: 'x'.repeat(100_001) })).toMatch(/too long/);
  });

  it('reads blocked requests and resource types', () => {
    expect(parseOptions({ url, block_requests: 'ads.example.com, *.example.net/track/*', block_resources: 'Image,font' })).toMatchObject({
      blockRequests: ['ads.example.com', '*.example.net/track/*'], blockResources: ['image', 'font'],
    });
    expect(fails({ url, block_resources: 'pictures' })).toMatch(/block_resources/);
  });

  it('reads PDF options with defaults', () => {
    expect(parseOptions({ url, format: 'pdf' })).toMatchObject({
      format: 'pdf',
      pdf: { paperFormat: 'letter', landscape: false, printBackground: true, fitOnePage: false, margin: { top: '0px', left: '0px' } },
    });
    expect(parseOptions({ url, format: 'pdf', pdf_paper_format: 'A4', pdf_margin: '1cm', pdf_margin_top: '20' }).pdf).toMatchObject({
      paperFormat: 'a4', margin: { top: '20px', right: '1cm', bottom: '1cm', left: '1cm' },
    });
    expect(fails({ url, format: 'pdf', selector: 'main' })).toMatch(/whole page/);
    expect(fails({ url, format: 'pdf', pdf_paper_format: 'a7' })).toMatch(/pdf_paper_format/);
    expect(fails({ url, format: 'pdf', pdf_margin: '1 inch' })).toMatch(/pdf_margin/);
  });

  it('caps the width times the scale at 3840 device pixels', () => {
    expect(parseOptions({ url, viewport_width: '1920', device_scale_factor: '2' })).toMatchObject({ viewportWidth: 1920, deviceScaleFactor: 2 });
    expect(parseOptions({ url, viewport_width: '1280', device_scale_factor: '3' }).deviceScaleFactor).toBe(3);
    expect(parseOptions({ url, viewport_width: '3840' }).viewportWidth).toBe(3840);
    expect(fails({ url, viewport_width: '1921', device_scale_factor: '2' })).toMatch(/"viewport_width" times "device_scale_factor".*3840/);
    expect(fails({ url, viewport_width: '3840', device_scale_factor: '1.5' })).toMatch(/3840 × 1.5 is 5760/);
    expect(fails({ url, viewport_width: '1000', clip_width: '2000', clip_height: '10', device_scale_factor: '2' })).toMatch(/"clip_width" times/);
    // Every device fits, turned or not.
    for (const id of Object.keys(DEVICES)) {
      for (const device of [id, `${id}_landscape`]) expect(() => parseOptions({ url, viewport_device: device }), device).not.toThrow();
    }
  });

  it('reads a clip, which needs a width and height and stands alone', () => {
    expect(parseOptions({ url, clip_y: '100', clip_width: '300', clip_height: '200' }).clip).toEqual({ x: 0, y: 100, width: 300, height: 200 });
    expect(fails({ url, clip_x: '10' })).toMatch(/clip_width/);
    expect(fails({ url, clip_width: '10', clip_height: '10', full_page: 'true' })).toMatch(/clip/);
  });

  it('takes html instead of a URL, and leaves its fixed parts alone', () => {
    expect(parseOptions({ html: '<h1>Hi</h1>' })).toMatchObject({
      url: null, html: '<h1>Hi</h1>', blockCookieBanners: false, blockPopups: false, blockChats: false, blockAds: true,
    });
    expect(parseOptions({ html: '<h1>Hi</h1>', block_popups: true }).blockPopups).toBe(true);
    expect(fails({ url, html: '<h1>Hi</h1>' })).toMatch(/not both/);
  });

  it('reads the response type', () => {
    expect(parseOptions({ url }).responseType).toBe('by_format');
    expect(parseOptions({ url, response_type: 'json' }).responseType).toBe('json');
    expect(fails({ url, response_type: 'xml' })).toMatch(/response_type/);
  });
});

describe('queryOptions', () => {
  it('turns repeated list options into a list and refuses other repeats', () => {
    expect(queryOptions(new URLSearchParams('url=a.com&click=%23x&click=%23y'))).toEqual({ url: 'a.com', click: ['#x', '#y'] });
    expect(() => queryOptions(new URLSearchParams('url=a.com&url=b.com'))).toThrow(/more than once/);
  });
});

describe('requestPatterns', () => {
  it('matches hosts with their subdomains, and patterns with *', () => {
    const blocked = requestPatterns(['ads.example.com', '*/track/*', 'https://cdn.example.org/*.js']);
    expect(blocked('https://ads.example.com/a.png', 'ads.example.com')).toBe(true);
    expect(blocked('https://x.ads.example.com/a.png', 'x.ads.example.com')).toBe(true);
    expect(blocked('https://badads.example.com/a.png', 'badads.example.com')).toBe(false);
    expect(blocked('https://example.net/track/pixel.gif', 'example.net')).toBe(true);
    expect(blocked('https://cdn.example.org/lib.js', 'cdn.example.org')).toBe(true);
    expect(blocked('https://cdn.example.org/lib.css', 'cdn.example.org')).toBe(false);
    expect(requestPatterns([])('https://example.com/', 'example.com')).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it('adds https:// when the scheme is missing', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com/');
    expect(normalizeUrl('example.com:8443/x')).toBe('https://example.com:8443/x');
  });
  it('refuses other schemes and credentials', () => {
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow(/http/);
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow(/http/);
    expect(() => normalizeUrl('https://user:pass@example.com')).toThrow(/password/);
    expect(() => normalizeUrl(' ')).toThrow(/required/);
  });
});
