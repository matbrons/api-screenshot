// Tries a capture again when a second try has a fair chance, all within the
// request's own "timeout". Shared by both runtimes; only the server can send a
// retry out through a different proxy.
//
// Retried: a browser that stopped, a timeout or blank page (when time is
// left), and, when another proxy is there to try, a blocked page, a failed
// proxy or a site that couldn't be reached through the last one. Never
// retried: what another try won't change, such as a refused address or a
// wrong option.

import type { CaptureResult } from './capture.ts';
import { CaptureError } from './errors.ts';
import type { ScreenshotOptions } from './options.ts';

/** A retry only starts with at least this much of "timeout" left. */
export const MIN_RETRY_MS = 8000;

interface RetryOptions {
  /** Whether the next attempt would go out through a proxy not yet tried. */
  anotherRoute?: () => boolean;
  now?: () => number;
}

/** Runs `attempt` once, then up to `opts.retry` more times, each with the time that is left. */
export async function withRetries(
  opts: ScreenshotOptions,
  attempt: (opts: ScreenshotOptions) => Promise<CaptureResult>,
  options: RetryOptions = {},
): Promise<CaptureResult> {
  const now = options.now ?? Date.now;
  const anotherRoute = options.anotherRoute ?? (() => false);
  const deadline = now() + opts.timeoutMs;
  const failures: CaptureError[] = [];
  for (;;) {
    try {
      const result = await attempt({ ...opts, timeoutMs: Math.max(1, deadline - now()) });
      failOnStatus(opts, result);
      return result;
    } catch (err) {
      if (!(err instanceof CaptureError)) throw err;
      failures.push(err);
      const again =
        failures.length <= opts.retry && deadline - now() >= MIN_RETRY_MS && worthRetrying(err, anotherRoute);
      if (!again) throw failures.length > 1 ? withHistory(err, failures) : err;
    }
  }
}

function worthRetrying(err: CaptureError, anotherRoute: () => boolean): boolean {
  switch (err.code) {
    case 'timeout':
    case 'blank':
      return true;
    case 'internal':
      return err.reason === 'browser_stopped';
    case 'blocked':
    case 'proxy_error':
      return anotherRoute();
    case 'unreachable':
      return err.reason !== 'dns' && anotherRoute();
    default:
      return false;
  }
}

/** "fail_on_status": a shot of a page whose status the caller listed is a failure, not a success. */
function failOnStatus(opts: ScreenshotOptions, result: CaptureResult): void {
  const { status, finalUrl } = result.info;
  if (status && opts.failOnStatus.includes(status)) {
    let host = finalUrl;
    try {
      host = new URL(finalUrl).hostname;
    } catch {}
    throw new CaptureError('error_page', `${host} answered HTTP ${status}, which "fail_on_status" lists.`, `http_${status}`);
  }
}

/** The last error, with what happened on each try, so a failure after retries is told honestly. */
function withHistory(last: CaptureError, failures: CaptureError[]): CaptureError {
  const tries = failures.map((f) => (f.reason ? `${f.code} (${f.reason})` : f.code)).join(', then ');
  return new CaptureError(last.code, `${last.message} Tried ${failures.length} times: ${tries}.`, last.reason);
}
