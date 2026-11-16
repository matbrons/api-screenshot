import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { createApp, type AppConfig } from '../src/app.ts';
import type { CaptureResult } from '../src/capture.ts';
import { CaptureError } from '../src/errors.ts';
import { MAX_TOOL_IMAGE_BYTES } from '../src/mcp.ts';
import type { ScreenshotOptions } from '../src/options.ts';

const KEY = 'test-key-0123456789abcdef';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const result: CaptureResult = {
  image: JPEG,
  contentType: 'image/jpeg',
  info: {
    finalUrl: 'https://example.com/', status: 200, removed: 2, consentManager: 'Example CMP', pageHeight: 3000, truncated: false,
    overlayRemaining: null,
    metadata: { title: 'Example Domain', description: 'A page.', openGraph: {}, icon: null, height: 3000 },
  },
};

function setup(config: Partial<AppConfig> = {}) {
  const screenshot = vi.fn(async (_opts: ScreenshotOptions, _signal: AbortSignal) => result);
  const app = createApp({ screenshot, apiKey: KEY, ...config });
  return { app, screenshot };
}

/** A raw JSON-RPC call to /mcp, as a 2025-era client sends it. */
function rpc(app: ReturnType<typeof createApp>, headers: Record<string, string> = {}) {
  return app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }),
  });
}

/** A real MCP client, talking to the app in-process. */
async function connect(app: ReturnType<typeof createApp>, opts: { key?: string; modern?: boolean } = {}) {
  const client = new Client(
    { name: 'test', version: '1' },
    opts.modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: async (url, init) => app.request(String(url), init),
    requestInit: { headers: opts.key === undefined ? { authorization: `Bearer ${KEY}` } : opts.key ? { authorization: `Bearer ${opts.key}` } : {} },
  });
  await client.connect(transport);
  return client;
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };

describe('/mcp access', () => {
  it('refuses a request without the key, with a bearer challenge', async () => {
    const { app, screenshot } = setup();
    const res = await rpc(app);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer /);
    expect(await res.json()).toMatchObject({ error: 'unauthorized' });
    expect((await rpc(app, { authorization: 'Bearer wrong-key-0123456789' })).status).toBe(401);
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('lets in the key as a bearer token or X-API-Key', async () => {
    const { app } = setup();
    expect((await rpc(app, { authorization: `Bearer ${KEY}` })).status).toBe(200);
    expect((await rpc(app, { 'x-api-key': KEY })).status).toBe(200);
  });

  it('refuses everything when no key is set and public access is off', async () => {
    const { app } = setup({ apiKey: undefined });
    const res = await rpc(app);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'not_configured' });
  });

  it('needs no key with public access on', async () => {
    const { app } = setup({ apiKey: undefined, allowPublicAccess: true });
    expect((await rpc(app)).status).toBe(200);
  });

  it('takes the key only, not a signed URL', async () => {
    const signedOnly = setup({ apiKey: undefined, signingSecret: 'signing-secret-0123456789' }).app;
    expect((await rpc(signedOnly)).status).toBe(401);
    const res = await setup().app.request('/mcp?signature=abc', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('refuses a real client with the wrong key', async () => {
    const { app } = setup();
    await expect(connect(app, { key: 'wrong-key-0123456789' })).rejects.toThrow();
  });
});

describe('/mcp tools', () => {
  for (const modern of [false, true]) {
    it(`lists screenshot and page_details (${modern ? '2026' : '2025'} protocol)`, async () => {
      const client = await connect(setup().app, { modern });
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['page_details', 'screenshot']);
      const shot = tools.find((t) => t.name === 'screenshot')!;
      expect(shot.inputSchema).toMatchObject({ type: 'object', required: ['url'] });
      expect(Object.keys(shot.inputSchema.properties!)).toEqual(expect.arrayContaining(['url', 'full_page', 'format', 'selector']));
      expect(shot.description!.length).toBeLessThan(2000);
      expect(shot.annotations).toMatchObject({ readOnlyHint: true });
      await client.close();
    });

    it(`returns the image and its notes (${modern ? '2026' : '2025'} protocol)`, async () => {
      const { app, screenshot } = setup();
      const client = await connect(app, { modern });
      const res = (await client.callTool({ name: 'screenshot', arguments: { url: 'example.com', full_page: true } })) as ToolResult;
      expect(res.isError).toBeFalsy();
      expect(res.content[0]).toEqual({ type: 'image', data: Buffer.from(JPEG).toString('base64'), mimeType: 'image/jpeg' });
      expect(res.content[1]!.text).toContain('final_url: https://example.com/');
      expect(res.content[1]!.text).toContain('title: Example Domain');
      expect(res.content[1]!.text).toContain('removed_elements: 2');
      // A JPEG at one pixel per CSS pixel, cut at 4000 px, unless asked otherwise.
      expect(screenshot.mock.calls[0]![0]).toMatchObject({
        url: 'https://example.com/', fullPage: true, format: 'jpeg', deviceScaleFactor: 1, fullPageMaxHeight: 4000,
      });
      await client.close();
    });
  }

  it('keeps a device preset at one pixel per CSS pixel', async () => {
    const { app, screenshot } = setup();
    const client = await connect(app);
    await client.callTool({ name: 'screenshot', arguments: { url: 'example.com', viewport_device: 'iphone_15' } });
    expect(screenshot.mock.calls[0]![0]).toMatchObject({ device: 'iphone_15', viewportWidth: 393, deviceScaleFactor: 1, viewportMobile: true });
    await client.close();
  });

  it('says what went wrong instead of returning an image', async () => {
    const { app, screenshot } = setup();
    screenshot.mockRejectedValueOnce(new CaptureError('blocked', 'The site showed a captcha instead of the page.', 'captcha'));
    const client = await connect(app);
    const res = (await client.callTool({ name: 'screenshot', arguments: { url: 'example.com' } })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: 'text', text: 'blocked: The site showed a captcha instead of the page. (captcha)' }]);
    await client.close();
  });

  it('refuses wrong options, PDFs and shots too tall or too big for a client', async () => {
    const { app, screenshot } = setup();
    const client = await connect(app);
    const call = async (args: Record<string, unknown>) =>
      ((await client.callTool({ name: 'screenshot', arguments: { url: 'example.com', ...args } })) as ToolResult);
    expect((await call({ viewport_width: 99999 })).content[0]!.text).toMatch(/^invalid_options: "viewport_width"/);
    expect((await call({ format: 'pdf' })).isError).toBe(true);
    expect((await call({ full_page_max_height: 9000 })).isError).toBe(true);
    expect(screenshot).not.toHaveBeenCalled();
    screenshot.mockResolvedValueOnce({ ...result, image: new Uint8Array(MAX_TOOL_IMAGE_BYTES + 1) });
    expect((await call({})).content[0]!.text).toMatch(/^invalid_options: The shot is .* \(too_large\)$/);
    await client.close();
  });

  it('refuses arguments it does not list', async () => {
    const client = await connect(setup().app);
    const res = await client.callTool({ name: 'screenshot', arguments: { url: 'example.com', scripts: 'alert(1)' } }).catch((err: Error) => err);
    expect(res instanceof Error ? res.message : (res as ToolResult).content[0]!.text).toMatch(/scripts/);
    await client.close();
  });

  it('page_details returns the details without an image', async () => {
    const { app, screenshot } = setup();
    const client = await connect(app);
    const res = (await client.callTool({ name: 'page_details', arguments: { url: 'example.com' } })) as ToolResult;
    expect(res.content).toHaveLength(1);
    expect(JSON.parse(res.content[0]!.text!)).toMatchObject({ final_url: 'https://example.com/', status: 200, title: 'Example Domain' });
    expect(screenshot.mock.calls[0]![0]).toMatchObject({ responseType: 'metadata' });
    await client.close();
  });
});
