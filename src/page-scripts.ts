// Code that runs inside the page, in the browser. Each function here that the
// engine hands to page.evaluate is sent as source text, so it must not use
// anything from outside its own body: no imports, no module-level constants.

/** Common consent-banner containers, for sites the consent library does not handle. */
const COOKIE_SELECTORS = [
  '#onetrust-consent-sdk', '#onetrust-banner-sdk', '#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay',
  '#usercentrics-root', '#usercentrics-cmp-ui', '#didomi-host', '#qc-cmp2-container', '.qc-cmp2-container',
  '[id^="sp_message_container"]', '.sp_message_container', '#truste-consent-track', '.truste_overlay',
  '.truste_box_overlay', '#consent_blackbar', '#iubenda-cs-banner', '.iubenda-cs-container', '.cmplz-cookiebanner',
  '#cmplz-cookiebanner-container', '.cc-window', '.cc-banner', '#cookie-law-info-bar', '#cookie-notice',
  '.fc-consent-root', '#fides-overlay', '#fides-banner', '#axeptio_overlay', '#hs-eu-cookie-confirmation',
  '#klaro', '.osano-cm-window', '.osano-cm-dialog', '#cookiescript_injected', '#BorlabsCookieBox',
  '#moove_gdpr_cookie_info_bar', '.cky-consent-container', '.cky-overlay', '#cookie-consent', '#cookieConsent',
  '#cookie-banner', '.cookie-banner', '#cookiebanner', '.cookie-consent', '.cookie-notice', '#gdpr-cookie-message',
  '.eu-cookie-compliance-banner', '#sliding-popup', '#ccc', '#termly-code-snippet-support', '.termly-styles-root',
  '[aria-label="cookieconsent"]', '#cmpbox', '#cmpbox2', '.cmpboxBG', '#tarteaucitronRoot', '#cookie-bar',
];

/**
 * Widgets pinned to a corner: live-chat launchers, the reCAPTCHA badge and
 * push-notification prompts. Hidden with block_chats. Vendor ids only, never
 * generic words.
 */
const CORNER_WIDGET_SELECTORS = [
  '#intercom-container', '.intercom-lightweight-app', '#intercom-frame', '.intercom-launcher-frame',
  '#hubspot-messages-iframe-container', '#drift-widget-container', '#drift-frame-controller', '#drift-frame-chat',
  '#crisp-chatbox', '.crisp-client', '#tawkchat-container', '#tawkchat-minified-wrapper', 'iframe#launcher',
  '.zEWidget-launcher', 'iframe[title="Button to launch messaging window"]', 'iframe[title="Messaging window"]',
  '#tidio-chat', '#fc_frame', '#chat-widget-container', '#front-chat-iframe', '.olark-launch-button',
  '#smartsupp-widget-container', '#beacon-container', '#gorgias-chat-container', '#launcher-frame',
  '#chatlio-widget', '#lc_chat_layout', '#livechat-compact-container', '#podium-website-widget',
  '[data-testid="chat-widget"]', '.grecaptcha-badge', '#onesignal-slidedown-container', '#onesignal-bell-container',
];

/** Ad slots. Hidden only when block_ads is on. */
const AD_SELECTORS = [
  'ins.adsbygoogle', '[id^="google_ads_"]', '[id^="div-gpt-ad"]', 'iframe[id^="google_ads_iframe"]',
  'iframe[src*="doubleclick.net"]', 'iframe[src*="googlesyndication.com"]', '[data-ad-slot]', '.ad-slot',
  '.adsbygoogle', '#taboola-below-article-thumbnails', '.trc_related_container', '.OUTBRAIN',
];

/**
 * Words that give a banner or pop-up away, as regular-expression sources (the
 * page functions can't share constants, so they get these in their config).
 */
