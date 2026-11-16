// Gets a browser from Cloudflare's Browser Rendering for one screenshot, within
// the platform's limits. On the free plan those are 10 minutes of browser time
// a day, 3 browsers at once and 1 new browser every 20 seconds. A browser left
// open counts as browser time until it closes, so by default each one is closed
// right after its shot.
//
// Kept apart from worker.ts, with the platform calls passed in, so it can be
// tested without Cloudflare.

import { CaptureError, msUntilUtcMidnight, quotaExceeded } from './errors.ts';

/** The few Browser Rendering calls this needs, bound to the Worker's binding. */
export interface BrowserRun<B> {
  /** Open sessions; one without a connectionId is idle and can be reused. */
  sessions(): Promise<Array<{ sessionId: string; connectionId?: string | null }>>;
  connect(sessionId: string): Promise<B>;
  /**
   * Starts a browser that closes itself after this long without a connection.
   * A refusal may come as a LaunchRefused, carrying Cloudflare's Retry-After.
   */
  launch(keepAliveMs?: number): Promise<B>;
  limits(): Promise<{ timeUntilNextAllowedBrowserAcquisition?: number }>;
}

interface GetBrowserOptions {
  /** Longest wait for a free browser before answering "busy". */
  maxWaitMs?: number;
  /** Seconds a new browser stays open while idle. 0 leaves the platform's 60; the caller closes it after use. */
  keepAliveSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Wait one free-plan launch slot (20 s) at most, so a short burst queues instead of failing. */
const DEFAULT_MAX_WAIT_MS = 21_000;

/**
 * Reads BROWSER_KEEP_ALIVE_SECONDS. 0 (the default) closes each browser after
 * its shot, so a free-plan install spends no browser time idle. 60 to 600
 * keeps it open for the next shot: faster, but the idle time counts.
 */
export function keepAliveSeconds(value: string | undefined): number {
  const n = Number(value);
  if (!value?.trim() || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(600, Math.max(60, Math.round(n)));
}

/** A launch Cloudflare refused, with the Retry-After header of its answer, if it sent one. */
export class LaunchRefused extends Error {
  readonly retryAfter: string | null;

  constructor(message: string, retryAfter: string | null) {
    super(message);
    this.name = 'LaunchRefused';
    this.retryAfter = retryAfter;
  }
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/**
 * Wraps a Browser Rendering binding so the Retry-After of a refused launch can
 * be read afterwards. @cloudflare/puppeteer's own error keeps only the status
 * and the body text, and the header is the one thing that tells a used-up day
 * from a short wait (see isDailyLimit).
 */
export function keepRetryAfter<F extends Fetcher>(binding: F): { endpoint: Fetcher; retryAfter: () => string | null } {
  let retryAfter: string | null = null;
  const endpoint: Fetcher = {
    fetch: async (input, init) => {
      const res = await binding.fetch(input, init);
      if (res.status === 429) retryAfter = res.headers.get('retry-after');
      return res;
    },
  };
  return { endpoint, retryAfter: () => retryAfter };
}

/** Milliseconds a Retry-After value (seconds, or an HTTP date) asks to wait, if it can be read. */
export function retryAfterMs(value: string | null | undefined, nowMs: number): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

const MINUTE = 60_000;

function isRateLimit(text: string): boolean {
  return /429|rate limit|too many|Unable to create new browser/i.test(text);
}

/**
 * Whether a refused launch means the day's browser time is used up, rather
 * than a short wait for a free slot. Both come back as HTTP 429. Cloudflare's
 * docs give the daily one its own message ("Browser time limit exceeded for
 * today"), but accounts have also been seen to get the same plain "Rate limit
 * exceeded" as a burst. What differs then is Retry-After: about 20 seconds for
 * a burst, the time left until 00:00 UTC for a used-up day. So a Retry-After
 * that runs to midnight, or past an hour (no burst limit lasts that long),
 * counts as the daily limit too.
 */
export function isDailyLimit(text: string, waitMs: number | undefined, nowMs: number): boolean {
  if (/time limit exceeded|exceeded for today/i.test(text)) return true;
  if (waitMs === undefined || waitMs <= MINUTE) return false;
  return waitMs >= 60 * MINUTE || Math.abs(waitMs - msUntilUtcMidnight(nowMs)) <= 2 * MINUTE;
}

/**
 * Answered when no browser could be had in time and nothing said why. A burst
 * clears within seconds; if it goes on, the likeliest cause on the free plan
 * is a used-up day that Cloudflare didn't name, so the message says so.
 */
function busy(): CaptureError {
  return new CaptureError(
    'busy',
    "No browser is free right now. Try again in a few seconds. If this goes on for minutes, today's browser time on this Cloudflare account may be used up; on the free plan it resets at 00:00 UTC.",
  );
}

/**
 * Reuses an idle browser when there is one, otherwise starts a new one. When
 * the account may not start one yet, waits as long as the platform says, up to
 * maxWaitMs, then answers "busy". A used-up daily allowance is its own error,
 * answered at once.
 */
export async function getBrowser<B>(run: BrowserRun<B>, options: GetBrowserOptions = {}): Promise<B> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const keepAliveMs = (options.keepAliveSeconds ?? 0) * 1000;

  for (;;) {
    try {
      for (const session of (await run.sessions()).filter((s) => !s.connectionId)) {
        try {
          return await run.connect(session.sessionId);
        } catch {
          // taken by another request in the meantime; try the next one
        }
      }
    } catch {
      // listing sessions only saves a launch; carry on without it
    }

    let text: string;
    let retryAfter: number | undefined;
    try {
      return await run.launch(keepAliveMs || undefined);
    } catch (err) {
      text = String((err as Error)?.message ?? err);
      if (err instanceof LaunchRefused) retryAfter = retryAfterMs(err.retryAfter, now());
    }
    if (isDailyLimit(text, retryAfter, now())) throw quotaExceeded();
    if (!isRateLimit(text)) {
      console.error('browser launch failed:', text.slice(0, 500));
      throw new CaptureError('browser_unavailable', 'The browser could not start.');
    }

    let wait = retryAfter ?? 0;
    try {
      const next = (await run.limits()).timeUntilNextAllowedBrowserAcquisition;
      if (typeof next === 'number' && Number.isFinite(next) && next > wait) wait = next;
    } catch {
      // go by Retry-After, or the short default wait
    }
    wait = Math.max(250, wait || 1000) + 250;
    if (now() + wait > deadline) throw busy();
    await sleep(wait);
  }
}
