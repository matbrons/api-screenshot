import { describe, expect, it } from 'vitest';
import { classifyPage, type PageSignals } from '../src/verdict.ts';

const article = 'A real article with plenty of words in it. '.repeat(60);
const page = (s: Partial<PageSignals>): PageSignals => ({
  host: 'example.com', status: 200, title: 'Example', text: article, mediaShare: 0.3, hasChallengeWidget: false,
  overlayText: '', challengeOverlay: false, ...s,
});

describe('classifyPage', () => {
  it('passes a normal page', () => expect(classifyPage(page({}))).toEqual({ kind: 'ok' }));

  it('spots a Cloudflare-style challenge', () => {
    expect(classifyPage(page({ status: 403, title: 'Just a moment...', text: 'Verifying you are human. This may take a few seconds.' })))
      .toMatchObject({ kind: 'blocked', reason: 'bot_check' });
  });

  it('spots a shop\'s "continue shopping" interstitial', () => {
    const text = 'Click the button below to continue shopping Continue shopping Conditions of Use Privacy Policy';
    expect(classifyPage(page({ title: 'Amazon.com', text }))).toMatchObject({ kind: 'blocked', reason: 'bot_check' });
  });

  it('spots a captcha widget on a thin page', () => {
    expect(classifyPage(page({ text: 'Please complete the check below.', hasChallengeWidget: true })))
      .toMatchObject({ kind: 'blocked', reason: 'captcha' });
  });

  it('spots a bot wall laid over a real page', () => {
    expect(classifyPage(page({ overlayText: 'Before we continue... Press & Hold to confirm you are a human (and not a bot).' })))
      .toMatchObject({ kind: 'blocked', reason: 'bot_check' });
    expect(classifyPage(page({ challengeOverlay: true }))).toMatchObject({ kind: 'blocked', reason: 'captcha' });
  });

  it('ignores ordinary overlays such as cookie banners', () => {
    expect(classifyPage(page({ overlayText: 'We use cookies to improve your experience. Accept all. Reject all.' }))).toEqual({ kind: 'ok' });
  });

  it('ignores a captcha widget on a long page (a login form, a comment box)', () => {
    expect(classifyPage(page({ hasChallengeWidget: true }))).toEqual({ kind: 'ok' });
  });

  it('does not flag an article that merely mentions bot checks', () => {
    expect(classifyPage(page({ text: `${article} Some sites ask you to verify you are human.` }))).toEqual({ kind: 'ok' });
  });

  it('spots consent walls', () => {
    expect(classifyPage(page({ host: 'consent.google.com' }))).toMatchObject({ kind: 'blocked', reason: 'consent_wall' });
    expect(classifyPage(page({ text: 'Before you continue to YouTube. We use cookies.' }))).toMatchObject({ reason: 'consent_wall' });
  });

  it('reports rate limits and refusals', () => {
    expect(classifyPage(page({ status: 429 }))).toMatchObject({ kind: 'blocked', reason: 'rate_limited' });
    expect(classifyPage(page({ status: 403, title: 'Forbidden', text: 'Forbidden' }))).toMatchObject({ reason: 'access_denied' });
  });

  it('reports server errors and missing pages', () => {
    expect(classifyPage(page({ status: 503 }))).toMatchObject({ kind: 'error_page', reason: 'http_503' });
    expect(classifyPage(page({ status: 404 }))).toMatchObject({ kind: 'error_page', reason: 'http_404' });
    expect(classifyPage(page({ status: 400, text: 'Bad request' }))).toMatchObject({ kind: 'error_page', reason: 'http_400' });
  });

  it('reports an app that crashed with a 200', () => {
    expect(classifyPage(page({ text: 'Application error: a client-side exception has occurred.' })))
      .toMatchObject({ kind: 'error_page', reason: 'crashed' });
  });

  it('reports a blank page, but not an image-only page', () => {
    expect(classifyPage(page({ text: '', mediaShare: 0 }))).toMatchObject({ kind: 'blank' });
    expect(classifyPage(page({ text: '', mediaShare: 0.8 }))).toEqual({ kind: 'ok' });
  });

  it('keeps a long page with an error-ish title', () => {
    expect(classifyPage(page({ title: 'Why something went wrong at the launch' }))).toEqual({ kind: 'ok' });
  });
});