export const WORDS = {
  consent: 'cookie|consent|gdpr|datenschutz|toestemming|consentement|consentimiento|consenso|privacy (settings|preferences|choices)',
  consentButton: "^(accept|agree|allow|reject|decline|deny|refuse|ok|okay|got it|i understand|understood|continue|close|accepteren|akkoord|weigeren|alle akzeptieren|akzeptieren|zustimmen|ablehnen|accepter|tout accepter|refuser|aceptar|rechazar|accetta|rifiuta|aceitar|rejeitar)\\b",
  popup: "newsletter|subscribe|sign up|sign-up|join (our|the)|% off|discount|coupon|exclusive offer|get the app|download (our|the) app|enable notifications|choose your (country|region|location|language)|select your (country|region|location|language)|you('re| are) (on|visiting) (the|our)|ship(ping)? to|stay (in touch|updated)|don't miss",
  /** Buttons the final pass may press: a refusal, or a plain close. Never a yes. */
  refuse: '^(reject|decline|deny|refuse|disagree|ablehnen|alle ablehnen|weigeren|refuser|tout refuser|rechazar|rifiuta|rejeitar)\\b',
  close: '^(×|✕|✖)|^(x|close|dismiss|no,? thanks?|not now|maybe later|later|skip|continue without)\\b',
  closeSelector: '[aria-label*="close" i], [aria-label*="dismiss" i], [title*="close" i], [class*="close" i], [data-dismiss], [data-testid*="close" i]',
};

export interface CleanConfig {
  cookieBanners: boolean;
  popups: boolean;
  chats: boolean;
  ads: boolean;
  hideSelectors: string[];
  /** Known containers. `cookie` and `ad` also hold the filter lists' selectors for this site. */
  selectors: { cookie: string[]; cornerWidget: string[]; ad: string[] };
  words: typeof WORDS;
}

export const SELECTORS = { cookie: COOKIE_SELECTORS, cornerWidget: CORNER_WIDGET_SELECTORS, ad: AD_SELECTORS };

export interface CleanResult {
  /** Visible things hidden: a banner and its own parts count once. */
  removed: number;
  /** How many of those were cookie banners. */
  cookieBanners: number;
  textBefore: number;
  textAfter: number;
}

/** Runs before any page script: sets navigator.webdriver to false, the most obvious automation flag. */
export function initScript(): void {
  // Bundlers may wrap functions in a __name() helper that does not exist inside the page.
  (globalThis as any).__name ??= (f: unknown) => f;
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
  } catch {
    // Already defined by the page; nothing to do.
  }
}

/** Reads what the verdict needs: title, visible text, how much of the screen is media, captcha widgets. */
export function readSignals(): {
  title: string;
  text: string;
  mediaShare: number;
  hasChallengeWidget: boolean;
  overlayText: string;
  challengeOverlay: boolean;
} {
  const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 20000);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let covered = 0;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('img, video, canvas, svg, picture, iframe, [style*="background"]'))) {
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (w * h < 2500) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.opacity === '0') continue;
    covered += w * h;
  }
  const challenge = [
    'iframe[src*="challenges.cloudflare.com"]', '#challenge-form', '#challenge-running', '.cf-turnstile',
    '#cf-challenge-running', 'iframe[src*="captcha-delivery.com"]', '#px-captcha', 'iframe[src*="hcaptcha.com"]',
    'iframe[src*="recaptcha"][src*="anchor"]:not([src*="size=invisible"])', 'iframe[title*="captcha" i]',
    '#captcha-container', '.g-recaptcha', '[data-sitekey]', 'iframe[src*="geo.captcha-delivery"]',
  ];
  // A bot wall can also sit on top of a real page, as a fixed overlay. Collect
  // the text of large fixed layers, and note a challenge frame that covers much of the screen.
  const visibleArea = (el: Element) => {
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    return (w * h) / (vw * vh);
  };
  const layers: HTMLElement[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
    if (layers.some((l) => l.contains(el))) continue;
    const style = getComputedStyle(el);
    if (style.position !== 'fixed' || style.display === 'none' || style.visibility === 'hidden') continue;
    if (Number(style.opacity) < 0.1 || visibleArea(el) < 0.08) continue;
    layers.push(el);
  }
  const overlayText = layers.map((l) => l.innerText.replace(/\s+/g, ' ').slice(0, 1000)).join(' ').slice(0, 4000);
  const challengeFrames = [
    'iframe[src*="captcha-delivery.com"]', 'iframe[src*="challenges.cloudflare.com"]', 'iframe[src*="hcaptcha.com"]',
    '[id^="px-captcha"]', 'iframe[id*="captcha" i]', 'iframe[title*="captcha" i]', 'iframe[name*="captcha" i]',
  ].join(', ');
  const challengeOverlay = Array.from(document.querySelectorAll(challengeFrames)).some((el) => {
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && visibleArea(el) >= 0.2;
  });

  return {
    title: document.title ?? '',
    text,
    mediaShare: Math.min(1, covered / (vw * vh)),
    overlayText,
    challengeOverlay,
    hasChallengeWidget: challenge.some((s) => {
      try {
        return document.querySelector(s) !== null;
      } catch {
        return false;
      }
    }),
  };
}

