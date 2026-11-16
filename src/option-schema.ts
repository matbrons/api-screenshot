// A JSON Schema for every request option, for the OpenAPI document and the MCP
// tools. parseOptions (src/options.ts) stays the one place options are checked;
// test/openapi.test.ts fails when the two drift apart.

import { CACHE_OPTION_NAMES, MAX_CACHE_TTL } from './cache.ts';
import { DEVICES, FORMATS, MAX_DEVICE_WIDTH, OPTION_NAMES, PAPER_FORMATS, RESOURCE_TYPES, RESPONSE_TYPES, WAIT_UNTIL, type Limits } from './options.ts';

export type JsonSchema = Record<string, unknown>;
export type OptionName = (typeof OPTION_NAMES)[number] | (typeof CACHE_OPTION_NAMES)[number];

/** Every device preset id, each also with "_landscape". */
export const DEVICE_IDS = Object.keys(DEVICES).flatMap((id) => [id, `${id}_landscape`]);

const string = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'string', description, ...extra });
const flag = (description: string, value: boolean): JsonSchema => ({ type: 'boolean', default: value, description });
const whole = (description: string, minimum: number, maximum: number, value?: number): JsonSchema => ({
  type: 'integer', minimum, maximum, ...(value === undefined ? {} : { default: value }), description,
});
const decimal = (description: string, minimum: number, maximum: number, value: number): JsonSchema => ({
  type: 'number', minimum, maximum, default: value, description,
});
/** A list: a JSON array, or one string split on commas or new lines. */
const list = (description: string, maxItems: number, items: JsonSchema = { type: 'string' }): JsonSchema => ({
  type: ['array', 'string'], items, maxItems, description,
});
const margin = (side: string): JsonSchema => string(`The ${side} margin, such as 20px. Overrides pdf_margin for that side.`);

