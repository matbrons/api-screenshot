# Notes for coding agents

This repo is a self-hosted screenshot API. One engine (`src/capture.ts`) drives a
puppeteer-compatible browser; a small Hono app (`src/app.ts`) puts an HTTP API
in front of it. Two entry points run the same app:

- `src/worker.ts`: Cloudflare Worker with Browser Rendering (`wrangler.jsonc`).
- `src/server.ts`: Node 22.19+ with a local Chromium (`Dockerfile`).

## Set it up for a user

Make a key first and give it to the user: `openssl rand -hex 32`. The API refuses
every screenshot until `API_KEY` is set to 16 characters or more
(`not_configured`); `ALLOW_PUBLIC_ACCESS=true` opens it to anyone instead, so
only use that on a private network.

On Cloudflare (needs their Cloudflare login; Browser Rendering is on the free plan):

    npm install
    npx wrangler login
    npx wrangler deploy
    echo "<key>" | npx wrangler secret put API_KEY
    APISHOT_TEST_URL=https://<worker-url> APISHOT_TEST_KEY=<key> ops/watch.sh

On a server with Docker:

    docker run -d --restart unless-stopped -p 3000:3000 -e API_KEY=<key> ghcr.io/matbrons/api-screenshot
    APISHOT_TEST_URL=http://localhost:3000 APISHOT_TEST_KEY=<key> ops/watch.sh

The image is published to GHCR by `.github/workflows/release.yml` when a `v*`
tag is pushed, so it exists only after the first release. Before that, build it
from the repo with `docker build -t api-screenshot .` and run `api-screenshot`.

