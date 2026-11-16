// Signed URLs: a GET request that carries an HMAC of its own query instead of
// the API key, so a shot can sit in an <img> or og:image tag without giving the
// key away. Anyone can read a signed URL, but changing any part of it breaks
// the signature.
//
//   signature = hex(HMAC-SHA256(SIGNING_SECRET, canonical query))
//
// The canonical query is every parameter except "signature", sorted by name,
// with names and values percent-encoded as in RFC 3986 (everything except
// A-Z a-z 0-9 - _ . ~), joined as name=value&name=value. An optional "expires"
// (Unix time in seconds) is signed with the rest and refused once it is past.

import { CaptureError } from './errors.ts';

/** RFC 3986 encoding: encodeURIComponent, plus the five characters it leaves alone. */
function encode(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The exact string that is signed. Duplicate names are refused, so what is signed is what is used. */
export function canonicalQuery(params: URLSearchParams): string {
  const pairs = [...params].filter(([name]) => name !== 'signature');
  const names = new Set<string>();
  for (const [name] of pairs) {
    if (names.has(name)) throw new CaptureError('invalid_options', `"${name}" appears twice in a signed URL.`);
    names.add(name);
  }
  return pairs
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${encode(name)}=${encode(value)}`)
    .join('&');
}

/** Hex HMAC-SHA256 of a canonical query. */
export async function sign(canonical: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(canonical)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Checks a signed request. Returns the expiry (Unix seconds) when the URL has
 * one, or null. Throws `unauthorized` when the signature is wrong or expired.
 * `same` compares in constant time.
 */
export async function verifySignedQuery(
  params: URLSearchParams,
  secret: string,
  same: (given: string, expected: string) => Promise<boolean>,
  now = Date.now(),
): Promise<number | null> {
  const given = (params.get('signature') ?? '').trim().toLowerCase();
  const expected = await sign(canonicalQuery(params), secret);
  if (!(await same(given, expected))) {
    throw new CaptureError(
      'unauthorized',
      'The signature does not match this URL. Sign every parameter except "signature", sorted by name, with your SIGNING_SECRET.',
      'signature_invalid',
    );
  }
  const expires = params.get('expires');
  if (expires === null) return null;
  if (!/^\d{1,12}$/.test(expires)) throw new CaptureError('invalid_options', '"expires" must be a Unix time in seconds.');
  const at = Number(expires);
  if (at * 1000 <= now) {
    throw new CaptureError('unauthorized', `This signed URL expired at ${new Date(at * 1000).toISOString()}.`, 'signature_expired');
  }
  return at;
}