/**
 * One step of the scroll through a page before a full-page shot: lets every
 * image within the shot load eagerly (including ones added since the last
 * step), then scrolls one step further down so lazy loaders that wait for
 * their element to come into view run. Returns false once the bottom, or the
 * height limit, is reached.
 */
export function scrollStep(cfg: { maxHeight: number }): boolean {
  for (const img of Array.from(document.images)) {
    if (img.loading === 'lazy' && img.getBoundingClientRect().top + window.scrollY < cfg.maxHeight) img.loading = 'eager';
  }
  const pageHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
  const bottom = Math.min(pageHeight, cfg.maxHeight) - window.innerHeight;
  const y = window.scrollY;
  if (y >= bottom - 1) return false;
  // Steps overlap, so content that only loads once wholly in view gets its turn.
  window.scrollTo(0, Math.min(y + Math.max(200, Math.floor(window.innerHeight * 0.75)), bottom));
  return window.scrollY > y;
}

/**
 * Back to the top in a few steps rather than one jump: headers that hide
 * while scrolling down only come back when they see the page scroll up.
 */
export async function scrollBackUp(): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const y = window.scrollY;
  for (const to of [Math.min(y, 600), Math.min(y, 200), 0]) {
    window.scrollTo(0, to);
    await sleep(80);
  }
}

/**
 * Waits until every image within the shot has loaded (or failed), up to a
 * time limit. Lazy images are switched to eager first, so ones that are not
 * in view still load. Returns how many were still loading when time ran out.
 */
export async function waitForImages(cfg: { maxHeight: number; timeoutMs: number }): Promise<number> {
  const inShot = (img: HTMLImageElement) => img.getBoundingClientRect().top + window.scrollY < cfg.maxHeight;
  const images = Array.from(document.images).filter(inShot);
  for (const img of images) if (img.loading === 'lazy') img.loading = 'eager';
  // An image without a source counts as complete; only real downloads are waited for.
  const pending = () => images.filter((img) => !img.complete && (img.currentSrc || img.getAttribute('src')));
  const waiting = pending();
  if (waiting.length) {
    const loaded = Promise.all(waiting.map((img) => new Promise((done) => {
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    })));
    await Promise.race([loaded, new Promise((r) => setTimeout(r, cfg.timeoutMs))]);
  }
  // One frame, so what just loaded is painted before the shot (a timer too, in case frames are paused).
  await new Promise((r) => {
    requestAnimationFrame(() => r(undefined));
    setTimeout(r, 100);
  });
  return pending().length;
}

/**
 * Removes cookie banners, pop-ups, chat widgets and (optionally) ads, then
 * unlocks scrolling. Known containers are hidden by selector; unknown ones are
 * found by what they look like: something pinned to the screen that talks about
 * cookies and has an accept or reject button, a modal with an email field or a
 * newsletter pitch, or a dark backdrop over the whole page.
 * Every hidden element is marked so `restorePage` can undo it. Only what was
 * visible counts as removed, so a consent box that is already closed does not.
 */
