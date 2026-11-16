// Parses and validates request options. Names follow the vocabulary common to
// hosted screenshot APIs (url, full_page, viewport_width, block_cookie_banners,
// ...), so a request written for one of them usually works here unchanged.

import { CaptureError } from './errors.ts';
import { ProxyUrlError, checkRequestProxyHost, parseProxyUrl, type ProxySettings, type RequestProxyPolicy } from './proxy.ts';

type OutputFormat = 'png' | 'jpeg' | 'webp' | 'pdf';
type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
/** by_format: the file itself. json: details plus the file in base64. metadata: the details alone. */
type ResponseType = 'by_format' | 'json' | 'metadata';

interface PdfOptions {
  paperFormat: PaperFormat;
  landscape: boolean;
  printBackground: boolean;
  /** One page as tall as the page itself, as wide as the viewport, instead of paper pages. */
  fitOnePage: boolean;
  /** CSS lengths, such as "0" or "20px". */
  margin: { top: string; right: string; bottom: string; left: string };
}

export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A cookie to set before the page loads. Without a domain it belongs to the page's own URL. */
interface CookieOption {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface ScreenshotOptions {
  /** The page to load. Null when `html` is given instead. */
  url: string | null;
  /** Markup to render instead of a URL. */
  html: string | null;
  format: OutputFormat;
  imageQuality: number;
  fullPage: boolean;
  fullPageMaxHeight: number;
  /** A preset from DEVICES that set the viewport (and the user agent), or null. */
  device: string | null;
  viewportWidth: number;
  viewportHeight: number;
  deviceScaleFactor: number;
  viewportMobile: boolean;
  waitUntil: WaitUntil;
  waitForSelector: string | null;
  delayMs: number;
  timeoutMs: number;
  selector: string | null;
  clip: Clip | null;
  hideSelectors: string[];
  blockCookieBanners: boolean;
  blockPopups: boolean;
  blockChats: boolean;
  blockAds: boolean;
  blockTrackers: boolean;
  /** URL patterns never to load: a host ("example.com") or a pattern with * ("*.example.com/ads/*"). */
  blockRequests: string[];
  /** Kinds of request never to load, such as "image" or "font". */
  blockResources: string[];
  darkMode: boolean;
  reducedMotion: boolean;
  /** "screen" or "print"; null leaves the browser's own (screen for images, print for PDF). */
  mediaType: 'screen' | 'print' | null;
  omitBackground: boolean;
  /** CSS added to the page before the shot. */
  styles: string | null;
  /** JavaScript run in the page before the shot. */
  scripts: string | null;
  /** Selectors clicked, in order, before the shot. */
  click: string[];
  /** Extra request headers, sent to the page's own site only. */
  headers: Array<[string, string]>;
  cookies: CookieOption[];
  userAgent: string | null;
  /** Languages in order of preference, such as "de-DE,de". They set Accept-Language, navigator.language and Intl. */
  acceptLanguage: string | null;
  /** An IANA time zone such as "Europe/Berlin". */
  timeZone: string | null;
  pdf: PdfOptions;
  responseType: ResponseType;
  /** A proxy given with this request. Null means the server's own setting (PROXY_URL, PROXY_URLS), if any. */
  proxy: ProxySettings | null;
  /** More tries after a failure that another try may fix, within the same timeout. */
  retry: number;
  /** HTTP statuses of the page that make the request fail instead of returning a shot. */
  failOnStatus: number[];
}

/** Ceilings set by whoever runs the service (environment variables). */
export interface Limits {
  maxTimeoutSeconds: number;
  maxFullPageHeight: number;
}

export const DEFAULT_LIMITS: Limits = { maxTimeoutSeconds: 60, maxFullPageHeight: 20000 };

type DeviceKind = 'iphone' | 'ipad' | 'android' | 'android_tablet' | 'desktop';

/**
 * Device presets for "viewport_device", with the ids and sizes other screenshot
 * APIs use. Each also takes "_landscape", which swaps width and height.
 */
export const DEVICES: Record<string, { width: number; height: number; scale: number; kind: DeviceKind; model?: string }> = {
  iphone_se: { width: 320, height: 568, scale: 2, kind: 'iphone' },
  iphone_13: { width: 390, height: 844, scale: 3, kind: 'iphone' },
  iphone_13_pro_max: { width: 428, height: 926, scale: 3, kind: 'iphone' },
  iphone_15: { width: 393, height: 659, scale: 3, kind: 'iphone' },
  iphone_15_pro: { width: 393, height: 659, scale: 3, kind: 'iphone' },
  iphone_15_pro_max: { width: 430, height: 739, scale: 3, kind: 'iphone' },
  iphone_16: { width: 393, height: 659, scale: 3, kind: 'iphone' },
  pixel_5: { width: 393, height: 851, scale: 3, kind: 'android', model: 'Pixel 5' },
  galaxy_s8: { width: 360, height: 740, scale: 3, kind: 'android', model: 'SM-G950F' },
  ipad: { width: 768, height: 1024, scale: 2, kind: 'ipad' },
  ipad_mini: { width: 768, height: 1024, scale: 2, kind: 'ipad' },
  ipad_pro_11: { width: 834, height: 1194, scale: 2, kind: 'ipad' },
  ipad_pro: { width: 1024, height: 1366, scale: 2, kind: 'ipad' },
  galaxy_tab_s4: { width: 712, height: 1138, scale: 2.25, kind: 'android_tablet', model: 'SM-T835' },
  laptop: { width: 1440, height: 900, scale: 2, kind: 'desktop' },
  desktop: { width: 1920, height: 1080, scale: 1, kind: 'desktop' },
};

export const FORMATS: Record<string, OutputFormat> = { png: 'png', jpeg: 'jpeg', jpg: 'jpeg', webp: 'webp', pdf: 'pdf' };
export const WAIT_UNTIL = ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'];
export const RESPONSE_TYPES = ['by_format', 'json', 'metadata'];
export const PAPER_FORMATS = ['letter', 'legal', 'tabloid', 'ledger', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6'] as const;
type PaperFormat = (typeof PAPER_FORMATS)[number];
/** Request kinds as the browser names them. "document" only ever blocks frames, never the page itself. */
export const RESOURCE_TYPES = [
  'document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'xhr', 'fetch', 'prefetch',
  'eventsource', 'websocket', 'manifest', 'signedexchange', 'ping', 'cspviolationreport', 'preflight', 'other',
];
/** Headers a request may not set: they steer the connection, or have an option of their own. */
const FORBIDDEN_HEADERS = /^(host|content-length|connection|keep-alive|transfer-encoding|te|trailer|upgrade|expect|proxy-.*|user-agent|cookie)$/i;
const MAX_URL_LENGTH = 2048;
const MAX_STRING_LENGTH = 500;
const MAX_LIST = 50;
const MAX_CODE_LENGTH = 100_000;
const MAX_HTML_LENGTH = 1_000_000;

/** Every option the API accepts. Unknown names are refused, so a typo never fails silently. */
export const OPTION_NAMES = [
  'url', 'html', 'format', 'image_quality', 'full_page', 'full_page_max_height',
  'viewport_device', 'viewport_width', 'viewport_height', 'device_scale_factor', 'viewport_mobile',
  'wait_until', 'wait_for_selector', 'delay', 'timeout', 'selector', 'clip_x', 'clip_y', 'clip_width', 'clip_height',
  'hide_selectors', 'block_cookie_banners', 'block_popups', 'block_chats', 'block_ads', 'block_trackers',
  'block_requests', 'block_resources', 'dark_mode', 'reduced_motion', 'media_type', 'omit_background',
  'styles', 'scripts', 'click', 'headers', 'cookies', 'user_agent', 'accept_language', 'time_zone',
  'pdf_paper_format', 'pdf_landscape', 'pdf_print_background', 'pdf_fit_one_page',
  'pdf_margin', 'pdf_margin_top', 'pdf_margin_right', 'pdf_margin_bottom', 'pdf_margin_left',
  'response_type', 'proxy', 'retry', 'fail_on_status',
] as const;

/** Options that may be given more than once in a query string (?headers=A:1&headers=B:2). */
export const REPEATABLE_OPTIONS = new Set(['hide_selectors', 'block_requests', 'block_resources', 'click', 'headers', 'cookies']);

/** The default: a request may not bring its own proxy. */
export const REQUEST_PROXY_OFF: RequestProxyPolicy = {
  allowed: false,
  reason: 'The "proxy" option is turned off on this server. Whoever runs it can turn it on with ALLOW_REQUEST_PROXY=true.',
};

type Raw = Record<string, unknown>;

/**
 * The widest image, in device pixels: a 4K screen. A width times a scale above
 * this is refused, which keeps the largest image a shot can draw to about
 * 250 MB of memory (3840 × 16384 pixels).
 */
export const MAX_DEVICE_WIDTH = 3840;

function invalid(message: string): never {
  throw new CaptureError('invalid_options', message);
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

function bool(raw: Raw, name: string, fallback: boolean): boolean {
  const v = raw[name];
  if (isEmpty(v)) return fallback;
  if (v === true || v === 'true' || v === '1' || v === 1) return true;
  if (v === false || v === 'false' || v === '0' || v === 0) return false;
  return invalid(`"${name}" must be true or false.`);
}

function num(raw: Raw, name: string, fallback: number, min: number, max: number, whole = true): number {
  const v = raw[name];
  if (isEmpty(v)) return fallback;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < min || n > max || (whole && !Number.isInteger(n))) {
    return invalid(`"${name}" must be a ${whole ? 'whole ' : ''}number from ${min} to ${max}.`);
  }
  return n;
}

function str(raw: Raw, name: string, max = MAX_STRING_LENGTH): string | null {
  const v = raw[name];
  if (isEmpty(v)) return null;
  if (typeof v !== 'string') return invalid(`"${name}" must be a string.`);
  if (v.length > max) invalid(`"${name}" is too long.`);
  return v;
}

function oneOf<T extends string>(raw: Raw, name: string, allowed: readonly T[], fallback: T): T;
function oneOf<T extends string>(raw: Raw, name: string, allowed: readonly T[], fallback: null): T | null;
function oneOf<T extends string>(raw: Raw, name: string, allowed: readonly T[], fallback: T | null): T | null {
  const v = str(raw, name)?.toLowerCase();
  if (v === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(v)) invalid(`"${name}" must be one of ${allowed.join(', ')}.`);
  return v as T;
}

/** A list given as a JSON array, a repeated query parameter, or one string split on `separator`. */
function list(raw: Raw, name: string, separator: string | RegExp, max = MAX_LIST, itemMax = MAX_STRING_LENGTH): string[] {
  const v = raw[name];
  if (isEmpty(v)) return [];
  const items: unknown[] = Array.isArray(v) ? v : typeof v === 'string' ? v.split(separator) : [v];
  const out = items.map((s) => {
    if (typeof s !== 'string' || s.length > itemMax) invalid(`"${name}" must be a list of strings of up to ${itemMax} characters.`);
    return s.trim();
  }).filter(Boolean);
  if (out.length > max) invalid(`"${name}" takes at most ${max} entries.`);
  return out;
}

/** Reads "fail_on_status": statuses and ranges such as "404,500-599", or a JSON array of numbers. */
function statusList(raw: Raw, name: string): number[] {
  const v = raw[name];
  if (isEmpty(v)) return [];
  const items: unknown[] = Array.isArray(v) ? v : String(v).split(',');
  if (items.length > 50) invalid(`"${name}" takes at most 50 entries.`);
  const statuses = new Set<number>();
  for (const item of items) {
    const m = /^\s*(\d{3})\s*(?:-\s*(\d{3})\s*)?$/.exec(String(item));
    const from = Number(m?.[1]);
    const to = Number(m?.[2] ?? m?.[1]);
    if (!m || typeof item === 'boolean' || from < 100 || to > 599 || from > to) {
      invalid(`"${name}" must be HTTP statuses or ranges, for example 404,500-599.`);
    }
    for (let s = from; s <= to; s++) statuses.add(s);
  }
  return [...statuses];
}

/** Reads "headers": "Name: value" lines (or a JSON object). Values may hold commas, so lines split only on new lines. */
function headerList(raw: Raw): Array<[string, string]> {
  const v = raw.headers;
  const pairs: Array<[string, string]> =
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.entries(v).map(([k, val]) => [k, typeof val === 'string' ? val : invalid('"headers" values must be strings.')])
      : list(raw, 'headers', /\r?\n/, 30, 8000).map((line) => {
          const at = line.indexOf(':');
          if (at < 1) invalid('"headers" must be lines such as "Authorization: Bearer abc".');
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        });
  if (pairs.length > 30) invalid('"headers" takes at most 30 headers.');
  for (const [name, value] of pairs) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(name)) invalid(`"headers": "${name.slice(0, 50)}" is not a header name.`);
    if (/[\r\n\0]/.test(value) || value.length > 8000) invalid(`"headers": the value of ${name} is not allowed.`);
    if (FORBIDDEN_HEADERS.test(name)) {
      const hint = /^user-agent$/i.test(name) ? ' Use "user_agent".' : /^cookie$/i.test(name) ? ' Use "cookies".' : '';
      invalid(`"headers" may not set ${name}.${hint}`);
    }
  }
  return pairs;
}

