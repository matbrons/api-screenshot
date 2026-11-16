// The page details sent back with response_type=json or metadata, and by the
// MCP page_details tool.

import type { CaptureResult } from './capture.ts';
import type { ScreenshotOptions } from './options.ts';

/** The response for response_type=json (with the file in base64) and response_type=metadata (without). */
export function jsonBody(opts: ScreenshotOptions, result: CaptureResult) {
  const { info } = result;
  const meta = info.metadata;
  return {
    url: opts.url,
    final_url: info.finalUrl,
    status: info.status,
    title: meta?.title ?? null,
    description: meta?.description ?? null,
    icon: meta?.icon ?? null,
    open_graph: meta?.openGraph ?? {},
    page_height: info.pageHeight,
    removed_elements: info.removed,
    consent_manager: info.consentManager,
    overlay_remaining: info.overlayRemaining,
    truncated: info.truncated,
    ...(opts.responseType === 'json'
      ? { content_type: result.contentType, size: result.image.length, image: toBase64(result.image) }
      : {}),
  };
}

export function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