On a machine without Docker (Node 22.19 or newer, with Chrome or Chromium
installed; set `CHROME_PATH` if it isn't found):

    npm install
    API_KEY=<key> HOST=127.0.0.1 npm start
    APISHOT_TEST_URL=http://localhost:3000 APISHOT_TEST_KEY=<key> ops/watch.sh

`HOST=127.0.0.1` keeps it to that machine; leave it out on a server.

If the user has their own proxies, add `-e PROXY_URLS="http://user:pass@proxy1.example.com:8080,http://user:pass@proxy2.example.com:8080"`
(percent-encode a comma or space in a password). Set `BROWSER_LANGUAGE` and
`BROWSER_TIMEZONE` to match where the server or proxies are, such as `nl-NL`
and `Europe/Amsterdam`. Proxies don't work on Cloudflare: there, setting
`PROXY_URL` or `PROXY_URLS` turns screenshots off with `not_configured`.

`ops/watch.sh` prints OK, WARN or FAIL per check and exits 1 on a failure. On
Cloudflare's free plan, keep `BROWSER_KEEP_ALIVE_SECONDS` at 0: an idle browser
uses up the 10 browser minutes a day. Settings and every option are in README.md.

The key goes in the `Authorization: Bearer` or `X-API-Key` header, never in the
URL: a request with `access_key` in the query is refused. If the user wants
shots in `<img>` or `og:image` tags, make a second secret the same way and set it as `SIGNING_SECRET` (a Worker secret, or `-e` in Docker);
README.md, "Signed URLs", shows how to sign a URL. Shots are cached for a day
by default (`CACHE_TTL_SECONDS`): on Cloudflare in the KV namespace the deploy
creates, in Docker in `/var/cache/api-screenshot`.

To let the user's AI agent take screenshots, connect it to `/mcp` on the same
host with the same key. For Claude Code:

    claude mcp add --transport http screenshot https://<worker-url>/mcp --header "Authorization: Bearer <key>"

Other clients are in README.md, "Use it from an AI agent". `/mcp` has two tools,
`screenshot` and `page_details`. Signed URLs don't work there, so a server that
only has `SIGNING_SECRET` also needs `API_KEY` for it. `/openapi.json` describes
the HTTP API and needs no key.

## Work on the code

    npm install
    npm test               # unit tests; browser tests run too when Chrome is installed
    npm run typecheck
    npm run build:worker   # the Worker bundles; no deploy
    npm run live-test      # 30 real sites, on demand only; look at the shots

Where things live:

| File | Job |
| --- | --- |
| `src/options.ts` | Parses and validates request options, device presets, `block_requests` patterns. Add new options here, in `src/option-schema.ts` (a test fails otherwise) and in README.md. |
| `src/guard.ts` | Which addresses the browser may reach (SSRF guard) |
| `src/node-browser.ts` | Server only: the local Chromium, its desktop-Chrome settings, and the retry through the next proxy |
| `src/egress-proxy.ts` | Server only: the proxy all browser traffic goes through |
| `src/signing.ts` | Signed URLs (`SIGNING_SECRET`): the canonical query and its HMAC |
| `src/cache.ts` | Keeps finished shots; the Workers KV store (`CACHE` binding) |
| `src/disk-cache.ts` | Server only: the cache folder with its size cap |
| `src/proxy.ts` | Reads a user's own proxy URLs (`PROXY_URL`, `PROXY_URLS`, the `proxy` option) |
| `src/proxy-pool.ts` | Server only: takes the proxies from `PROXY_URLS` in turn and rests one that fails |
| `src/retry.ts` | Retries a capture within its `timeout`; `fail_on_status` |
| `src/upstream-proxy.ts` | Server only: connects through that proxy (HTTP CONNECT, SOCKS5) |
| `src/worker-browser.ts` | Worker only: gets a browser within Cloudflare's limits |
| `src/capture.ts` | One capture from start to finish |
| `src/consent.ts` | Cookie banners through autoconsent |
| `src/blocklists.ts` | Ad, tracker and cookie-banner blocking from the filter lists (both runtimes) |
| `src/blocklists-build.ts` | Node only: fetches and compiles the filter lists |
| `scripts/blocklists.ts` | Writes `src/generated/blocklists.ts` before each Worker build |
| `src/page-scripts.ts` | Code that runs inside the page (cleanup, scrolling, signals, `styles`, page details for `response_type=json`) |
| `src/verdict.ts` | Decides if a page is real, blocked, blank or an error |
| `src/errors.ts` | Error codes and their HTTP statuses |
| `src/option-schema.ts` | A JSON Schema for every option, for `/openapi.json` and the MCP tools |
| `src/openapi.ts` | The OpenAPI description at `/openapi.json` |
| `src/mcp.ts` | The MCP server at `/mcp`: the `screenshot` and `page_details` tools |
| `src/details.ts` | The JSON for `response_type=json` and `metadata`, shared with `page_details` |
| `ops/watch.sh` | Checks a running install from the outside |
| `ops/live-sites.txt` | The real sites `npm run live-test` and `ops/smoke-sites.sh --all` shoot |
| `ops/smoke-sites.sh` | Shoots real sites through a running install (a few, or `--all`) |
| `.github/workflows/ci.yml` | Tests, Worker bundle, Docker image with real screenshots |

Rules that keep it safe:

- With no usable `API_KEY` and no `ALLOW_PUBLIC_ACCESS`, screenshots are refused. Keep it that way.
- Every URL the browser loads must pass `checkUrl`, and `checkHost` where DNS is available. Fail closed.
- A user's own proxy goes behind the egress proxy, never around it: it is handed the checked IP, never the name.
- A proxy's login is never logged or put in an error message. Use `describeProxy` to name one.
- Every proxy from the list goes behind the egress proxy too. A retry never skips the guard, and a refused address is never retried.
- On a server the browser reads as a desktop Chrome (`DESKTOP_CHROME`): a user agent and client hints without "HeadlessChrome", `navigator.webdriver` false, a desktop-sized screen. Nothing beyond that: no stealth plugins, no faked hardware, canvas, WebGL or fonts, no captcha solving.
- Never return a shot of a captcha, bot wall or error page as a success: extend `verdict.ts` instead.
- The cache is read only after the key or signature is checked, and only real shots go in it; errors are never cached.
- A signed request takes its options from exactly the parameters that were signed.
- `/mcp` uses the same key check and the same `shoot` path as `/screenshot`. Never give it a check or a capture of its own.
- Every option lives in `ScreenshotOptions`, which is hashed whole into the cache key. Never keep an option outside it.
- The request's own `scripts`, `click`, `html`, `headers` and `cookies` run under the same guard as the page: never skip the request check for them. Extra `headers` go only to the requested site and its subdomains.
- Functions passed to `page.evaluate` run inside the page. They cannot use imports or outer variables.
- TypeScript is run as is by Node (type stripping), so use only erasable syntax: no enums, no namespaces.
- The filter lists are fetched at build or start, never committed. `src/generated/` is written by `npm run generate` (tests, typecheck and the Worker build run it) and ignored by git.
- Never add a postinstall step: files the build needs are made by `npm run generate`.
- Keep `src/blocklists-build.ts` (and the list parser) out of anything `src/worker.ts` imports; a test checks the Worker bundle.