/** Reads "cookies": Set-Cookie style lines, "name=value; Domain=example.com; Path=/; Secure; HttpOnly; SameSite=Lax". */
function cookieList(raw: Raw, html: boolean): CookieOption[] {
  return list(raw, 'cookies', /\r?\n/, 50, 8000).map((line) => {
    const [pair = '', ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    if (eq < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) invalid('"cookies" must be lines such as "session=abc; Domain=example.com".');
    const cookie: CookieOption = { name, value: pair.slice(eq + 1).trim() };
    for (const attr of attrs) {
      const [key = '', ...rest] = attr.split('=');
      const val = rest.join('=').trim();
      switch (key.trim().toLowerCase()) {
        case 'domain': cookie.domain = val; break;
        case 'path': cookie.path = val; break;
        case 'secure': cookie.secure = true; break;
        case 'httponly': cookie.httpOnly = true; break;
        case 'samesite': {
          const s = { strict: 'Strict', lax: 'Lax', none: 'None' }[val.toLowerCase()] as CookieOption['sameSite'];
          if (!s) invalid('"cookies": SameSite must be Strict, Lax or None.');
          cookie.sameSite = s;
          break;
        }
        // The cookie only lives as long as this one shot, so its expiry doesn't matter.
        case 'expires': case 'max-age': case '': break;
        default: invalid(`"cookies": unknown attribute "${key.trim().slice(0, 50)}".`);
      }
    }
    if (html && !cookie.domain) invalid('"cookies" need a Domain when rendering "html".');
    return cookie;
  });
}

/** Reads a CSS length for the PDF margins: a number with px, in, cm or mm, or 0. */
function cssLength(raw: Raw, name: string, fallback: string): string {
  const v = raw[name];
  if (isEmpty(v)) return fallback;
  const s = String(v).trim().toLowerCase();
  if (!/^\d{1,4}(\.\d+)?(px|in|cm|mm)?$/.test(s)) invalid(`"${name}" must be a length such as 20px, 1cm or 0.`);
  return /\d$/.test(s) ? `${s}px` : s;
}

function clipOption(raw: Raw, maxHeight: number): Clip | null {
  if (['clip_x', 'clip_y', 'clip_width', 'clip_height'].every((n) => isEmpty(raw[n]))) return null;
  if (isEmpty(raw.clip_width) || isEmpty(raw.clip_height)) invalid('"clip_width" and "clip_height" are both needed for a clip.');
  return {
    x: num(raw, 'clip_x', 0, 0, 10000),
    y: num(raw, 'clip_y', 0, 0, maxHeight),
    width: num(raw, 'clip_width', 0, 1, 3840),
    height: num(raw, 'clip_height', 0, 1, maxHeight),
  };
}

function deviceOption(raw: Raw) {
  const id = str(raw, 'viewport_device')?.toLowerCase() ?? null;
  if (!id) return null;
  const landscape = id.endsWith('_landscape');
  const preset = DEVICES[landscape ? id.slice(0, -'_landscape'.length) : id];
  if (!preset) invalid(`"viewport_device" must be one of ${Object.keys(DEVICES).join(', ')}, with or without _landscape.`);
  const { width, height } = preset;
  return { id, ...preset, width: landscape ? height : width, height: landscape ? width : height };
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Adds https:// when the scheme is missing; refuses anything but a plain http(s) URL. */
export function normalizeUrl(input: string): string {
  let s = input.trim();
  if (!s) invalid('"url" is required.');
  if (s.length > MAX_URL_LENGTH) invalid('"url" is too long.');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) || /^[^:/]+:\d+(\/|$)/.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return invalid('"url" is not a valid URL.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') invalid('"url" must start with http:// or https://.');
  if (u.username || u.password) invalid('"url" must not contain a username or password.');
  return u.toString();
}

/**
 * Reads the "proxy" option. Refused unless the server allows it, and refused
 * when it points at a private or local address. Messages never repeat the
 * value, which may hold a password.
 */
function requestProxy(raw: Raw, policy: RequestProxyPolicy): ProxySettings | null {
  const v = raw.proxy;
  if (isEmpty(v)) return null;
  if (!policy.allowed) throw new CaptureError('proxy_not_allowed', policy.reason);
  if (typeof v !== 'string') return invalid('"proxy" must be a URL such as http://user:pass@proxy.example.com:8080.');
  let proxy: ProxySettings;
  try {
    proxy = parseProxyUrl(v);
  } catch (err) {
    if (err instanceof ProxyUrlError) invalid(`"proxy" ${err.message}.`);
    throw err;
  }
  const where = checkRequestProxyHost(proxy);
  if (!where.ok) throw new CaptureError('proxy_not_allowed', `"proxy" must be on the public internet, not a ${where.reason}.`);
  return proxy;
}

/** Turns a query string into raw options: a name given more than once becomes a list. */
export function queryOptions(params: URLSearchParams): Raw {
  const raw: Raw = {};
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    raw[name] = values.length > 1 && REPEATABLE_OPTIONS.has(name) ? values : values.length > 1 ? invalid(`"${name}" is given more than once.`) : values[0];
  }
  return raw;
}

