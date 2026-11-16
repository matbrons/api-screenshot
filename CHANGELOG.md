# Changelog

## 0.1.2 (2026-11-15)

- On Cloudflare's free plan, a used-up day of browser time now answers `quota_exceeded` with a `Retry-After` until 00:00 UTC, instead of `busy`.
- Downloading the ad and tracker lists no longer crashes a build when a connection closes early, and a failed download is retried.
- Node 22.19 or newer.

## 0.1.1 (2026-11-15)

- Listed in the MCP registry: the Docker image carries its `io.modelcontextprotocol.server.name` label, and `server.json` describes the server.

## 0.1.0 (2026-11-15)

The first release.

- Full-page or first-screen shots as PNG, JPEG, WebP or PDF, or JSON with the page's title, description, Open Graph tags and icon.
- Cookie banners dismissed with DuckDuckGo's autoconsent, refusing consent where the site allows it. Pop-ups, chat widgets and sticky overlays removed. A banner that survives is named in `x-overlay-remaining`.
- Ads and trackers blocked with EasyList and EasyPrivacy.
- Lazy images loaded before a full-page shot. Tall pages cut at `full_page_max_height` and at 16,384 device pixels, with `x-truncated`. Width times `device_scale_factor` up to 3,840 device pixels.
- Captchas, bot walls, error pages and blank pages reported as errors with a reason, never returned as a shot.
- Device presets, clips, element shots, clicks, your own scripts and styles, extra headers and cookies, request and resource blocking, dark mode, language and time zone.
- An API key, signed URLs with an optional expiry, and an SSRF guard on every URL, redirect and request the page makes.
- Finished shots cached: in Workers KV on Cloudflare, in a folder on a server.
- Two ways to run it: a Cloudflare Worker on Browser Rendering with a deploy button, and a Docker image with Chromium for amd64 and arm64.
- On a server: your own proxy or a list of them, taken in turn, with a retry through the next. The browser reads as a desktop Chrome: a user agent without "HeadlessChrome", no automation flag, a desktop screen.
- Retries after a browser crash, a timeout or a blank page, and `fail_on_status`.
- An MCP server at `/mcp` with `screenshot` and `page_details` tools for AI agents, and an OpenAPI description at `/openapi.json`.
