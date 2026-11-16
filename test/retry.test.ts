import { describe, expect, it, vi } from 'vitest';
import type { CaptureResult } from '../src/capture.ts';
import { CaptureError } from '../src/errors.ts';
import { parseOptions } from '../src/options.ts';
import { MIN_RETRY_MS, withRetries } from '../src/retry.ts';

const ok = (status = 200): CaptureResult => ({
  image: new Uint8Array([1]),
  contentType: 'image/png',
  info: { finalUrl: 'https://example.com/', status, removed: 0, consentManager: null, pageHeight: null, truncated: false, overlayRemaining: null },
});
const blocked = () => new CaptureError('blocked', 'example.com showed a bot check.', 'bot_check');
const proxyDown = () => new CaptureError('proxy_error', 'The proxy refused the connection.', 'proxy');

/** Runs the attempts in order: an error is thrown, a result returned. Each attempt may use up some time. */
function script(steps: Array<CaptureResult | CaptureError>, clock = { t: 0 }, spendMs = 0) {
  const fn = vi.fn(async (_opts: { timeoutMs: number }) => {
    clock.t += spendMs;
    const step = steps.shift();
    if (!step) throw new Error('no more steps');
    if (step instanceof CaptureError) throw step;
    return step;
  });
  return fn;
}

async function failure(promise: Promise<unknown>): Promise<CaptureError> {
  try {
    await promise;
  } catch (err) {
    return err as CaptureError;
  }
  throw new Error('expected a failure');
}

const opts = (extra: Record<string, unknown> = {}) => parseOptions({ url: 'https://example.com', timeout: 30, ...extra });

describe('withRetries', () => {
  it('retries a blocked page when another proxy is there to try', async () => {
    const attempt = script([blocked(), ok()]);
    const result = await withRetries(opts(), attempt, { anotherRoute: () => true });
    expect(result.info.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does not retry a blocked page from the same address', async () => {
    const attempt = script([blocked(), ok()]);
    expect(await failure(withRetries(opts(), attempt))).toMatchObject({ code: 'blocked', reason: 'bot_check' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries a failed proxy through the next, up to "retry" more times, then tells what happened', async () => {
    const attempt = script([proxyDown(), blocked(), proxyDown(), ok()]);
    const err = await failure(withRetries(opts({ retry: 2 }), attempt, { anotherRoute: () => true }));
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(err).toMatchObject({ code: 'proxy_error', status: 502 });
    expect(err.message).toMatch(/Tried 3 times: proxy_error \(proxy\), then blocked \(bot_check\), then proxy_error \(proxy\)\.$/);
  });

  it('does not retry with "retry" 0', async () => {
    const attempt = script([proxyDown(), ok()]);
    await failure(withRetries(opts({ retry: 0 }), attempt, { anotherRoute: () => true }));
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries a browser that stopped, a blank page or a timeout, even without another proxy', async () => {
    for (const err of [
      new CaptureError('internal', 'The browser stopped during the capture. Try again.', 'browser_stopped'),
      new CaptureError('blank', 'example.com rendered an empty page.', 'blank'),
      new CaptureError('timeout', 'The page did not load in time.', 'navigation'),
    ]) {
      const attempt = script([err, ok()]);
      expect((await withRetries(opts(), attempt)).info.status).toBe(200);
    }
  });

  it('never retries what another try would not change', async () => {
    for (const err of [
      new CaptureError('url_not_allowed', 'This address is not allowed.', 'ssrf'),
      new CaptureError('unreachable', 'The site could not be reached.', 'dns'),
      new CaptureError('error_page', 'example.com answered 404.', 'http_404'),
      new CaptureError('internal', 'The capture failed.'),
    ]) {
      const attempt = script([err, ok()]);
      expect(await failure(withRetries(opts(), attempt, { anotherRoute: () => true }))).toBe(err);
      expect(attempt).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps every try within the request timeout', async () => {
    const clock = { t: 0 };
    const now = () => clock.t;
    // The first try used 25 of 30 seconds: too little is left to start another.
    const late = script([proxyDown(), ok()], clock, 25_000);
    await failure(withRetries(opts(), late, { anotherRoute: () => true, now }));
    expect(late).toHaveBeenCalledTimes(1);

    // The first try failed fast: the second gets the time that is left, not a fresh 30 seconds.
    clock.t = 0;
    const fast = script([proxyDown(), ok()], clock, 30_000 - MIN_RETRY_MS - 2000);
    await withRetries(opts(), fast, { anotherRoute: () => true, now });
    expect(fast.mock.calls.map(([o]) => o.timeoutMs)).toEqual([30_000, MIN_RETRY_MS + 2000]);
  });
});

describe('fail_on_status', () => {
  it('reads statuses and ranges', () => {
    expect(opts().failOnStatus).toEqual([]);
    expect(opts({ fail_on_status: '404, 500-503' }).failOnStatus).toEqual([404, 500, 501, 502, 503]);
    expect(opts({ fail_on_status: [403, '429'] }).failOnStatus).toEqual([403, 429]);
    for (const bad of ['abc', '99', '600', '503-500', [true], '4044']) {
      expect(() => opts({ fail_on_status: bad }), String(bad)).toThrow(/fail_on_status/);
    }
  });

  it('turns a listed status into an error_page instead of a shot, without retrying', async () => {
    const attempt = script([ok(403), ok(200)]);
    const err = await failure(withRetries(opts({ fail_on_status: '403' }), attempt, { anotherRoute: () => true }));
    expect(err).toMatchObject({ code: 'error_page', reason: 'http_403', status: 422 });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect((await withRetries(opts({ fail_on_status: '404' }), script([ok(200)]))).info.status).toBe(200);
  });
});

describe('the "retry" option', () => {
  it('defaults to 1 and takes 0 to 2', () => {
    expect(opts().retry).toBe(1);
    expect(opts({ retry: '0' }).retry).toBe(0);
    expect(opts({ retry: 2 }).retry).toBe(2);
    expect(() => opts({ retry: 3 })).toThrow(/"retry" must be a whole number from 0 to 2/);
  });
});
