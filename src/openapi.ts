// The OpenAPI 3.1 description served at /openapi.json, built from the same
// option schemas the MCP tools use (src/option-schema.ts), with this server's
// limits and ways in filled in.

import { STATUS, type ErrorCode } from './errors.ts';
import { optionSchemas, type JsonSchema } from './option-schema.ts';
import type { Limits } from './options.ts';
import { REPEATABLE_OPTIONS } from './options.ts';

/** Kept equal to package.json by a test. */
export const VERSION = '0.1.2';

interface OpenApiSettings {
  limits: Limits;
  cacheTtl: number;
  /** Which ways in this server takes. All false means public access. */
  apiKey: boolean;
  signing: boolean;
  /** Where this server answers, such as https://shots.example.com. */
  origin: string;
}

const ERROR_TEXT: Record<number, string> = {
  400: 'The options are wrong.',
  401: 'The API key is missing or wrong, or the signature is.',
  403: 'The URL, a redirect or the proxy points somewhere not allowed.',
  422: 'The page loaded, but a shot of it would not be honest: a bot wall or captcha, a blank page, an error page, a selector that matched nothing, or a script that failed.',
  429: "The platform's browser time for today is used up.",
  500: 'The capture failed.',
  502: 'The site or the proxy could not be reached.',
  503: 'No browser free right now, no browser at all, or the server is not set up yet.',
  504: 'The capture ran past timeout.',
};

const ERROR_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['error', 'message'],
  properties: {
    error: { type: 'string', enum: Object.keys(STATUS), description: 'A stable code to act on.' },
    message: { type: 'string', description: 'What went wrong, for people.' },
    reason: { type: 'string', description: 'A short detail, such as captcha or http_503.' },
  },
};

const DETAILS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    url: { type: ['string', 'null'], description: 'The URL asked for, or null for html.' },
    final_url: { type: 'string', description: 'Where the page ended up after redirects.' },
    status: { type: ['integer', 'null'], description: "The page's HTTP status." },
    title: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    icon: { type: ['string', 'null'] },
    open_graph: { type: 'object', additionalProperties: { type: 'string' } },
    page_height: { type: ['integer', 'null'], description: 'The full height of the page, in CSS pixels.' },
    removed_elements: { type: 'integer', description: 'Banners, pop-ups and widgets taken off the page.' },
    consent_manager: { type: ['string', 'null'], description: 'The cookie banner found, by name.' },
    overlay_remaining: { type: ['string', 'null'], description: 'A banner or overlay that could not be removed.' },
    truncated: { type: 'boolean', description: 'The page was taller than the shot.' },
    content_type: { type: 'string', description: 'With response_type=json.' },
    size: { type: 'integer', description: 'Bytes of the file, with response_type=json.' },
    image: { type: 'string', contentEncoding: 'base64', description: 'The file in base64, with response_type=json.' },
  },
};

const header = (description: string, type = 'string') => ({ description, schema: { type } });

const SHOT_HEADERS = {
  'x-cache': header('HIT: from the cache. MISS: taken and stored. BYPASS: taken, cache not used.'),
  age: header('Seconds since a cached shot was taken.', 'integer'),
  'x-final-url': header('Where the page ended up after redirects.'),
  'x-target-status': header("The page's HTTP status.", 'integer'),
  'x-removed-elements': header('Banners, pop-ups and widgets taken off the page.', 'integer'),
  'x-consent-manager': header('The cookie banner found, by name.'),
  'x-page-height': header('The full height of the page, in CSS pixels.', 'integer'),
  'x-truncated': header('true when the page was taller than the shot.'),
  'x-overlay-remaining': header('A banner or overlay that could not be removed.'),
};

function errorResponses(): Record<string, unknown> {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const [code, status] of Object.entries(STATUS) as Array<[ErrorCode, number]>) {
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return Object.fromEntries(
    [...byStatus].sort(([a], [b]) => a - b).map(([status, codes]) => [
      String(status),
      {
        description: `${ERROR_TEXT[status] ?? 'An error.'} Codes: ${codes.join(', ')}.`,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    ]),
  );
}

export function openApiDocument(settings: OpenApiSettings): Record<string, unknown> {
  const options = optionSchemas(settings.limits, settings.cacheTtl);
  const ok = {
    description: 'The shot, or page details with response_type=json or metadata.',
    headers: SHOT_HEADERS,
    content: {
      'image/png': { schema: { type: 'string', format: 'binary' } },
      'image/jpeg': { schema: { type: 'string', format: 'binary' } },
      'image/webp': { schema: { type: 'string', format: 'binary' } },
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
      'application/json': { schema: { $ref: '#/components/schemas/Details' } },
    },
  };
  const responses = { '200': ok, ...errorResponses() };
  const keyed = [{ bearer: [] }, { apiKeyHeader: [] }];
  const security = settings.apiKey ? keyed : [];
  const signed = settings.signing ? [{ signature: [] }] : [];
  const open = !settings.apiKey && !settings.signing;

  const query = Object.entries(options).map(([name, schema]) => {
    const { description, ...rest } = schema;
    return {
      name, in: 'query', description, schema: rest,
      ...(name === 'url' ? { example: 'https://example.com' } : {}),
      ...(REPEATABLE_OPTIONS.has(name) ? { style: 'form', explode: true } : {}),
    };
  });
  const signingParams = settings.signing
    ? [
        { name: 'expires', in: 'query', description: 'Unix seconds after which a signed URL stops working.', schema: { type: 'integer' } },
      ]
    : [];

  return {
    openapi: '3.1.0',
    info: {
      title: 'API Screenshot',
      version: VERSION,
      description:
        'Full-page screenshots of real sites, with cookie banners, pop-ups and chat widgets removed. ' +
        'A bot wall, captcha, error page or blank page is an error, never a shot. ' +
        'AI agents can also use it over MCP at /mcp.',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: settings.origin }],
    paths: {
      '/screenshot': {
        get: {
          operationId: 'getScreenshot',
          summary: 'Take a screenshot, with the options in the query string',
          parameters: [...query, ...signingParams],
          security: open ? [] : [...security, ...signed],
          responses,
        },
        post: {
          operationId: 'postScreenshot',
          summary: 'Take a screenshot, with the options in a JSON body',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Options' },
                example: { url: 'https://example.com', full_page: true },
              },
            },
          },
          security: open ? [] : security,
          responses,
        },
      },
      '/health': {
        get: {
          operationId: 'health',
          summary: 'Answers while the server is up',
          security: [],
          responses: {
            '200': { description: 'Up.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true } } } } } },
          },
        },
      },
    },
    components: {
      schemas: {
        Options: {
          type: 'object',
          properties: options,
          additionalProperties: false,
          anyOf: [{ required: ['url'] }, { required: ['html'] }],
        },
        Details: DETAILS_SCHEMA,
        Error: ERROR_SCHEMA,
      },
      securitySchemes: {
        ...(settings.apiKey
          ? {
              bearer: { type: 'http', scheme: 'bearer', description: 'The API key as a bearer token.' },
              apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
            }
          : {}),
        ...(settings.signing
          ? { signature: { type: 'apiKey', in: 'query', name: 'signature', description: 'An HMAC-SHA256 of the other query parameters, made with SIGNING_SECRET. See the README.' } }
          : {}),
      },
    },
  };
}
