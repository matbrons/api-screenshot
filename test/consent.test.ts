import { describe, expect, it } from 'vitest';
import { consentToolName } from '../src/consent.ts';

describe('consentToolName', () => {
  it.each([
    ['Onetrust', 'OneTrust'],
    ['Cybotcookiebot', 'Cookiebot'],
    ['TrustArc-top', 'TrustArc'],
    ['Sourcepoint-frame', 'Sourcepoint'],
    ['usercentrics-api', 'Usercentrics'],
    ['shopify', 'Shopify'],
    ['didomi', 'Didomi'],
  ])('gives the common tools their own name: %s', (rule, name) => {
    expect(consentToolName(rule)).toBe(name);
  });

  it.each(['HEURISTIC', 'HEURISTIC-TIER2', 'HEURISTIC-REJECT', 'auto_NL_example.com_abc', 'BASERULE', '', null])(
    'calls a banner found by its look "generic": %s',
    (rule) => {
      expect(consentToolName(rule)).toBe('generic');
    },
  );

  it('keeps the rule name for a site with its own banner', () => {
    expect(consentToolName('airbnb')).toBe('airbnb');
  });

  it('never returns characters that break a header', () => {
    expect(consentToolName('some\r\nruleé')).toBe('somerule');
  });
});
