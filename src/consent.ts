// Cookie-consent handling with DuckDuckGo's autoconsent (MPL-2.0), which knows
// how to say "no" to hundreds of consent managers. It runs in the page and asks
// us for its rules through an exposed function, and tells us how it went.
// Rejecting rather than just hiding matters: many sites keep the page locked or
// blurred until a choice is made.
// https://github.com/duckduckgo/autoconsent
//
// The exposed function is on the page's window, so the page's own scripts can
// call it too. It therefore only hands out the rules and takes in news; it
// never runs code. Autoconsent's own page snippets (window.Cookiebot.withdraw()
// and the like) run inside the page itself: it is injected into the page's
// main world, and `isMainWorld` tells it so.

import type { Page } from 'puppeteer-core';

export interface ConsentAssets {
  /** Source of autoconsent's dist/autoconsent.playwright.js. */
  script: string;
  /** autoconsent's rules/compact-rules.json. */
  compactRules: unknown;
}

export interface ConsentTracker {
  /** Autoconsent's name for the consent rule that matched, if any. See `consentToolName`. */
  cmp: string | null;
  /** A consent banner was showing. */
  popupFound: boolean;
  /** The banner was answered or hidden by autoconsent, so it is gone from the page. */
  dismissed: boolean;
  /** Autoconsent has finished, whatever the outcome. */
  done: boolean;
  /** Waits until autoconsent has handled the banner, or there clearly is none. */
  settle(maxMs: number): Promise<void>;
}

const CONFIG = {
  enabled: true,
  autoAction: 'optOut',
  disabledCmps: [],
  enablePrehide: true,
  enableCosmeticRules: true,
  enableGeneratedRules: true,
  enableHeuristicDetection: true,
  heuristicMode: 'tier2', // reject when possible, otherwise accept: either way the banner goes
  detectRetries: 20,
  isMainWorld: true, // runs its snippets in place, so it never asks us to evaluate code
  prehideTimeout: 2000,
  logs: { lifecycle: false, rulesteps: false, detectionsteps: false, evals: false, errors: false, messages: false, waits: false },
};

/** What autoconsent sends. Anything may arrive here, from autoconsent or from the page. */
type Message = { type?: unknown; cmp?: unknown; result?: unknown };

/** The page's side of the bridge, set up by autoconsent's script. */
type ConsentWindow = { autoconsentReceiveMessage?: (message: object) => void };

/** A rule name from a message, or null when it isn't one. */
const ruleName = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export async function installConsent(page: Page, assets: ConsentAssets): Promise<ConsentTracker> {
  const tracker: ConsentTracker = {
    cmp: null,
    popupFound: false,
    dismissed: false,
    done: false,
    async settle(maxMs) {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        if (tracker.done) return;
        // No banner seen after a short look: there is nothing to wait for.
        if (!tracker.popupFound && Date.now() - start > 1500) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };

  const reply = (message: object) =>
    page
      .evaluate((m) => (window as ConsentWindow).autoconsentReceiveMessage?.(m), message)
      .catch(() => undefined);

  // Only news and the rules: an "eval" request, or anything else, is ignored.
  await page.exposeFunction('autoconsentSendMessage', async (message: Message) => {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'init':
        await reply({ type: 'initResp', config: CONFIG, rules: { autoconsent: [], compact: assets.compactRules } });
        break;
      case 'cmpDetected':
        tracker.cmp = ruleName(message.cmp) ?? tracker.cmp;
        break;
      case 'popupFound':
        tracker.popupFound = true;
        tracker.cmp = ruleName(message.cmp) ?? tracker.cmp;
        break;
      case 'optOutResult':
      case 'optInResult':
        if (message.result === false) tracker.done = true;
        break;
      case 'autoconsentDone':
        tracker.cmp = ruleName(message.cmp) ?? tracker.cmp;
        tracker.dismissed = true;
        tracker.done = true;
        break;
      case 'autoconsentError':
        tracker.done = true;
        break;
    }
  });

  // Top frame only: answers go to the top frame, and a consent manager's own
  // iframe is hidden along with its container.
  await page.evaluateOnNewDocument(`if (window === window.top) {\n${assets.script}\n}`);
  return tracker;
}

/** Value for a banner recognised by its look and words rather than by a known consent tool. */
export const GENERIC_CONSENT = 'generic';

/**
 * Autoconsent's own names for the most common consent tools, which it keeps
 * for its rules rather than for people ("Onetrust", "TrustArc-top"). Keys are
 * lower case.
 */
const TOOL_NAMES: Record<string, string> = {
  onetrust: 'OneTrust',
  cybotcookiebot: 'Cookiebot',
  'trustarc-top': 'TrustArc',
  'trustarc-frame': 'TrustArc',
  'trustarc-newcm': 'TrustArc',
  'sourcepoint-frame': 'Sourcepoint',
  'sourcepoint-top': 'Sourcepoint',
  'consentmanager.net': 'consentmanager',
  'consentmanager-ncmp': 'consentmanager',
  didomi: 'Didomi',
  'usercentrics-api': 'Usercentrics',
  'usercentrics-button': 'Usercentrics',
  quantcast: 'Quantcast',
  'funding-choices': 'Google Funding Choices',
  iubenda: 'iubenda',
  osano: 'Osano',
  cookieyes: 'CookieYes',
  'cookieyes-legacy': 'CookieYes',
  'complianz banner': 'Complianz',
  'complianz categories': 'Complianz',
  'complianz notice': 'Complianz',
  'complianz opt-out': 'Complianz',
  'complianz optin': 'Complianz',
  borlabs: 'Borlabs Cookie',
  axeptio: 'Axeptio',
  'axeptio-tcf': 'Axeptio',
  ketch: 'Ketch',
  transcend: 'Transcend',
  termly: 'Termly',
  evidon: 'Evidon',
  klaro: 'Klaro',
  admiral: 'Admiral',
  uniconsent: 'UniConsent',
  conversant: 'Conversant',
  'cookie-script': 'CookieScript',
  cookiehub: 'CookieHub',
  'cookiefirst.com': 'CookieFirst',
  fides: 'Fides',
  'piwik-pro': 'Piwik PRO',
  sirdata: 'Sirdata',
  tealium: 'Tealium',
  ensighten: 'Ensighten',
  'tarteaucitron.js': 'tarteaucitron',
  'tarteaucitron deny': 'tarteaucitron',
  cookieconsent2: 'CookieConsent',
  'cookieconsent2-legacy': 'CookieConsent',
  cookieconsent3: 'CookieConsent',
  'real-cookie-banner': 'Real Cookie Banner',
  shopify: 'Shopify',
  'shopify-dux': 'Shopify',
  hubspot: 'HubSpot',
  wix: 'Wix',
  webflow: 'Webflow',
  'squarespace-cookie-banner': 'Squarespace',
  'squarespace-cookie-notice': 'Squarespace',
};

/**
 * The public name for the consent tool behind a banner, for the
 * x-consent-manager header: the tool's own name for the common ones, the name
 * of autoconsent's rule for the rest (often the site itself, such as
 * "airbnb"), and "generic" for a banner found by its look and words.
 */
export function consentToolName(rule: string | null): string {
  const name = (rule ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 60);
  // HEURISTIC-* is autoconsent's look-and-words detector, auto_* its rules
  // generated for single sites, which name no tool.
  if (!name || /^(heuristic|auto_|baserule$)/i.test(name)) return GENERIC_CONSENT;
  return TOOL_NAMES[name.toLowerCase()] ?? name;
}
