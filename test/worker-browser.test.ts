import { describe, expect, it, vi } from 'vitest';
import { CaptureError, msUntilUtcMidnight, toCaptureError } from '../src/errors.ts';
import {
  getBrowser,
  isDailyLimit,
  keepAliveSeconds,
  keepRetryAfter,
  LaunchRefused,
  retryAfterMs,
  type BrowserRun,
} from '../src/worker-browser.ts';

type Fake = { id: string };

/** What Cloudflare's puppeteer throws when a launch gets a 429. */
const RATE_LIMITED = 'Unable to create new browser: code: 429: message: Rate limit exceeded';

/** 15 Nov 2026, 14:00 UTC: ten hours before the daily reset. */
const AFTERNOON = Date.UTC(2026, 10, 15, 14);

/** A fake Browser Rendering account with a clock that only moves when the code sleeps. */
function fakeRun(overrides: Partial<BrowserRun<Fake>> = {}, start = 0) {
  let clock = start;
  const run: BrowserRun<Fake> = {
    sessions: vi.fn(async () => []),
    connect: vi.fn(async (sessionId: string) => ({ id: sessionId })),
    launch: vi.fn(async () => ({ id: 'new' })),
    limits: vi.fn(async () => ({ timeUntilNextAllowedBrowserAcquisition: 0 })),
    ...overrides,
  };
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  return { run, sleep, now: () => clock };
}