export function cleanPage(cfg: CleanConfig): CleanResult {
  const MARK = 'data-shot-hidden';
  const STYLE_ID = 'shot-clean-style';
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const textLength = () => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().length;
  const textBefore = textLength();
  /** Hidden elements that were visible, and which of them were cookie banners. */
  const counted: Element[] = [];
  const cookies = new Set<Element>();

  // Something on screen: a box of its own, or a visible part (a container can
  // be zero-sized while its fixed-position children show, also in a shadow root).
  const boxShows = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    return typeof el.checkVisibility === 'function'
      ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      : getComputedStyle(el).visibility !== 'hidden';
  };
  const shows = (el: Element) => {
    if (boxShows(el)) return true;
    const parts = [...Array.from(el.querySelectorAll('*')), ...Array.from(el.shadowRoot?.querySelectorAll('*') ?? [])];
    return parts.slice(0, 500).some(boxShows);
  };

  const hide = (el: Element, cookie: boolean, visible = true) => {
    if (el === document.body || el === document.documentElement || el.hasAttribute(MARK)) return;
    const h = el as HTMLElement;
    h.setAttribute(MARK, h.getAttribute('style') ?? '');
    h.style.setProperty('display', 'none', 'important');
    if (!visible) return;
    counted.push(el);
    if (cookie) cookies.add(el);
  };

  /**
   * 1. Known containers, by selector. Also kept as style rules, so a banner
   * added later stays hidden. The lists hold thousands of selectors, so they
   * are tried in groups; one invalid selector spoils its group, which is then
   * tried one by one.
   */
  const hideKnownContainers = () => {
    const groups: Array<[selectors: string[], cookie: boolean]> = [
      [cfg.cookieBanners ? cfg.selectors.cookie : [], true],
      [cfg.chats ? cfg.selectors.cornerWidget : [], false],
      [cfg.ads ? cfg.selectors.ad : [], false],
      [cfg.hideSelectors, false],
    ];
    const matches: Array<[el: Element, cookie: boolean]> = [];
    const rules: string[] = [];
    const tryGroup = (group: string[], cookie: boolean) => {
      try {
        document.querySelectorAll(group.join(',')).forEach((el) => matches.push([el, cookie]));
        rules.push(`${group.join(',')} { display: none !important; }`);
      } catch {
        if (group.length > 1) for (const s of group) tryGroup([s], cookie);
      }
    };
    for (const [list, cookie] of groups) {
      for (let i = 0; i < list.length; i += 250) tryGroup(list.slice(i, i + 250), cookie);
    }
    document.getElementById(STYLE_ID)?.remove();
    if (!rules.length) return;
    // Look before hiding anything: hiding one element changes what the others show.
    const visible = matches.map(([el]) => !el.hasAttribute(MARK) && shows(el));
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = rules.join('\n');
    (document.head ?? document.documentElement).appendChild(style);
    matches.forEach(([el, cookie], i) => hide(el, cookie, visible[i]));
  };

  // 2. Unknown overlays, by shape and words.
  const CONSENT_WORDS = new RegExp(cfg.words.consent, 'i');
  const CONSENT_BUTTON = new RegExp(cfg.words.consentButton, 'i');
  const POPUP_WORDS = new RegExp(cfg.words.popup, 'i');
  const CLOSE_BUTTON = cfg.words.closeSelector;
  const buttonsOf = (el: Element) => Array.from(el.querySelectorAll<HTMLElement>('button, a, [role="button"], input[type="button"], input[type="submit"]'));
  const label = (b: HTMLElement) => (b.innerText || b.getAttribute('aria-label') || (b as HTMLInputElement).value || '').replace(/\s+/g, ' ').trim();

  /** Everything pinned to the screen and showing, outer elements first. */
  const pinnedElements = () => {
    const pinned: HTMLElement[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (el.closest(`[${MARK}]`)) continue;
      const style = getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      pinned.push(el);
    }
    return pinned;
  };

  /** Hides a pinned element when it is a consent banner, a backdrop, a pop-up or a chat launcher. */
  const hideIfOverlay = (el: HTMLElement) => {
    if (el.closest(`[${MARK}]`)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const style = getComputedStyle(el);
    const area = (Math.min(r.right, vw) - Math.max(r.left, 0)) * (Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const share = Math.max(0, area) / (vw * vh);
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const z = Number.parseInt(style.zIndex, 10) || 0;
    const buttons = buttonsOf(el);

    // A consent banner or wall: talks about cookies and offers a consent choice.
    if (cfg.cookieBanners && CONSENT_WORDS.test(text) && text.length < 4000 && buttons.some((b) => CONSENT_BUTTON.test(label(b)))) {
      return hide(el, true);
    }
    if (!cfg.popups) return;
    // A sticky header is pinned to the top edge and short; leave it alone.
    const isHeaderBar = r.top <= 1 && r.height < vh * 0.25 && !el.querySelector('input[type="email"]');
    if (isHeaderBar) return;
    // A dark or blurred backdrop over the whole screen, with little or no text of its own.
    const coversScreen = share > 0.85;
    const translucent = /rgba\(.+,\s*0?\.\d+\)/.test(style.backgroundColor) || Number(style.opacity) < 1 || style.backdropFilter !== 'none';
    if (coversScreen && z > 0 && text.length < 30 && translucent) return hide(el, false);
    // A pop-up: a dialog or a large pinned box with a sales or newsletter pitch, or one that can be closed.
    const isDialog = el.matches('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog') || el.querySelector('[role="dialog"], [aria-modal="true"]') !== null;
    const pitch = POPUP_WORDS.test(text) || el.querySelector('input[type="email"]') !== null;
    const closable = el.querySelector(CLOSE_BUTTON) !== null;
    if ((isDialog || share > 0.2) && text.length < 2500 && (pitch || (isDialog && closable) || (coversScreen && closable && z > 0))) {
      return hide(el, false);
    }
    // A chat launcher: a small box in a bottom corner holding a messaging iframe.
    if (cfg.chats && r.bottom > vh - 200 && r.width < 500 && r.height < 750 && (r.left > vw / 2 || r.right < vw / 2)) {
      const frame = el.matches('iframe') ? el : el.querySelector('iframe');
      const hint = `${frame?.getAttribute('title') ?? ''} ${frame?.getAttribute('src') ?? ''} ${el.id} ${el.className}`;
      if (/chat|messag|support|help|widget/i.test(hint)) hide(el, false);
    }
  };

  /** A native <dialog> opened as a modal sits in the top layer and ignores z-index. */
  const hideOpenDialogs = () => {
    for (const d of Array.from(document.querySelectorAll('dialog[open]'))) {
      if (d.hasAttribute(MARK)) continue;
      const text = ((d as HTMLElement).innerText || '').replace(/\s+/g, ' ');
      const consent = cfg.cookieBanners && CONSENT_WORDS.test(text);
      if (POPUP_WORDS.test(text) || consent) hide(d, consent);
    }
  };

  // 3. Unlock scrolling that a modal or banner switched off.
  const unlockScrolling = () => {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const s = getComputedStyle(el);
      if (s.overflowY === 'hidden' || s.overflow === 'hidden') el.style.setProperty('overflow-y', 'visible', 'important');
      if (el === document.body && s.position === 'fixed') {
        el.style.setProperty('position', 'static', 'important');
        el.style.setProperty('top', 'auto', 'important');
      }
    }
    // Some locks blur or dim the page behind the pop-up.
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body > *'))) {
      const s = getComputedStyle(el);
      if (s.filter.includes('blur') && !el.hasAttribute(MARK)) el.style.setProperty('filter', 'none', 'important');
    }
  };

  hideKnownContainers();
  // Outer elements come first, so a hidden pop-up takes its pinned children with it.
  for (const el of pinnedElements()) hideIfOverlay(el);
  if (cfg.popups) hideOpenDialogs();
  if (document.querySelector(`[${MARK}]`)) unlockScrolling();

  // A banner hidden together with its own parts counts once.
  const outermost = counted.filter((el) => !counted.some((other) => other !== el && other.contains(el)));
  return {
    removed: outermost.length,
    cookieBanners: outermost.filter((el) => cookies.has(el) || Array.from(cookies).some((c) => el.contains(c))).length,
    textBefore,
    textAfter: textLength(),
  };
}

