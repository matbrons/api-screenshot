// The OpenAPI document and the MCP tools are built from src/option-schema.ts.
// These tests fail when that file and parseOptions disagree: an option missing,
// a default, a range or a list of values that is not what the API does.

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { CACHE_OPTION_NAMES, DEFAULT_CACHE_TTL, takeCacheOptions } from '../src/cache.ts';
import { STATUS } from '../src/errors.ts';
import { toolSchemas } from '../src/mcp.ts';
import { DEVICE_IDS, optionSchemas, type JsonSchema, type OptionName } from '../src/option-schema.ts';
import { VERSION, openApiDocument } from '../src/openapi.ts';
import {
  DEFAULT_LIMITS, DEVICES, FORMATS, OPTION_NAMES, PAPER_FORMATS, RESOURCE_TYPES, RESPONSE_TYPES, WAIT_UNTIL, parseOptions,
} from '../src/options.ts';

const limits = { maxTimeoutSeconds: 45, maxFullPageHeight: 12000 };
const schemas = optionSchemas(limits, DEFAULT_CACHE_TTL);
const cacheNames = new Set<string>(CACHE_OPTION_NAMES);
const base = { url: 'https://example.com' };
/** Clip options only parse together with a width and a height. */
const baseFor = (name: string) => (name.startsWith('clip_') ? { ...base, clip_width: 10, clip_height: 10 } : base);
/** Reads raw options the way the API does: the cache options apart, the rest with parseOptions. */
const parse = (name: string, raw: Record<string, unknown>) =>
  cacheNames.has(name) ? takeCacheOptions(raw, DEFAULT_CACHE_TTL).cache : parseOptions(raw, limits);

function doc(settings: Partial<Parameters<typeof openApiDocument>[0]> = {}) {
  return openApiDocument({ limits, cacheTtl: DEFAULT_CACHE_TTL, apiKey: true, signing: false, origin: 'https://shots.example.com', ...settings }) as any;
}

describe('option schemas', () => {
  it('describe every option the API takes, and no other', () => {
    expect(Object.keys(schemas).sort()).toEqual([...OPTION_NAMES, ...CACHE_OPTION_NAMES].sort());
    for (const [name, schema] of Object.entries(schemas)) expect(schema.description, name).toBeTruthy();
  });

  it('list the same values parseOptions takes', () => {
    expect(schemas.format.enum).toEqual(Object.keys(FORMATS));
    expect(schemas.wait_until.enum).toEqual(WAIT_UNTIL);
    expect(schemas.response_type.enum).toEqual(RESPONSE_TYPES);
    expect(schemas.pdf_paper_format.enum).toEqual([...PAPER_FORMATS]);
    expect((schemas.block_resources.items as JsonSchema).enum).toEqual(RESOURCE_TYPES);
    expect(DEVICE_IDS).toHaveLength(Object.keys(DEVICES).length * 2);
    for (const name of ['format', 'wait_until', 'response_type', 'pdf_paper_format', 'viewport_device', 'media_type'] as const) {
      for (const value of schemas[name].enum as string[]) expect(() => parseOptions({ ...base, [name]: value }, limits), `${name}=${value}`).not.toThrow();
    }
  });

  it('give the defaults parseOptions uses', () => {
    for (const [name, schema] of Object.entries(schemas)) {
      if (!('default' in schema)) continue;
      expect(parse(name, { ...base, [name]: schema.default }), name).toEqual(parse(name, base));
    }
  });

  it('give the ranges parseOptions allows', () => {
    for (const [name, schema] of Object.entries(schemas)) {
      const { minimum: min, maximum: max } = schema as { minimum?: number; maximum?: number };
      if (min === undefined || max === undefined) continue;
      const step = schema.type === 'integer' ? 1 : 0.01;
      const raw = (v: number) => parse(name, { ...baseFor(name), [name]: v });
      expect(() => raw(min), `${name}=${min}`).not.toThrow();
      expect(() => raw(max), `${name}=${max}`).not.toThrow();
      expect(() => raw(min - step), `${name}=${min - step}`).toThrow();
      expect(() => raw(max + step), `${name}=${max + step}`).toThrow();
    }
  });
});

describe('/openapi.json', () => {
  it('has every option as a GET parameter and in the POST body', () => {
    const d = doc();
    const params = d.paths['/screenshot'].get.parameters.map((p: { name: string }) => p.name);
    for (const name of [...OPTION_NAMES, ...CACHE_OPTION_NAMES]) {
      expect(params, name).toContain(name);
      expect(d.components.schemas.Options.properties, name).toHaveProperty(name);
    }
  });

  it('has every error code and status', () => {
    const d = doc();
    expect(d.components.schemas.Error.properties.error.enum.sort()).toEqual(Object.keys(STATUS).sort());
    const responses = d.paths['/screenshot'].get.responses;
    for (const [code, status] of Object.entries(STATUS)) expect(responses[String(status)]?.description, code).toContain(code);
  });

  it('fills in this server\'s limits and ways in', () => {
    expect(doc().components.schemas.Options.properties.timeout).toMatchObject({ maximum: 45, default: 30 });
    expect(doc().paths['/screenshot'].get.security).toEqual([{ bearer: [] }, { apiKeyHeader: [] }]);
    expect(doc({ apiKey: false, signing: true }).paths['/screenshot'].get.security).toEqual([{ signature: [] }]);
    expect(doc({ apiKey: false }).paths['/screenshot'].get.security).toEqual([]);
    expect(doc().servers).toEqual([{ url: 'https://shots.example.com' }]);
  });

  it('is served without a key', async () => {
    const app = createApp({ screenshot: vi.fn(), apiKey: 'test-key-0123456789abcdef' });
    const res = await app.request('http://shots.example.com/openapi.json', { headers: { 'x-forwarded-proto': 'https' } });
    expect(res.status).toBe(200);
    const body = await res.json() as { openapi: string; servers: unknown };
    expect(body.openapi).toBe('3.1.0');
    expect(body.servers).toEqual([{ url: 'https://shots.example.com' }]);
  });

  it('carries the version in package.json', () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  });
});

describe('MCP tool schemas', () => {
  const tools = toolSchemas(DEFAULT_LIMITS, DEFAULT_CACHE_TTL);

  it('only use real options, with defaults the API takes', () => {
    for (const [tool, properties] of Object.entries(tools)) {
      for (const [name, schema] of Object.entries(properties)) {
        expect(schemas, `${tool}.${name}`).toHaveProperty(name);
        if ('default' in schema) expect(() => parse(name, { ...base, [name]: schema.default }), `${tool}.${name}`).not.toThrow();
      }
    }
    expect(Object.keys(tools.screenshot)).not.toContain('scripts' satisfies OptionName);
  });
});
