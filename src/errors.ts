// One error type for everything the API can refuse or fail on. The code is
// stable and machine-readable; the message is for people.

export type ErrorCode =
  | 'invalid_options' // the request itself is wrong
  | 'unauthorized' // API key missing or wrong
  | 'url_not_allowed' // private, local or otherwise unsafe address, also after a redirect
  | 'blocked' // the site served a bot check, captcha or consent wall instead of the page
  | 'blank' // the page rendered nothing worth a screenshot
  | 'error_page' // the site answered with its own error (5xx, 404 page, crashed app)
  | 'selector_not_found' // "selector", "wait_for_selector" or "click" matched nothing in time
  | 'script_error' // the request's own "scripts" threw an error or did not finish
  | 'unreachable' // DNS, TLS or connection failure
  | 'timeout' // the whole capture ran past "timeout"
  | 'busy' // no browser free right now; try again shortly
  | 'quota_exceeded' // the platform's browser time for today is used up
  | 'browser_unavailable' // no browser configured, or it could not start
  | 'not_configured' // no API key set and public access not turned on, or a setting that can't be used
  | 'proxy_not_allowed' // a request brought its own proxy, and this install doesn't allow that one
  | 'proxy_error' // the proxy refused the connection, the login, or could not be reached
  | 'internal';

/** The HTTP status each error is answered with. */
export const STATUS: Record<ErrorCode, number> = {
  invalid_options: 400,
  unauthorized: 401,
  url_not_allowed: 403,
  blocked: 422,
  blank: 422,
  error_page: 422,
  selector_not_found: 422,
  script_error: 422,
  unreachable: 502,
  timeout: 504,
  busy: 503,
  quota_exceeded: 429,
  browser_unavailable: 503,
  not_configured: 503,
  proxy_not_allowed: 403,
  proxy_error: 502,
  internal: 500,
};

export class CaptureError extends Error {
  readonly code: ErrorCode;
  /** Short machine-readable detail, e.g. "captcha" or "http_503". */
  readonly reason: string | undefined;

  constructor(code: ErrorCode, message: string, reason?: string) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
    this.reason = reason;
  }

  get status(): number {
    return STATUS[this.code];
  }
}

/** Maps an unknown error from the browser into a CaptureError with an honest code. */
/** Chromium's network error codes that mean the site could not be reached. */
const UNREACHABLE = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_(REFUSED|RESET|CLOSED|TIMED_OUT)|ERR_ADDRESS_UNREACHABLE|ERR_CERT_|ERR_SSL_|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE|ERR_TUNNEL_CONNECTION_FAILED/;

/** "unreachable", naming Chromium's error code, when `text` holds one that means so. */
export function unreachableError(text: string): CaptureError | null {
  if (!UNREACHABLE.test(text)) return null;
  const code = text.match(/ERR_[A-Z_]+/)?.[0];
  return new CaptureError('unreachable', `The site could not be reached (${code}).`, code);
}

export function toCaptureError(err: unknown): CaptureError {
  if (err instanceof CaptureError) return err;
  const text = String((err as Error)?.message ?? err);
  const unreachable = unreachableError(text);
  if (unreachable) return unreachable;
  if (/time limit exceeded/i.test(text)) return quotaExceeded();
  if (/429|rate limit|Unable to create new browser/i.test(text)) {
    return new CaptureError('busy', 'No browser is free right now. Try again in a few seconds.');
  }
  if (/Target closed|Session closed|Protocol error|disconnected/i.test(text)) {
    return new CaptureError('internal', 'The browser stopped during the capture. Try again.', 'browser_stopped');
  }
  console.error('capture failed:', text.slice(0, 500));
  return new CaptureError('internal', 'The capture failed.');
}

/** Cloudflare's free plan stops new browsers once the day's browser time is used up. */
export function quotaExceeded(): CaptureError {
  return new CaptureError(
    'quota_exceeded',
    "Today's browser time on this Cloudflare account is used up. It resets at 00:00 UTC, or upgrade to the Workers Paid plan.",
  );
}

/** Milliseconds from `nowMs` to the next 00:00 UTC, when Cloudflare's daily browser time resets. */
export function msUntilUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - nowMs;
}
