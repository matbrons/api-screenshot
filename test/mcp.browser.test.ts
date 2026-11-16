// MCP tool calls through the whole server: key check, options, URL guard and a
// real Chromium. Skipped when no Chrome or Chromium is installed.
//
// As in proxy.browser.test.ts, the "site" sits behind a small local test proxy,
// and the guard is told that site.example.com is public and every other name
// points at this machine, so nothing leaves it.

import type http from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { findChrome, startNodeBrowser, type NodeScreenshotter } from '../src/node-browser.ts';
import { parseProxyUrl } from '../src/proxy.ts';
import { readPng } from './helpers/png.ts';
import { startHttpProxy, startSite, type TestProxy } from './helpers/test-proxies.ts';

let chrome: string | null = null;
try {
  chrome = findChrome();
} catch {
  chrome = null;
}

const KEY = 'test-key-0123456789abcdef';
const resolve = async (host: string) => (host === 'site.example.com' ? ['93.184.215.14'] : ['127.0.0.1']);
const PAGE = `<!doctype html><html><head><title>A tall page</title></head><body style="margin:0">
  <p>${'This is the real content of the page, long enough to count as a page. '.repeat(30)}</p>
  <div style="height:6000px;background:#2050c0"></div></body></html>`;

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };

describe.skipIf(!chrome)('MCP tools in a real browser', () => {
  let site: http.Server;
  let upstream: TestProxy;
  let browser: NodeScreenshotter;
  let client: Client;

  beforeAll(async () => {
    site = startSite(PAGE);
    upstream = await startHttpProxy(site);
    browser = await startNodeBrowser({ proxies: [parseProxyUrl(upstream.url)], resolve, sandbox: false });
    const app = createApp({ screenshot: (opts) => browser.screenshot(opts), apiKey: KEY, cacheTtl: 0 });
    client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: async (url, init) => app.request(String(url), init),
      requestInit: { headers: { authorization: `Bearer ${KEY}` } },
    }));
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await browser?.close();
    await upstream?.close();
    site?.close();
  });

  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;
  const url = 'http://site.example.com:8080/';

  it('returns a full-page shot cut at 4000 px, and says it was cut', async () => {
    const res = await call('screenshot', { url, full_page: true, format: 'png', wait_until: 'load' });
    expect(res.isError).toBeFalsy();
    const [image, notes] = res.content;
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' });
    const png = readPng(Buffer.from(image!.data!, 'base64'));
    expect([png.width, png.height]).toEqual([1280, 4000]);
    expect(notes!.text).toContain('title: A tall page');
    expect(notes!.text).toContain('truncated: true');
  }, 40_000);

  it('refuses private addresses, given directly or by name', async () => {
    for (const target of ['http://127.0.0.1:8080/', 'http://intranet.example.com/', 'http://[::1]/']) {
      const res = await call('screenshot', { url: target, timeout: 10 });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(/^url_not_allowed: /);
    }
    expect(upstream.seen.filter((s) => !s.line.includes('93.184.215.14'))).toEqual([]);
  }, 40_000);

  it('page_details reads the page without an image', async () => {
    const res = await call('page_details', { url, wait_until: 'load' });
    expect(res.content).toHaveLength(1);
    expect(JSON.parse(res.content[0]!.text!)).toMatchObject({ title: 'A tall page', status: 200, final_url: url });
  }, 40_000);
});