/**
 * Turns query parameters or a JSON body into validated options. Accepts strings
 * ("true", "1280") as well as real JSON types.
 */
export function parseOptions(
  raw: Raw,
  limits: Limits = DEFAULT_LIMITS,
  proxyPolicy: RequestProxyPolicy = REQUEST_PROXY_OFF,
): ScreenshotOptions {
  const known = new Set<string>(OPTION_NAMES);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) invalid(`Unknown option "${key}". See the README for the full list.`);
  }
  const html = str(raw, 'html', MAX_HTML_LENGTH);
  if (html !== null && !isEmpty(raw.url)) invalid('Give "url" or "html", not both.');
  if (html === null && typeof raw.url !== 'string') invalid('"url" is required.');

  const format = FORMATS[(str(raw, 'format') ?? 'png').toLowerCase()];
  if (!format) invalid('"format" must be png, jpeg, webp or pdf.');

  const waitUntil = str(raw, 'wait_until') ?? 'networkidle2';
  if (!WAIT_UNTIL.includes(waitUntil)) invalid(`"wait_until" must be one of ${WAIT_UNTIL.join(', ')}.`);

  const maxTimeout = limits.maxTimeoutSeconds;
  const maxHeight = limits.maxFullPageHeight;
  const device = deviceOption(raw);
  const selector = str(raw, 'selector');
  const clip = clipOption(raw, maxHeight);
  const fullPage = bool(raw, 'full_page', false);
  if (clip && (selector || fullPage)) invalid('A clip can\'t be combined with "selector" or "full_page".');
  if (format === 'pdf' && (clip || selector)) invalid('A PDF is of the whole page: "selector" and clips only work for images.');

  const blockResources = list(raw, 'block_resources', ',', RESOURCE_TYPES.length).map((t) => t.toLowerCase());
  const unknownType = blockResources.find((t) => !RESOURCE_TYPES.includes(t));
  if (unknownType) invalid(`"block_resources" takes ${RESOURCE_TYPES.join(', ')}; not "${unknownType.slice(0, 50)}".`);

  const timeZone = str(raw, 'time_zone', 100);
  if (timeZone && !isTimeZone(timeZone)) invalid('"time_zone" must be a time zone such as Europe/Berlin.');
  const acceptLanguage = str(raw, 'accept_language', 200);
  if (acceptLanguage && !/^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*(\s*;\s*q=[01](\.\d{1,3})?)?(\s*,\s*([a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*|\*)(\s*;\s*q=[01](\.\d{1,3})?)?)*$/.test(acceptLanguage)) {
    invalid('"accept_language" must be a language list such as de-DE or "de-DE,de;q=0.9".');
  }
  const userAgent = str(raw, 'user_agent');
  if (userAgent && /[\r\n\0]/.test(userAgent)) invalid('"user_agent" must be one line.');

  const headers = headerList(raw);
  if (html !== null && headers.length > 0) invalid('"headers" go to the page\'s own site, so they need a "url".');

  const viewportWidth = num(raw, 'viewport_width', device?.width ?? 1280, 240, 3840);
  const deviceScaleFactor = num(raw, 'device_scale_factor', device?.scale ?? 1, 0.5, 3, false);
  const widest = Math.max(viewportWidth, clip?.width ?? 0);
  const deviceWidth = Math.round(widest * deviceScaleFactor * 100) / 100;
  if (deviceWidth > MAX_DEVICE_WIDTH) {
    invalid(
      `${clip && clip.width > viewportWidth ? '"clip_width"' : '"viewport_width"'} times "device_scale_factor" can be at most ` +
        `${MAX_DEVICE_WIDTH} device pixels; ${widest} × ${deviceScaleFactor} is ${deviceWidth}.`,
    );
  }

  const margin = cssLength(raw, 'pdf_margin', '0px');
  // Your own markup has no cookie banners or pop-ups, and hiding its fixed parts would spoil it.
  const cleanByDefault = html === null;
  return {
    url: html === null ? normalizeUrl(raw.url as string) : null,
    html,
    format,
    imageQuality: num(raw, 'image_quality', 80, 1, 100),
    fullPage,
    fullPageMaxHeight: num(raw, 'full_page_max_height', Math.min(10000, maxHeight), 100, maxHeight),
    device: device?.id ?? null,
    viewportWidth,
    viewportHeight: num(raw, 'viewport_height', device?.height ?? 800, 240, 2400),
    deviceScaleFactor,
    viewportMobile: bool(raw, 'viewport_mobile', device ? device.kind !== 'desktop' : false),
    waitUntil: waitUntil as WaitUntil,
    waitForSelector: str(raw, 'wait_for_selector'),
    delayMs: Math.round(num(raw, 'delay', 0, 0, 10, false) * 1000),
    timeoutMs: Math.round(num(raw, 'timeout', Math.min(30, maxTimeout), 5, maxTimeout, false) * 1000),
    selector,
    clip,
    hideSelectors: list(raw, 'hide_selectors', ','),
    blockCookieBanners: bool(raw, 'block_cookie_banners', cleanByDefault),
    blockPopups: bool(raw, 'block_popups', cleanByDefault),
    blockChats: bool(raw, 'block_chats', cleanByDefault),
    blockAds: bool(raw, 'block_ads', true),
    blockTrackers: bool(raw, 'block_trackers', true),
    blockRequests: list(raw, 'block_requests', ',', 100),
    blockResources,
    darkMode: bool(raw, 'dark_mode', false),
    reducedMotion: bool(raw, 'reduced_motion', false),
    mediaType: oneOf(raw, 'media_type', ['screen', 'print'] as const, null),
    omitBackground: bool(raw, 'omit_background', false),
    styles: str(raw, 'styles', MAX_CODE_LENGTH),
    scripts: str(raw, 'scripts', MAX_CODE_LENGTH),
    click: list(raw, 'click', /\n/, 10),
    headers,
    cookies: cookieList(raw, html !== null),
    userAgent,
    // The browser weighs the languages itself, in the order given.
    acceptLanguage: acceptLanguage?.split(',').map((l) => l.split(';')[0]!.trim()).join(',') ?? null,
    timeZone,
    pdf: {
      paperFormat: oneOf(raw, 'pdf_paper_format', PAPER_FORMATS, 'letter'),
      landscape: bool(raw, 'pdf_landscape', false),
      printBackground: bool(raw, 'pdf_print_background', true),
      fitOnePage: bool(raw, 'pdf_fit_one_page', false),
      margin: {
        top: cssLength(raw, 'pdf_margin_top', margin),
        right: cssLength(raw, 'pdf_margin_right', margin),
        bottom: cssLength(raw, 'pdf_margin_bottom', margin),
        left: cssLength(raw, 'pdf_margin_left', margin),
      },
    },
    responseType: oneOf(raw, 'response_type', RESPONSE_TYPES as ResponseType[], 'by_format'),
    proxy: requestProxy(raw, proxyPolicy),
    retry: num(raw, 'retry', 1, 0, 2),
    failOnStatus: statusList(raw, 'fail_on_status'),
  };
}

/**
 * Compiles "block_requests" into one test. A plain host ("ads.example.com")
 * blocks that host and its subdomains; a pattern with * matches the whole URL,
 * with or without its scheme ("*.example.com/ads/*").
 */
export function requestPatterns(patterns: string[]): (url: string, host: string) => boolean {
  if (patterns.length === 0) return () => false;
  const hosts: string[] = [];
  const globs: RegExp[] = [];
  for (const p of patterns) {
    if (/^[a-z0-9.-]+$/i.test(p)) hosts.push(p.toLowerCase().replace(/^\.+|\.+$/g, ''));
    else globs.push(new RegExp(`^${p.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i'));
  }
  return (url, host) =>
    hosts.some((h) => host === h || host.endsWith(`.${h}`)) ||
    globs.some((g) => g.test(url) || g.test(url.replace(/^[a-z]+:\/\//i, '')));
}