describe('getBrowser', () => {
  it('reuses an idle session before starting a browser', async () => {
    const { run, sleep, now } = fakeRun({
      sessions: async () => [
        { sessionId: 'busy', connectionId: 'c1' },
        { sessionId: 'gone' },
        { sessionId: 'idle' },
      ],
      connect: vi.fn(async (id: string) => {
        if (id === 'gone') throw new Error('session closed');
        return { id };
      }),
    });
    expect(await getBrowser(run, { sleep, now })).toEqual({ id: 'idle' });
    expect(run.launch).not.toHaveBeenCalled();
  });

  it('starts a browser with the keep-alive asked for, or none', async () => {
    const a = fakeRun();
    await getBrowser(a.run, { sleep: a.sleep, now: a.now });
    expect(a.run.launch).toHaveBeenCalledWith(undefined);
    const b = fakeRun();
    await getBrowser(b.run, { keepAliveSeconds: 120, sleep: b.sleep, now: b.now });
    expect(b.run.launch).toHaveBeenCalledWith(120_000);
  });

  it('starts a browser when sessions cannot be listed', async () => {
    const { run, sleep, now } = fakeRun({ sessions: async () => { throw new Error('500'); } });
    expect(await getBrowser(run, { sleep, now })).toEqual({ id: 'new' });
  });

  it('waits for the next launch slot the platform names, then starts', async () => {
    let calls = 0;
    const { run, sleep, now } = fakeRun({
      launch: vi.fn(async () => {
        if (calls++ === 0) throw new Error('Unable to create new browser: code: 429: message: Too many browsers');
        return { id: 'new' };
      }),
      limits: async () => ({ timeUntilNextAllowedBrowserAcquisition: 15_000 }),
    });
    expect(await getBrowser(run, { sleep, now })).toEqual({ id: 'new' });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBeGreaterThanOrEqual(15_000);
  });

  it('answers busy when the wait would be too long', async () => {
    const { run, sleep, now } = fakeRun({
      launch: async () => { throw new Error('Unable to create new browser: code: 429: message: Rate limit exceeded'); },
      limits: async () => ({ timeUntilNextAllowedBrowserAcquisition: 60_000 }),
    });
    await expect(getBrowser(run, { sleep, now })).rejects.toMatchObject({ code: 'busy', status: 503 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('keeps trying for a short while when browsers are all in use', async () => {
    const { run, sleep, now } = fakeRun({
      launch: async () => { throw new Error('429 Too Many Requests'); },
      limits: async () => { throw new Error('no limits'); },
    });
    await expect(getBrowser(run, { maxWaitMs: 5000, sleep, now })).rejects.toMatchObject({ code: 'busy' });
    expect(now()).toBeLessThanOrEqual(5000);
    expect(sleep.mock.calls.length).toBeGreaterThan(1);
  });

  it('says plainly when the daily browser time is used up', async () => {
    const { run, sleep, now } = fakeRun({
      launch: async () => { throw new Error('Unable to create new browser: code: 429: message: Browser time limit exceeded for today'); },
    });
    const err = await getBrowser(run, { sleep, now }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureError);
    expect(err).toMatchObject({ code: 'quota_exceeded', status: 429, message: expect.stringMatching(/00:00 UTC/) });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('answers quota_exceeded at once when a plain rate limit says to wait until 00:00 UTC', async () => {
    const { run, sleep, now } = fakeRun({
      launch: async () => { throw new LaunchRefused(RATE_LIMITED, String(10 * 3600)); },
    }, AFTERNOON);
    await expect(getBrowser(run, { sleep, now })).rejects.toMatchObject({ code: 'quota_exceeded', status: 429 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits out a burst limit by its Retry-After, then starts', async () => {
    let calls = 0;
    const { run, sleep, now } = fakeRun({
      launch: vi.fn(async () => {
        if (calls++ === 0) throw new LaunchRefused(RATE_LIMITED, '20');
        return { id: 'new' };
      }),
      limits: async () => ({ timeUntilNextAllowedBrowserAcquisition: 0 }),
    }, AFTERNOON);
    expect(await getBrowser(run, { sleep, now })).toEqual({ id: 'new' });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBeGreaterThanOrEqual(20_000);
  });

  it('answers busy, naming the daily limit as a possible cause, when a burst does not clear in time', async () => {
    const { run, sleep, now } = fakeRun({
      launch: async () => { throw new LaunchRefused(RATE_LIMITED, '20'); },
    }, AFTERNOON);
    const err = await getBrowser(run, { sleep, now }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'busy', status: 503, message: expect.stringMatching(/may be used up.*00:00 UTC/) });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry other launch failures', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { run, sleep, now } = fakeRun({ launch: async () => { throw new Error('binding misconfigured'); } });
    await expect(getBrowser(run, { sleep, now })).rejects.toMatchObject({ code: 'browser_unavailable' });
    expect(sleep).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('isDailyLimit', () => {
  it.each([
    ['the documented message', 'code: 429: message: Browser time limit exceeded for today', undefined, AFTERNOON, true],
    ['a rate limit that runs to 00:00 UTC', RATE_LIMITED, 10 * 3600_000 + 5000, AFTERNOON, true],
    ['a rate limit of over an hour', RATE_LIMITED, 2 * 3600_000, AFTERNOON, true],
    ['a burst of 20 seconds', RATE_LIMITED, 20_000, AFTERNOON, false],
    ['a burst of 20 seconds just before midnight', RATE_LIMITED, 20_000, Date.UTC(2026, 10, 15, 23, 59, 45), false],
    ['a rate limit with no Retry-After', RATE_LIMITED, undefined, AFTERNOON, false],
    ['a few minutes, not to midnight', RATE_LIMITED, 5 * 60_000, AFTERNOON, false],
  ])('reads %s as %s', (_name, text, waitMs, nowMs, expected) => {
    expect(isDailyLimit(text, waitMs, nowMs)).toBe(expected);
  });
});

describe('retryAfterMs', () => {
  it('reads seconds and HTTP dates, and ignores what it cannot read', () => {
    expect(retryAfterMs('20', AFTERNOON)).toBe(20_000);
    expect(retryAfterMs(new Date(AFTERNOON + 90_000).toUTCString(), AFTERNOON)).toBe(90_000);
    expect(retryAfterMs('soon', AFTERNOON)).toBeUndefined();
    expect(retryAfterMs(null, AFTERNOON)).toBeUndefined();
  });
});

describe('msUntilUtcMidnight', () => {
  it('counts to the next 00:00 UTC', () => {
    expect(msUntilUtcMidnight(AFTERNOON)).toBe(10 * 3600_000);
    expect(msUntilUtcMidnight(Date.UTC(2026, 11, 31, 23, 59))).toBe(60_000);
  });
});

describe('keepRetryAfter', () => {
  it('keeps the Retry-After of a 429 and passes every answer through', async () => {
    const answers = [new Response('Rate limit exceeded', { status: 429, headers: { 'retry-after': '36000' } }), new Response('{}')];
    const binding = { fetch: vi.fn(async () => answers.shift()!) };
    const { endpoint, retryAfter } = keepRetryAfter(binding);
    expect(retryAfter()).toBeNull();
    expect((await endpoint.fetch('https://fake.host/v1/devtools/browser', { method: 'POST' })).status).toBe(429);
    expect(retryAfter()).toBe('36000');
    expect((await endpoint.fetch('https://fake.host/v1/limits')).status).toBe(200);
    expect(binding.fetch).toHaveBeenCalledWith('https://fake.host/v1/devtools/browser', { method: 'POST' });
  });
});

describe('toCaptureError', () => {
  it('tells a used-up daily allowance apart from a busy moment', () => {
    expect(toCaptureError(new Error('code: 429: message: Browser time limit exceeded for today')).code).toBe('quota_exceeded');
    expect(toCaptureError(new Error('Unable to create new browser: code: 429')).code).toBe('busy');
  });
});

describe('keepAliveSeconds', () => {
  it.each([
    [undefined, 0],
    ['', 0],
    ['0', 0],
    ['nonsense', 0],
    ['-5', 0],
    ['10', 60],
    ['120', 120],
    ['5000', 600],
  ])('reads %s as %s', (value, expected) => {
    expect(keepAliveSeconds(value)).toBe(expected);
  });
});
