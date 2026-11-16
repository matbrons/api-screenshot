// The MCP server at /mcp: two tools, "screenshot" and "page_details", for AI
// agents. Each call goes through the same option checks, URL guard, cache and
// browser as GET /screenshot; src/app.ts checks the key before a request gets
// here. It keeps no sessions: every HTTP request is answered on its own, so it
// runs the same on a Worker and on a server.

import { McpServer, createMcpHandler, type CallToolResult, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { CachedShot } from './cache.ts';
import { jsonBody, toBase64 } from './details.ts';
import { CaptureError } from './errors.ts';
import { VERSION } from './openapi.ts';
import { optionSchemas, type JsonSchema, type OptionName } from './option-schema.ts';
import type { Limits, ScreenshotOptions } from './options.ts';

/** Takes a shot from raw request options, exactly as /screenshot does. */
export type Shoot = (raw: Record<string, unknown>, signal: AbortSignal) => Promise<{ opts: ScreenshotOptions; shot: CachedShot }>;

/** The largest image a tool returns. Bigger ones are refused by AI clients or cost the whole context. */
export const MAX_TOOL_IMAGE_BYTES = 3 * 1024 * 1024;
/** The tallest image a tool returns, in pixels. AI clients refuse images over 8000 px on a side. */
const MAX_TOOL_IMAGE_HEIGHT = 8000;
const TOOL_FULL_PAGE_HEIGHT = 4000;
/** Room for a large "html" in a request body. */
const MAX_MCP_BODY_BYTES = 2 * 1024 * 1024;

const SCREENSHOT_OPTIONS = [
  'url', 'full_page', 'full_page_max_height', 'viewport_device', 'viewport_width', 'viewport_height',
  'format', 'image_quality', 'selector', 'hide_selectors', 'click', 'dark_mode',
  'block_cookie_banners', 'block_popups', 'block_chats', 'block_ads', 'block_trackers',
  'wait_until', 'wait_for_selector', 'delay', 'timeout', 'fresh',
] as const satisfies readonly OptionName[];

const DETAILS_OPTIONS = [
  'url', 'viewport_device', 'block_cookie_banners', 'block_popups', 'wait_until', 'wait_for_selector', 'delay', 'timeout', 'fresh',
] as const satisfies readonly OptionName[];

const SCREENSHOT_DESCRIPTION = `Takes a screenshot of a web page in a real browser and returns it as an image, with cookie banners, pop-ups, chat widgets and ads removed. Use it to see how a page looks today: a design, a layout, a bug, what a site shows.

By default you get the first screen, 1280 by 800, as JPEG. Set full_page for the whole page; it is cut off at full_page_max_height (4000 px unless set, at most 8000). Images have one pixel per CSS pixel and are at most about 3 MB. Most clients scale a tall image down until small text is hard to read, so to read text prefer the first screen, a selector for one part of the page, or a phone viewport_device.

Next to the image comes a short text: the final URL after redirects, the page's HTTP status, its title, how many banners and pop-ups were removed, and whether the page was cut off.

When the site shows a bot wall or captcha, answers with an error page, or renders blank, you get an error that says so instead of an image. Trying the same request again rarely helps. Only public http and https addresses work.`;

const DETAILS_DESCRIPTION = `Loads a web page in a real browser and returns its details as JSON, without an image: the final URL after redirects, the HTTP status, title, description, icon, Open Graph tags and the full page height in CSS pixels. Use it to check where a link ends up, whether a page is up, or what it says about itself, when you don't need to see it.

A bot wall, captcha, error page or blank page comes back as an error that says so. Only public http and https addresses work.`;

/** A tool's input schema: the JSON Schema clients see, and a check that refuses names it doesn't list. parseOptions checks the values. */
function toolInput(properties: Record<string, JsonSchema>): StandardSchemaWithJSON {
  const schema = { type: 'object', properties, required: ['url'], additionalProperties: false };
  return {
    '~standard': {
      version: 1,
      vendor: 'api-screenshot',
      validate: (value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'The arguments must be an object.' }] };
        const unknown = Object.keys(value).filter((k) => !(k in properties));
        if (unknown.length) return { issues: [{ message: 'not an option of this tool.', path: [unknown[0]!] }] };
        return { value: value as Record<string, unknown> };
      },
      jsonSchema: { input: () => schema, output: () => schema },
    },
  } as StandardSchemaWithJSON;
}

function pick(all: Record<OptionName, JsonSchema>, names: readonly OptionName[]): Record<string, JsonSchema> {
  return Object.fromEntries(names.map((n) => [n, all[n]]));
}

/** Lists are plain arrays here: some clients don't take a schema with more than one type. */
const array = (schema: JsonSchema): JsonSchema => ({ ...schema, type: 'array' });