/**
 * Every class and id on the page, as ".name" and "#name". The filter lists'
 * selectors are cut down to the ones these can match before they are sent in.
 */
export function pageTokens(): string[] {
  const tokens = new Set<string>();
  for (const el of Array.from(document.querySelectorAll('[class], [id]'))) {
    if (el.id) tokens.add(`#${el.id}`);
    for (const name of Array.from(el.classList)) tokens.add(`.${name}`);
    if (tokens.size > 50_000) break;
  }
  return [...tokens];
}

/** Undoes `cleanPage`, for the rare page where the cleanup took the content with it. */
export function restorePage(): void {
  const MARK = 'data-shot-hidden';
  document.getElementById('shot-clean-style')?.remove();
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${MARK}]`))) {
    const prev = el.getAttribute(MARK);
    if (prev) el.setAttribute('style', prev);
    else el.removeAttribute('style');
    el.removeAttribute(MARK);
  }
}

export type OverlayKind = 'cookie_banner' | 'popup';

export interface OverlayConfig {
  cookieBanners: boolean;
  popups: boolean;
  words: typeof WORDS;
}

/**
 * The final check before the shot: is a cookie banner or pop-up still on
 * screen? Looks at layers pinned over the page (fixed, or a modal <dialog>),
 * also inside open shadow roots, and judges them by their words:
 *   - a cookie banner talks about cookies or consent, or is a consent
 *     manager's frame, and covers at least 5% of the screen;
 *   - a pop-up covers at least 15% and is a dialog, or makes a sign-up pitch
 *     over the middle of the screen or with an email field.
 * A bar along the top edge is a site's own header, and a layer with a lot of
 * text is the page itself; neither counts. The layer found is marked for
 * `closeOverlay`.
 */
export function findOverlay(cfg: OverlayConfig): OverlayKind | null {
  const FOUND = 'data-shot-overlay';
  const consentWords = new RegExp(cfg.words.consent, 'i');
  const popupWords = new RegExp(cfg.words.popup, 'i');
  const consentTalk = /consent|gdpr|(we|site|website) uses? cookies|cookie (settings|preferences|policy|notice)/i;
  const consentFrame = /consent|cookie|cmp|gdpr|privacy|sp_message/i;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  document.querySelectorAll(`[${FOUND}]`).forEach((el) => el.removeAttribute(FOUND));

  // Every element, also inside open shadow roots, where some consent tools draw their banner.
  const all: HTMLElement[] = [];
  const walk = (root: Document | ShadowRoot) => {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      if (all.length > 20000) return;
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);

  const textOf = (el: HTMLElement) => {
    const parts = [el.innerText || ''];
    for (const inner of [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))].slice(0, 2000)) {
      if (inner.shadowRoot) parts.push(...Array.from(inner.shadowRoot.children).map((c) => (c as HTMLElement).innerText || ''));
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };
  const frameHint = (el: HTMLElement) =>
    [el, ...Array.from(el.querySelectorAll('iframe'))]
      .filter((f): f is HTMLIFrameElement => f instanceof HTMLIFrameElement)
      .some((f) => consentFrame.test(`${f.id} ${f.name} ${f.title} ${f.src}`));

  for (const el of all) {
    if (el.closest('[data-shot-hidden]')) continue;
    const style = getComputedStyle(el);
    const modal = el instanceof HTMLDialogElement && el.open && el.matches(':modal');
    if (style.position !== 'fixed' && !modal) continue;
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.1) continue;
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const share = (w * h) / (vw * vh);
    if (share < 0.05) continue;
    const text = textOf(el);
    const email = el.querySelector('input[type="email"]') !== null;

    // Along the top edge, only plain consent talk counts: a shop's menu may say "Cookies".
    const headerBar = r.top <= 1 && r.height < vh * 0.25 && !email;
    const consent = frameHint(el) || (headerBar ? consentTalk.test(text) : consentWords.test(text));
    if (cfg.cookieBanners && text.length < 3000 && consent) {
      el.setAttribute(FOUND, '');
      return 'cookie_banner';
    }
    if (!cfg.popups || share < 0.15 || text.length >= 2500) continue;
    if (headerBar) continue;
    const dialog = modal || el.matches('[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
    const overMiddle = r.left < vw / 2 && r.right > vw / 2 && r.top < vh / 2 && r.bottom > vh / 2;
    if (dialog || (popupWords.test(text) && (overMiddle || email))) {
      el.setAttribute(FOUND, '');
      return 'popup';
    }
  }
  return null;
}

/**
 * Presses a refusal or close button in the layer `findOverlay` marked, if it
 * has one. Never a yes, and never a link that leads to another page.
 * Returns whether something was pressed.
 */
export function closeOverlay(cfg: OverlayConfig): boolean {
  const layer = document.querySelector<HTMLElement>('[data-shot-overlay]');
  if (!layer) return false;
  const refuse = new RegExp(cfg.words.refuse, 'i');
  const close = new RegExp(cfg.words.close, 'i');
  const roots: Array<HTMLElement | ShadowRoot> = [layer];
  for (const el of Array.from(layer.querySelectorAll('*'))) if (el.shadowRoot) roots.push(el.shadowRoot);
  const buttons = roots.flatMap((root) =>
    Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"], a, input[type="button"], input[type="submit"]')),
  ).filter((b) => {
    const href = b instanceof HTMLAnchorElement ? (b.getAttribute('href') ?? '') : '';
    return !href || href.startsWith('#') || href.startsWith('javascript:');
  });
  const label = (b: HTMLElement) =>
    (b.innerText || b.getAttribute('aria-label') || (b as HTMLInputElement).value || b.title || '').replace(/\s+/g, ' ').trim();
  const pick =
    buttons.find((b) => refuse.test(label(b))) ??
    buttons.find((b) => close.test(label(b))) ??
    buttons.find((b) => b.matches(cfg.words.closeSelector)) ??
    layer.querySelector<HTMLElement>(cfg.words.closeSelector);
  if (!pick) return false;
  pick.click();
  return true;
}

/**
 * Prepares a full-page shot. Some sites scroll inside a full-height container
 * instead of the document, which would make a "full page" shot one screen tall;
 * this lets that container grow to its content. Returns the page height.
 */
export function expandScrollContainer(): number {
  const height = () => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
  if (height() > window.innerHeight + 50) return height();
  let best: HTMLElement | null = null;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
    if (el.clientHeight < window.innerHeight * 0.5 || el.scrollHeight < el.clientHeight * 1.5) continue;
    const overflow = getComputedStyle(el).overflowY;
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    if (!best || el.scrollHeight > best.scrollHeight) best = el;
  }
  if (!best) return height();
  for (let el: HTMLElement | null = best; el && el !== document.documentElement; el = el.parentElement) {
    el.style.setProperty('height', 'auto', 'important');
    el.style.setProperty('max-height', 'none', 'important');
    el.style.setProperty('overflow', 'visible', 'important');
  }
  for (const el of [document.documentElement, document.body]) {
    el.style.setProperty('height', 'auto', 'important');
    el.style.setProperty('overflow', 'visible', 'important');
  }
  return height();
}

/**
 * Adds the "styles" option's CSS to the page. A constructed style sheet is
 * not subject to the page's Content-Security-Policy. Runs once per document.
 */
export function addStyles(css: string): void {
  if (window !== window.top) return;
  const w = window as unknown as { __shotStyles?: CSSStyleSheet };
  if (w.__shotStyles && document.adoptedStyleSheets.includes(w.__shotStyles)) return;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  w.__shotStyles = sheet;
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

export interface PageMetadata {
  title: string | null;
  description: string | null;
  /** og: tags without the prefix ("title", "image", "image:width"), at most 30. */
  openGraph: Record<string, string>;
  /** The page's icon: its own link tag, else /favicon.ico. */
  icon: string | null;
  /** Height of the document in CSS pixels. */
  height: number;
}

/** Reads the details returned with response_type=json: title, description, Open Graph tags, icon. */
export function readMetadata(): PageMetadata {
  const cut = (s: string | null | undefined) => (s ?? '').trim().slice(0, 1000) || null;
  const openGraph: Record<string, string> = {};
  for (const m of Array.from(document.querySelectorAll<HTMLMetaElement>('meta[property^="og:"], meta[name^="og:"]'))) {
    const key = (m.getAttribute('property') ?? m.getAttribute('name') ?? '').slice(3).trim();
    if (key && !(key in openGraph) && Object.keys(openGraph).length < 30) openGraph[key] = cut(m.content) ?? '';
  }
  const link = document.querySelector<HTMLLinkElement>('link[rel~="icon" i], link[rel~="apple-touch-icon" i]');
  const icon = link?.href || (/^https?:$/.test(location.protocol) ? new URL('/favicon.ico', location.href).href : null);
  return {
    title: cut(document.title),
    description: cut(document.querySelector<HTMLMetaElement>('meta[name="description" i]')?.content),
    openGraph,
    icon,
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
  };
}