/** The schema of each option, with this server's limits filled in. */
export function optionSchemas(limits: Limits, defaultCacheTtl: number): Record<OptionName, JsonSchema> {
  const maxHeight = limits.maxFullPageHeight;
  const maxTimeout = limits.maxTimeoutSeconds;
  return {
    url: string('The page to shoot. https:// is added when missing. Required unless html is given.', { format: 'uri', maxLength: 2048 }),
    html: string('Markup to render instead of a url, up to a million characters. Banner and pop-up removal are off for it unless turned on.', { maxLength: 1_000_000 }),
    format: { type: 'string', enum: Object.keys(FORMATS), default: 'png', description: 'The file to return. jpg is the same as jpeg.' },
    image_quality: whole('Quality for jpeg and webp.', 1, 100, 80),
    response_type: {
      type: 'string', enum: RESPONSE_TYPES, default: 'by_format',
      description: 'by_format: the file itself. json: page details and the file in base64. metadata: page details only, no shot.',
    },
    full_page: flag('The whole page instead of the first screen.', false),
    full_page_max_height: whole('Cut a full-page shot off here, in CSS pixels.', 100, maxHeight, Math.min(10000, maxHeight)),
    viewport_device: {
      type: 'string', enum: DEVICE_IDS,
      description: "A device's screen size, scale and user agent. The viewport_* options still change single values.",
    },
    viewport_width: whole('Viewport width in CSS pixels.', 240, 3840, 1280),
    viewport_height: whole('Viewport height in CSS pixels.', 240, 2400, 800),
    device_scale_factor: decimal(
      `Device pixels per CSS pixel. 2 gives sharp text for retina screens. The width times this can be at most ${MAX_DEVICE_WIDTH}.`,
      0.5, 3, 1,
    ),
    viewport_mobile: flag('Mobile user agent and touch.', false),
    wait_until: { type: 'string', enum: WAIT_UNTIL, default: 'networkidle2', description: 'When the page counts as loaded.' },
    wait_for_selector: string('Wait until this CSS selector is on the page.', { maxLength: 500 }),
    delay: decimal('Extra seconds to wait before the shot.', 0, 10, 0),
    timeout: decimal('Seconds for the whole capture.', 5, maxTimeout, Math.min(30, maxTimeout)),
    selector: string('Shoot only the element this CSS selector matches.', { maxLength: 500 }),
    clip_x: whole('Left edge of a clip, in CSS pixels.', 0, 10000),
    clip_y: whole('Top edge of a clip, in CSS pixels.', 0, maxHeight),
    clip_width: whole('Width of a clip. Needs clip_height; not with full_page or selector.', 1, 3840),
    clip_height: whole('Height of a clip. Needs clip_width; not with full_page or selector.', 1, maxHeight),
    hide_selectors: list('CSS selectors to hide. A string is split on commas.', 50),
    block_cookie_banners: flag('Dismiss cookie banners, refusing consent where the site allows it. Off for html unless set.', true),
    block_popups: flag('Remove newsletter pop-ups, modals and sticky overlays. Off for html unless set.', true),
    block_chats: flag('Remove chat widgets and other corner widgets (the reCAPTCHA badge, push prompts). Off for html unless set.', true),
    block_ads: flag('Block ad requests and the empty ad boxes they leave, using EasyList.', true),
    block_trackers: flag('Block tracking scripts and pixels, using EasyPrivacy.', true),
    block_requests: list('Requests not to load: a host blocks it and its subdomains; a pattern with * matches the whole URL. A string is split on commas.', 100),
    block_resources: list('Kinds of request not to load. A string is split on commas.', RESOURCE_TYPES.length, { type: 'string', enum: RESOURCE_TYPES }),
    dark_mode: flag('Ask the page for its dark theme.', false),
    reduced_motion: flag('Ask the page to turn off animations.', false),
    media_type: { type: 'string', enum: ['screen', 'print'], description: 'The CSS media type. A PDF uses print unless set.' },
    omit_background: flag('Transparent background where the page has none (png, webp and pdf).', false),
    styles: string('CSS added to the page.', { maxLength: 100_000 }),
    scripts: string('JavaScript run in the page before the shot, after clicks. It may use await.', { maxLength: 100_000 }),
    click: list('CSS selectors to click, in order, before the shot. A string is split on new lines.', 10),
    headers: {
      type: ['array', 'string', 'object'], items: { type: 'string' }, additionalProperties: { type: 'string' }, maxItems: 30,
      description: 'Extra request headers for the page\'s own site: "Name: value" lines, or an object. Host, Cookie, User-Agent and connection headers are refused.',
    },
    cookies: list('Cookies set before the page loads, such as "name=value; Domain=example.com; Path=/; Secure". A string is split on new lines.', 50),
    user_agent: string('The user agent to send, in place of the browser\'s own.', { maxLength: 500 }),
    accept_language: string('Languages in order, such as de-DE,de.', { maxLength: 200 }),
    time_zone: string('An IANA time zone such as Europe/Berlin.', { maxLength: 100 }),
    pdf_paper_format: { type: 'string', enum: [...PAPER_FORMATS], default: 'letter', description: 'Paper size for a PDF.' },
    pdf_landscape: flag('Turn the paper sideways.', false),
    pdf_print_background: flag('Print background colours and images.', true),
    pdf_fit_one_page: flag('One page as wide as the viewport and as tall as the page, cut at full_page_max_height.', false),
    pdf_margin: string('Margin on every side, such as 20px, 1cm, 0.5in or 10mm.', { default: '0' }),
    pdf_margin_top: margin('top'),
    pdf_margin_right: margin('right'),
    pdf_margin_bottom: margin('bottom'),
    pdf_margin_left: margin('left'),
    proxy: string('A proxy for this shot, such as http://user:pass@proxy.example.com:8080. Only on a server that allows it.'),
    retry: whole('More tries after a browser crash, a timeout or a blank page. All tries share timeout.', 0, 2, 1),
    fail_on_status: {
      type: ['string', 'array'], items: { type: 'integer', minimum: 100, maximum: 599 }, maxItems: 50,
      description: 'HTTP statuses that fail the request with error_page, such as "404,500-599".',
    },
    cache_ttl: whole('Seconds a cached shot may be reused, and how long a new one is kept. 0 takes a new shot and keeps nothing.', 0, MAX_CACHE_TTL, defaultCacheTtl),
    fresh: flag('Take a new shot even when one is cached, and keep it in place of the old one.', false),
    cache_key: string('Any text, to keep a separate copy of the same shot.', { maxLength: 200 }),
    cache: flag('false is the same as cache_ttl=0.', true),
  };
}