export function toolSchemas(limits: Limits, cacheTtl: number) {
  const all = optionSchemas(limits, cacheTtl);
  const maxHeight = Math.min(MAX_TOOL_IMAGE_HEIGHT, limits.maxFullPageHeight);
  const url = { type: 'string', description: 'The page, such as https://example.com. https:// is added when missing.', maxLength: 2048 };
  return {
    screenshot: {
      ...pick(all, SCREENSHOT_OPTIONS),
      url,
      format: { type: 'string', enum: ['jpeg', 'png', 'webp'], default: 'jpeg', description: 'jpeg is smallest; png for sharp text and flat colours.' },
      full_page_max_height: { ...all.full_page_max_height, maximum: maxHeight, default: Math.min(TOOL_FULL_PAGE_HEIGHT, maxHeight) },
      hide_selectors: array(all.hide_selectors),
      click: array(all.click),
    },
    page_details: { ...pick(all, DETAILS_OPTIONS), url },
  };
}

function toolError(err: unknown): CallToolResult {
  const e = err instanceof CaptureError ? err : new CaptureError('internal', 'The capture failed.');
  if (!(err instanceof CaptureError)) console.error('mcp tool failed', err);
  return { isError: true, content: [{ type: 'text', text: `${e.code}: ${e.message}${e.reason ? ` (${e.reason})` : ''}` }] };
}

function kb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** The text that goes with a shot: what an agent needs to read it right. */
function shotNotes(opts: ScreenshotOptions, shot: CachedShot): string {
  const { info } = shot.result;
  const lines = [
    `final_url: ${info.finalUrl}`,
    `status: ${info.status ?? 'unknown'}`,
    ...(info.metadata?.title ? [`title: ${info.metadata.title}`] : []),
    `removed_elements: ${info.removed}${info.consentManager ? ` (cookie banner: ${info.consentManager})` : ''}`,
  ];
  if (info.overlayRemaining) lines.push(`overlay_remaining: ${info.overlayRemaining} (still on the page)`);
  if (info.pageHeight !== null) lines.push(`page_height: ${info.pageHeight}`);
  if (info.truncated) lines.push(`truncated: true (the page is taller than the shot; raise full_page_max_height or use selector)`);
  lines.push(`image: ${opts.format}, ${kb(shot.result.image.length)}`);
  lines.push(shot.status === 'HIT' ? `cache: taken ${shot.age} s ago (fresh=true for a new one)` : 'cache: new shot');
  return lines.join('\n');
}

/** A fresh MCP server for one HTTP request, its tools bound to that request's abort signal. */
function buildServer(shoot: Shoot, limits: Limits, cacheTtl: number, requestSignal: AbortSignal): McpServer {
  const server = new McpServer(
    { name: 'api-screenshot', title: 'API Screenshot', version: VERSION },
    { instructions: 'Screenshots and page details of public web pages, taken in a real browser with cookie banners and pop-ups removed.' },
  );
  const schemas = toolSchemas(limits, cacheTtl);
  const signalFor = (ctx: { mcpReq: { signal: AbortSignal } }) => AbortSignal.any([ctx.mcpReq.signal, requestSignal]);
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

  server.registerTool(
    'screenshot',
    { title: 'Screenshot a web page', description: SCREENSHOT_DESCRIPTION, inputSchema: toolInput(schemas.screenshot), annotations },
    async (args, ctx) => {
      try {
        const raw = {
          format: 'jpeg',
          full_page_max_height: schemas.screenshot.full_page_max_height.default,
          ...(args as Record<string, unknown>),
          // One pixel per CSS pixel keeps the image within what clients take.
          device_scale_factor: 1,
        };
        if (String(raw.format).toLowerCase() === 'pdf') throw new CaptureError('invalid_options', '"format" must be jpeg, png or webp.');
        const height = Number(raw.full_page_max_height);
        if (Number.isFinite(height) && height > MAX_TOOL_IMAGE_HEIGHT) {
          throw new CaptureError('invalid_options', `"full_page_max_height" can be at most ${MAX_TOOL_IMAGE_HEIGHT} here.`);
        }
        const { opts, shot } = await shoot(raw, signalFor(ctx));
        const { image, contentType } = shot.result;
        if (image.length > MAX_TOOL_IMAGE_BYTES) {
          throw new CaptureError(
            'invalid_options',
            `The shot is ${kb(image.length)}, more than the ${kb(MAX_TOOL_IMAGE_BYTES)} a tool result can carry. ` +
              'Use format jpeg, a lower image_quality or full_page_max_height, or a selector.',
            'too_large',
          );
        }
        return {
          content: [
            { type: 'image', data: toBase64(image), mimeType: contentType },
            { type: 'text', text: shotNotes(opts, shot) },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'page_details',
    { title: 'Details of a web page', description: DETAILS_DESCRIPTION, inputSchema: toolInput(schemas.page_details), annotations },
    async (args, ctx) => {
      try {
        const { opts, shot } = await shoot({ ...(args as Record<string, unknown>), response_type: 'metadata' }, signalFor(ctx));
        return { content: [{ type: 'text', text: JSON.stringify(jsonBody(opts, shot.result), null, 2) }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );
  return server;
}

/** Answers one HTTP request to /mcp. The caller has already checked the key. */
export function handleMcp(request: Request, shoot: Shoot, limits: Limits, cacheTtl: number): Promise<Response> {
  const handler = createMcpHandler(() => buildServer(shoot, limits, cacheTtl, request.signal), {
    maxRequestBodySize: MAX_MCP_BODY_BYTES,
    onerror: (err) => console.error('mcp:', err.message),
  });
  return handler.fetch(request);
}
