// Decides whether what the browser shows is the real page. A screenshot of a
// captcha, a bot wall or an empty frame is worse than no screenshot, because
// it looks like success. These checks run on plain data read from the page,
// so they are easy to test.

export interface PageSignals {
  /** Host of the final URL, after redirects. */
  host: string;
  /** HTTP status of the main document, or 0 when unknown. */
  status: number;
  title: string;
  /** Visible text of the page, whitespace collapsed (first 20,000 characters). */
  text: string;
  /** Share of the first screen covered by visible images, video, canvas and SVG (0 to 1). */
  mediaShare: number;
  /** A captcha or bot-challenge widget is on the page. */
  hasChallengeWidget: boolean;
  /** Text of large fixed layers (modals, overlays) on the first screen. */
  overlayText: string;
  /** A challenge frame covers a large part of the first screen. */
  challengeOverlay: boolean;
}

type PageVerdict =
  | { kind: 'ok' }
  | { kind: 'blocked' | 'blank' | 'error_page'; reason: string; detail: string };

/** A bot wall or error page is short. Real pages that mention these words are longer. */
const THIN_TEXT = 1500;
const BLANK_TEXT = 40;

const BOT_WALL_PHRASES = [
  'verify you are human', "verify you're human", 'verify you are a human', 'verifying you are human',
  'checking your browser', 'checking if the site connection is secure', 'checking the site connection security',
  'enable javascript and cookies to continue', 'please enable js and disable any ad blocker',
  'press & hold', 'press and hold', 'pardon our interruption', 'access to this page has been denied',
  'are you a robot', "i'm not a robot", 'not a robot', 'unusual traffic', 'automated queries',
  'sorry, you have been blocked', 'you have been blocked', 'request unsuccessful. incapsula',
  "you don't have permission to access", 'bot detected', 'ddos protection by', 'ddos-guard',
  'please wait while we verify', 'security check', 'human verification',
  // A shop's soft bot check: a single button between the visitor and the page.
  'click the button below to continue shopping', 'enter the characters you see below',
  'type the characters you see in this image',
];

const BOT_WALL_TITLES = ['just a moment', 'attention required', 'access denied', 'security check', 'are you a robot', 'pardon our interruption', 'robot check', 'captcha'];

/** Phrases that mark an overlay as a bot wall even when a real page sits behind it. */
const OVERLAY_WALL_PHRASES = [
  'press & hold', 'press and hold', 'verify you are human', "verify you're human", 'verify you are a human',
  'confirm you are a human', 'are you a robot', 'not a bot', 'human verification', 'checking your browser',
  'access to this page has been denied',
];

const CONSENT_WALL_PHRASES = [
  'before you continue to', 'avant d’accéder à', "avant d'accéder à", 'bevor sie zu google', 'voordat je verdergaat naar',
  'prima di continuare su', 'antes de continuar a', 'antes de ir a google',
];

const ERROR_PHRASES = [
  'something went wrong', 'application error', 'a client-side exception has occurred', 'unexpected error',
  'internal server error', 'bad gateway', 'gateway timeout', 'service unavailable', 'temporarily unavailable',
  'page not found', 'this page could not be found', "this site can't be reached", 'no server is available',
];

function find(list: string[], haystack: string): string | undefined {
  return list.find((p) => haystack.includes(p));
}

export function classifyPage(s: PageSignals): PageVerdict {
  const title = s.title.toLowerCase();
  const text = s.text.toLowerCase();
  const thin = s.text.length < THIN_TEXT;
  const blocked = (reason: string, detail: string): PageVerdict => ({ kind: 'blocked', reason, detail });
  const errorPage = (reason: string, detail: string): PageVerdict => ({ kind: 'error_page', reason, detail });

  if (s.status === 429) return blocked('rate_limited', `${s.host} answered 429 Too Many Requests.`);

  if (s.host.startsWith('consent.')) {
    return blocked('consent_wall', `${s.host} redirected to a consent page that could not be passed.`);
  }
  const consentPhrase = thin ? find(CONSENT_WALL_PHRASES, text) : undefined;
  if (consentPhrase) return blocked('consent_wall', `${s.host} showed a consent wall ("${consentPhrase}").`);

  if (s.challengeOverlay) {
    return blocked('captcha', `${s.host} covered the page with a captcha or bot challenge.`);
  }
  const overlayPhrase = find(OVERLAY_WALL_PHRASES, s.overlayText.toLowerCase());
  if (overlayPhrase) {
    return blocked('bot_check', `${s.host} covered the page with a bot check ("${overlayPhrase}").`);
  }
  if (thin && s.hasChallengeWidget) {
    return blocked('captcha', `${s.host} showed a captcha or bot challenge instead of the page.`);
  }
  const wallTitle = find(BOT_WALL_TITLES, title);
  const wallPhrase = thin ? find(BOT_WALL_PHRASES, text) : undefined;
  if ((wallTitle && thin) || wallPhrase) {
    return blocked('bot_check', `${s.host} showed a bot check ("${wallPhrase ?? wallTitle}") instead of the page.`);
  }
  if ((s.status === 401 || s.status === 403) && thin) {
    return blocked('access_denied', `${s.host} refused access (HTTP ${s.status}).`);
  }

  if (s.status >= 500) return errorPage(`http_${s.status}`, `${s.host} answered with a server error (HTTP ${s.status}).`);
  if (s.status === 404 || s.status === 410) return errorPage(`http_${s.status}`, `${s.host} answered ${s.status}: the page does not exist.`);
  const errorPhrase = find(ERROR_PHRASES, title) ?? (s.text.length < 600 ? find(ERROR_PHRASES, text) : undefined);
  if (s.status >= 400 && (thin || errorPhrase)) {
    return errorPage(`http_${s.status}`, `${s.host} answered with an error (HTTP ${s.status}).`);
  }
  if (errorPhrase && s.text.length < 600) {
    return errorPage('crashed', `${s.host} showed its own error message ("${errorPhrase}") instead of the page.`);
  }

  if (s.text.length < BLANK_TEXT && s.mediaShare < 0.15) {
    return { kind: 'blank', reason: 'blank', detail: `${s.host} rendered an empty page.` };
  }
  return { kind: 'ok' };
}
