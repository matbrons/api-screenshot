# api-screenshot

[![CI](https://github.com/matbrons/api-screenshot/actions/workflows/ci.yml/badge.svg)](https://github.com/matbrons/api-screenshot/actions/workflows/ci.yml)

A screenshot API you run yourself. It takes full-page shots of real sites with the cookie banners, pop-ups, chat widgets and ads removed. It runs on your own Cloudflare account or on any server with Docker.

Examples and docs: [apiscreenshot.com](https://apiscreenshot.com). Measured: [how many shots Cloudflare's free plan gives](https://apiscreenshot.com/blog/cloudflare-free-plan-screenshots) and [what a server needs to run it](https://apiscreenshot.com/blog/self-hosted-screenshot-api-docker).

![Before: allbirds.com behind a country pop-up and a cookie consent box. After: the same page with both gone, as the API returns it.](docs/before-after.webp)

```sh
curl -H "Authorization: Bearer $API_KEY" \
  "https://api-screenshot.your-subdomain.workers.dev/screenshot?url=https://www.theguardian.com&full_page=true" -o shot.png
```

- Cookie banners, pop-ups, chat widgets and ads removed by default.
- A captcha, bot check or error page comes back as an error that says so, never as a picture of it.
- Safe to put on the internet: its own API key, a guard against requests to private addresses, and limits.
- One API, on your Cloudflare account or on any server with Docker.

**Contents:** [Run it](#run-it) ([Cloudflare](#on-cloudflare), [your own server](#on-your-own-server), [safe by default](#safe-by-default)) · [Use it](#use-it) ([JSON](#json-and-page-details), [signed URLs](#signed-urls), [caching](#caching), [options](#options), [errors](#errors)) · [Use it from an AI agent](#use-it-from-an-ai-agent) · [Settings](#settings) · [Ads, trackers and filter lists](#ads-trackers-and-filter-lists) · [Sites that block bots](#sites-that-block-bots) ([retries](#retries)) · [Safety](#safety) · [Limits](#limits) · [Develop](#develop)

## Run it

### On Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/matbrons/api-screenshot)

The button asks you to sign in to Cloudflare and connect GitHub, then copies this repo to your GitHub account and deploys it to your Cloudflare account. It asks for one secret, `API_KEY`: paste a long random string, for example from `openssl rand -hex 32`, and keep it. Your API is then at `https://api-screenshot.<your-subdomain>.workers.dev`.

Or from a clone:

```sh
git clone https://github.com/matbrons/api-screenshot && cd api-screenshot
npm install
npx wrangler login
npx wrangler deploy
API_KEY=$(openssl rand -hex 32); echo "Your API key: $API_KEY"
echo "$API_KEY" | npx wrangler secret put API_KEY
```

On a new account, the first deploy asks you to pick your `workers.dev` subdomain. It also creates the KV namespace for the cache and writes its id into `wrangler.jsonc`, so that file shows as changed afterwards; keep the change. To check it all works (this takes one real shot):

```sh
APISHOT_TEST_URL=https://api-screenshot.<your-subdomain>.workers.dev APISHOT_TEST_KEY=$API_KEY ops/watch.sh
```

It uses [Browser Rendering](https://developers.cloudflare.com/browser-rendering/), which the free Workers plan includes with a daily limit (see [Limits](#limits)).

### On your own server

```sh
API_KEY=$(openssl rand -hex 32); echo "Your API key: $API_KEY"
docker run -d --restart unless-stopped -p 3000:3000 -e API_KEY="$API_KEY" ghcr.io/matbrons/api-screenshot
```

The image runs on amd64 and arm64. It is published when a version is tagged, so it appears after the first release. To build it yourself instead: `docker build -t api-screenshot .`

Or without Docker, with Node 22.19 or newer and Chrome or Chromium installed:

```sh
npm install
API_KEY=$(openssl rand -hex 32); echo "Your API key: $API_KEY"
API_KEY="$API_KEY" HOST=127.0.0.1 npm start
```

It finds Chrome or Chromium on its own; set `CHROME_PATH` if it doesn't. `HOST=127.0.0.1` keeps it to your own machine; leave it out on a server, where it listens on every address.

The server path uses a real Chromium. Whether it gets past more bot walls than the Worker depends mostly on your server's IP address: see [Sites that block bots](#sites-that-block-bots).

### Safe by default

A screenshot API on a public URL lets anyone spend your browser time. So until `API_KEY` (or `SIGNING_SECRET`, for [signed URLs](#signed-urls)) is set, every screenshot request is refused with `not_configured`, and so is a key shorter than 16 characters or one copied from an example. If you really want it open, for example on a private network, set `ALLOW_PUBLIC_ACCESS=true`.

## Use it

```sh
# GET with query options
curl -H "Authorization: Bearer $API_KEY" \
  "http://localhost:3000/screenshot?url=https://example.com&full_page=true&format=jpeg" -o shot.jpg

# POST with a JSON body
curl -X POST http://localhost:3000/screenshot \
  -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"url": "https://example.com", "viewport_width": 390, "viewport_mobile": true}' -o shot.png
```

The key can also go in an `X-API-Key` header. It is never taken from the URL, where it would end up in logs and browser history: a request with `access_key` in the query is refused. To put a shot in an `<img>` tag or a link, use a [signed URL](#signed-urls).

A shot comes back as the image (or PDF) itself, with these headers:

| Header | Value |
| --- | --- |
| `x-final-url` | The URL after redirects |
| `x-target-status` | The HTTP status the site answered with |
| `x-removed-elements` | How many things were removed from the shot: the cookie banner, whether it was answered or hidden, plus each pop-up, backdrop, chat widget or ad that was showing. A banner and its own parts count as one. `0` when there was nothing to remove. |
| `x-consent-manager` | The consent tool behind the cookie banner that was removed (see below). Not sent when no banner was removed. |
| `x-page-height` | The page's full height in CSS pixels |
| `x-truncated` | `true` when the shot was cut off: the page (or the `selector` element) was taller than `full_page_max_height`, or than 16384 device pixels (see Limits) |
| `x-cache` | `HIT` when the shot came from the cache, `MISS` when it was taken now and kept, `BYPASS` when the cache wasn't read (`fresh`, or caching off). See [Caching](#caching). |
| `age` | On a `HIT`: seconds since the shot was taken |
| `x-overlay-remaining` | `cookie_banner` or `popup` when one is still on screen in the shot, after every attempt to remove it. Not sent when the shot is clean. |

`x-consent-manager` is one of:

- The tool's name, for the common ones: `OneTrust`, `Cookiebot`, `Didomi`, `Usercentrics`, `Sourcepoint`, `TrustArc`, `Quantcast`, `consentmanager`, `CookieYes`, `Complianz`, `iubenda`, `Osano`, `Shopify` and others.
- For a site with a banner of its own, the name of autoconsent's rule for it, usually the site (`airbnb`).
- `generic`: a banner recognised by its look and words, not by a known tool.

Before the shot, a last check looks for a cookie banner or pop-up that is still covering part of the screen. If it finds one, it presses Escape, then the banner's reject or close button (never accept), and cleans up again. One that survives all that is left in the shot and named in `x-overlay-remaining`, so you can retry or flag it. A site's own sticky header or menu doesn't count, even when it has a "Sign up" link.

### JSON and page details

With `response_type=json` the answer is JSON instead of the file: the page's details plus the image or PDF in base64. `response_type=metadata` gives the details alone and skips the shot, which is quicker.

```json
{
  "url": "https://example.com/",
  "final_url": "https://example.com/",
  "status": 200,
  "title": "Example Domain",
  "description": null,
  "icon": "https://example.com/favicon.ico",
  "open_graph": { "title": "...", "image": "https://..." },
  "page_height": 800,
  "removed_elements": 0,
  "consent_manager": null,
  "overlay_remaining": null,
  "truncated": false,
  "content_type": "image/png",
  "size": 18734,
  "image": "iVBORw0KGgo..."
}
```

`open_graph` holds the page's `og:` tags without the prefix. `icon` is the page's own icon link, or `/favicon.ico` when it has none (which may not exist).

### Signed URLs

To put a shot straight into an `<img>` or `og:image` tag without giving away your key, sign the URL instead. Set a second secret, `SIGNING_SECRET` (16 characters or more, for example from `openssl rand -hex 32`; on Cloudflare `echo "$SIGNING_SECRET" | npx wrangler secret put SIGNING_SECRET`, or add it under the Worker's settings), then add a `signature` to each URL:

1. Take every parameter, including `expires` if you want the link to stop working at some point (a Unix time in seconds).
2. Sort them by name, percent-encode names and values (everything except `A-Z a-z 0-9 - _ . ~`) and join them as `name=value&name=value`.
3. `signature` is the HMAC-SHA256 of that string with `SIGNING_SECRET`, in hex.

Anyone can read a signed URL, but changing, adding or removing any parameter breaks it. A wrong signature gets `unauthorized` with `reason: signature_invalid`, an expired one `reason: signature_expired`. Only GET requests can be signed. Make signed URLs on your server, never in the browser, so the secret stays with you.

In Node.js:

```js
import { createHmac } from 'node:crypto';

const encode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function signedUrl(base, options, secret) {
  const query = Object.keys(options).sort()
    .map((name) => `${encode(name)}=${encode(String(options[name]))}`)
    .join('&');
  const signature = createHmac('sha256', secret).update(query).digest('hex');
  return `${base}/screenshot?${query}&signature=${signature}`;
}

signedUrl('https://api-screenshot.your-subdomain.workers.dev', {
  url: 'https://example.com',
  full_page: true,
  expires: Math.floor(Date.now() / 1000) + 7 * 24 * 3600, // optional: valid for a week
}, process.env.SIGNING_SECRET);
```

In a shell, with the query already sorted and encoded:

```sh
QUERY='full_page=true&url=https%3A%2F%2Fexample.com'
SIG=$(printf '%s' "$QUERY" | openssl dgst -sha256 -hmac "$SIGNING_SECRET" -r | cut -d' ' -f1)
echo "https://api-screenshot.your-subdomain.workers.dev/screenshot?$QUERY&signature=$SIG"
```

With only `SIGNING_SECRET` set and no `API_KEY`, the API takes signed URLs and nothing else.

### Caching

A finished shot is kept for a day, so the same request again comes back at once and costs no browser time. Requests count as the same when their options are, after defaults are filled in: `url=example.com` and `url=https://example.com/` share one shot. Only real shots are kept. A `blocked`, `blank` or any other error is never cached, so the next request tries again.

The cache is checked after the key or signature, so a cached shot never goes to someone who couldn't have asked for it. The `x-cache` header says whether a shot came from the cache. `cache-control` tells browsers how long they may keep it too: `private` for requests with the key, `public` for signed URLs (never past their `expires`), so a CDN in front can serve them.

On Cloudflare, shots are kept in Workers KV; the deploy creates the namespace for you. On a server they are kept in a folder, `CACHE_DIR`, up to `CACHE_MAX_MB`, and the shots used longest ago make room for new ones. In Docker that folder is `/var/cache/api-screenshot`; add `-v api-screenshot-cache:/var/cache/api-screenshot` to `docker run` to keep the shots when the container is replaced.

### Options

Option names match the ones common to hosted screenshot APIs, so most requests written for one of those work here unchanged. An unknown option is refused, so a typo doesn't fail silently.

| Option | Default | What it does |
| --- | --- | --- |
| `url` | required | The page to shoot. `https://` is added when missing. |
| `html` | | Markup to render instead of a `url`, in a POST body, up to a million characters. Everything it loads still passes the [address checks](#safety). Relative links have no base: use full URLs or a `<base href>`. Banner and pop-up removal are off for it unless you turn them on. |
| `format` | `png` | `png`, `jpeg`, `webp` or `pdf` |
| `image_quality` | `80` | 1 to 100, for jpeg and webp |
| `response_type` | `by_format` | `by_format`: the file itself. `json`: details and the file in base64. `metadata`: details only, no shot. See [JSON and page details](#json-and-page-details). |
| `full_page` | `false` | The whole page instead of the first screen |
| `full_page_max_height` | `10000` | Cut the page off here, in CSS pixels |
| `viewport_device` | | A device's screen size, scale and user agent: `iphone_se`, `iphone_13`, `iphone_13_pro_max`, `iphone_15`, `iphone_15_pro`, `iphone_15_pro_max`, `iphone_16`, `pixel_5`, `galaxy_s8`, `ipad`, `ipad_mini`, `ipad_pro_11`, `ipad_pro`, `galaxy_tab_s4`, `laptop` or `desktop`. Add `_landscape` to turn it. The `viewport_*` options below still change single values. |
| `viewport_width` | `1280` | 240 to 3840 |
| `viewport_height` | `800` | 240 to 2400 |
| `device_scale_factor` | `1` | 0.5 to 3. Use 2 for sharp text on retina screens. `viewport_width` (or `clip_width`) times this can be at most 3840 device pixels: 1920 at 2, 1280 at 3. A tall shot is cut at 16384 device pixels: 8192 CSS pixels at 2. |
| `viewport_mobile` | `false` | Mobile user agent and touch |
| `wait_until` | `networkidle2` | `load`, `domcontentloaded`, `networkidle0` or `networkidle2` |
| `wait_for_selector` | | Wait until this CSS selector is on the page |
| `delay` | `0` | Extra seconds to wait before the shot, up to 10 |
| `timeout` | `30` | Seconds for the whole capture, up to `MAX_TIMEOUT_SECONDS` |
| `selector` | | Shoot only this element |
| `clip_x`, `clip_y`, `clip_width`, `clip_height` | | Shoot this part of the page, in CSS pixels from its top left. Width and height are needed; x and y start at 0. Can't be used with `full_page` or `selector`. |
| `hide_selectors` | | CSS selectors to hide |
| `click` | | CSS selectors to click, in order, before the shot, up to 10. One that matches nothing fails with `selector_not_found`. |
| `styles` | | CSS added to the page |
| `scripts` | | JavaScript run in the page before the shot, after clicks. It may use `await`. An error fails with `script_error`. |
| `block_cookie_banners` | `true` | Dismiss cookie banners, refusing consent where the site allows it |
| `block_popups` | `true` | Remove newsletter pop-ups, modals and sticky overlays |
| `block_chats` | `true` | Remove chat widgets and other corner widgets (the reCAPTCHA badge, push-notification prompts) |
| `block_ads` | `true` | Block ads: requests to ad networks, and the empty ad boxes left on the page. Uses [EasyList](https://easylist.to). |
| `block_trackers` | `true` | Block tracking scripts and pixels, using [EasyPrivacy](https://easylist.to). Their banners and badges go with them. |
| `block_requests` | | Requests not to load, up to 100. A host (`ads.example.com`) blocks it and its subdomains; a pattern with `*` matches the whole URL (`*.example.com/track/*`, `*.mp4`). |
| `block_resources` | | Kinds of request not to load: `image`, `media`, `font`, `stylesheet`, `script`, `xhr`, `fetch`, `websocket`, `document` (frames; never the page itself), `texttrack`, `eventsource`, `manifest`, `prefetch`, `ping`, `other` and a few rarer ones |
| `headers` | | Extra request headers, one `Name: value` per line, or a JSON object. Sent only to the page's own site and its subdomains, never to the other sites it loads from. `Host`, `Cookie`, `User-Agent` and connection headers can't be set. |
| `cookies` | | Cookies set before the page loads, one per line: `name=value; Domain=example.com; Path=/; Secure; HttpOnly; SameSite=Lax`. Without `Domain` a cookie belongs to `url`. |
| `user_agent` | | The user agent to send, in place of the browser's own |
| `accept_language` | | Languages in order, such as `de-DE,de`. Sets the `Accept-Language` header, `navigator.language` and how dates and numbers are written. |
| `time_zone` | | A time zone such as `Europe/Berlin` |
| `dark_mode` | `false` | Ask the page for its dark theme |
| `reduced_motion` | `false` | Ask the page to turn off animations |
| `media_type` | | `screen` or `print`: the CSS media type. A PDF uses `print` unless set (or `screen` with `pdf_fit_one_page`). |
| `omit_background` | `false` | Transparent background where the page has none (png, webp and pdf) |
| `pdf_paper_format` | `letter` | `letter`, `legal`, `tabloid`, `ledger` or `a0` to `a6` |
| `pdf_landscape` | `false` | Turn the paper sideways |
| `pdf_print_background` | `true` | Print background colours and images |
| `pdf_fit_one_page` | `false` | One page as wide as the viewport and as tall as the page, instead of paper pages. Cut at `full_page_max_height`. |
| `pdf_margin` | `0` | Margin on every side, such as `20px`, `1cm`, `0.5in` or `10mm`. `pdf_margin_top`, `pdf_margin_right`, `pdf_margin_bottom` and `pdf_margin_left` set one side. |
| `proxy` | | Server only, and only when `ALLOW_REQUEST_PROXY` is on: your own proxy for this shot. See [Sites that block bots](#sites-that-block-bots). |
| `retry` | `1` | 0 to 2: more tries after a browser crash, a timeout or a blank page, and, with a list of proxies, after a blocked page or a failed proxy. All tries share `timeout`. See [Retries](#retries). |
| `fail_on_status` | | HTTP statuses that make the request fail with `error_page` instead of returning a shot, such as `404,500-599` or a JSON array |
| `cache_ttl` | `86400` | Seconds a cached shot may be reused, and how long a new one is kept, up to 2592000 (30 days). `0` takes a new shot and keeps nothing. The default is `CACHE_TTL_SECONDS`. |
| `fresh` | `false` | Take a new shot even when one is cached, and keep it in place of the old one |
| `cache_key` | | Any text, up to 200 characters, to keep a separate copy of the same shot |
| `cache` | `true` | `false` is the same as `cache_ttl=0` |
| `signature`, `expires` | | For [signed URLs](#signed-urls) |

Lists (`hide_selectors`, `click`, `block_requests`, `block_resources`, `headers`, `cookies`) can be a JSON array, or in a query string the same option given more than once. `hide_selectors`, `block_requests` and `block_resources` also take one comma-separated value; `click`, `headers` and `cookies`, whose values may hold commas, take one per line (`%0A` in a URL). A signed URL can't repeat an option, so use the single-value form there.

### Errors

Anything that isn't a shot is JSON: `{"error": "blocked", "reason": "captcha", "message": "..."}`.

| `error` | Status | Meaning |
| --- | --- | --- |
| `invalid_options` | 400 | The request is wrong. The message says which option. |
| `unauthorized` | 401 | The API key is missing or wrong, or a signed URL is wrong (`reason: signature_invalid`) or expired (`reason: signature_expired`) |
| `url_not_allowed` | 403 | A private, local or unsafe address, also after a redirect |
| `blocked` | 422 | A captcha, bot check or consent wall stood in front of the page. `reason` is `captcha`, `bot_check`, `consent_wall`, `access_denied` or `rate_limited`. |
| `blank` | 422 | The page rendered nothing |
| `error_page` | 422 | The site showed its own error. `reason` is `http_404`, `http_503` and so on, or `crashed`. Also when the browser ended on its own error page; `reason` is then the browser's error code, such as `ERR_TOO_MANY_REDIRECTS`. |
| `selector_not_found` | 422 | `selector`, `wait_for_selector` or `click` matched nothing |
| `script_error` | 422 | Your `scripts` threw an error (the message has it) or didn't finish in time |
| `unreachable` | 502 | DNS, TLS or the connection failed, also on a redirect or a later navigation. `reason` is the browser's error code, such as `ERR_NAME_NOT_RESOLVED`. |
| `proxy_not_allowed` | 403 | `proxy` was sent, but this server doesn't take one from a request, or it points at a private address |
| `proxy_error` | 502 | Your proxy failed: wrong login, refused or didn't answer. The message says which. |
| `busy` | 503 | All browsers are in use. Try again shortly. On Cloudflare, if it goes on for minutes, today's browser time may be used up without Cloudflare saying so; the message says this too. |
| `quota_exceeded` | 429 | Cloudflare only: today's browser time is used up. It resets at 00:00 UTC. The `Retry-After` header gives the seconds until then. |
| `browser_unavailable` | 503 | No browser could be started |
| `not_configured` | 503 | No usable `API_KEY` or `SIGNING_SECRET` is set, or `PROXY_URL` or `PROXY_URLS` can't be used, so screenshots are off. The message says which. |
| `timeout` | 504 | The capture took longer than `timeout` |

## Use it from an AI agent

The API is also an MCP server at `/mcp`, so Claude, Cursor and other AI tools can take screenshots themselves. It takes the same API key and has two tools:

- `screenshot`: the page as an image, with a short note next to it: the final URL, the HTTP status, the title, how many banners and pop-ups were removed, and whether the page was cut off.
- `page_details`: the page's details as JSON, without an image, as with `response_type=metadata`.

A captcha, bot wall, error page or blank page comes back as a tool error with the same code and message as from `/screenshot`, never as an image.

Claude Code:

```sh
claude mcp add --transport http screenshot https://api-screenshot.your-subdomain.workers.dev/mcp \
  --header "Authorization: Bearer $API_KEY"
```

Cursor (`~/.cursor/mcp.json`) and other clients that take a URL and headers:

```json
{
  "mcpServers": {
    "screenshot": {
      "url": "https://api-screenshot.your-subdomain.workers.dev/mcp",
      "headers": { "Authorization": "Bearer ${env:API_SCREENSHOT_KEY}" }
    }
  }
}
```

Claude Desktop, through [mcp-remote](https://github.com/geelen/mcp-remote), in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "screenshot": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://api-screenshot.your-subdomain.workers.dev/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer <your API key>" }
    }
  }
}
```

Any other client: MCP over Streamable HTTP at `https://<your host>/mcp`, with the key as `Authorization: Bearer <key>` or `X-API-Key: <key>`. The server keeps no sessions, so it runs the same on Cloudflare and on your own server.

To check it by hand, send a JSON-RPC request with both content types in `Accept`:

```sh
curl https://<your host>/mcp -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The tools return what AI clients can take: a JPEG of the first screen unless asked otherwise, one pixel per CSS pixel, a full page cut at 4,000 px (`full_page_max_height` goes up to 8,000), and at most 3 MB. A bigger shot is refused with a hint to make it smaller. Most clients scale a tall image down, so for small text a selector or a phone `viewport_device` reads better than a whole page.

For tools that read an API description instead, `/openapi.json` describes `/screenshot` in OpenAPI 3.1, with your server's limits filled in. It needs no key.

## Settings

Environment variables on a server. On Cloudflare, `API_KEY` and `SIGNING_SECRET` are secrets and the rest are `vars` in `wrangler.jsonc`:

| Variable | Default | |
| --- | --- | --- |
| `API_KEY` | none | Every request must carry it. 16 characters or more. Without it, screenshots are refused. |
| `SIGNING_SECRET` | none | Turns on [signed URLs](#signed-urls). 16 characters or more. Use a different one from `API_KEY`. |
| `ALLOW_PUBLIC_ACCESS` | `false` | `true` serves screenshots without a key, to anyone who can reach the URL |
| `MAX_TIMEOUT_SECONDS` | `60` | The longest `timeout` a request may ask for |
| `MAX_FULL_PAGE_HEIGHT` | `20000` | The tallest full-page shot a request may ask for |
| `BROWSER_KEEP_ALIVE_SECONDS` | `0` | Cloudflare only: `0` closes the browser after each shot. 60 to 600 keeps it open that long for the next shot, which is faster but spends browser time while idle. |
| `MAX_CONCURRENCY` | `2` | Server only: shots taken at the same time |
| `PORT`, `HOST` | `3000`, `0.0.0.0` | Server only |
| `CHROME_PATH` | found automatically | Server only |
| `CHROME_NO_SANDBOX` | | Server only: `1` runs Chromium without its own sandbox. The Docker image sets it and runs as an unprivileged user instead. |
| `PROXY_URL` | none | Server only: send all browser traffic through your own proxy, such as `http://user:pass@proxy.example.com:8080` or `socks5://user:pass@proxy.example.com:1080` |
| `PROXY_URLS` | none | Server only: a list of your own proxies, separated by commas, spaces or new lines. Shots take them in turn; a retry goes through the next one. May be set together with `PROXY_URL`. |
| `ALLOW_REQUEST_PROXY` | `false` | Server only: `true` lets a request bring its own `proxy`. Needs `API_KEY`. |
| `CACHE_TTL_SECONDS` | `86400` | How long a shot is kept and reused when a request doesn't set `cache_ttl`. `0` turns the cache off. |
| `CACHE_DIR` | `api-screenshot-cache` in the temp folder; `/var/cache/api-screenshot` in Docker | Server only: where shots are kept |
| `CACHE_MAX_MB` | `1024` | Server only: the most the cache folder may hold. `0` turns the cache off. |
| `DESKTOP_CHROME` | `true` | Server only: the browser reads as a desktop Chrome (user agent, no automation flag, desktop screen). `false` lets it show as headless Chromium. See [Sites that block bots](#sites-that-block-bots). |
| `BROWSER_LANGUAGE` | `en-US` | Server only: the browser's language, sent to sites in `Accept-Language` |
| `BROWSER_TIMEZONE` | `America/New_York` | Server only: the browser's time zone, such as `Europe/Amsterdam` |
| `FETCH_BLOCKLISTS` | `true` | Server only: `false` skips the filter lists and uses the small built-in list (see [Ads, trackers and filter lists](#ads-trackers-and-filter-lists)) |

## Ads, trackers and filter lists

Ads, trackers and cookie banners are blocked with the public filter lists that ad blockers use:

- [EasyList](https://easylist.to) for ads (`block_ads`)
- [EasyPrivacy](https://easylist.to) for trackers (`block_trackers`)
- the [EasyList Cookie List](https://secure.fanboy.co.nz/fanboy-cookiemonster.txt) for cookie banners that autoconsent doesn't answer (`block_cookie_banners`)

From these lists it uses the rules that block a whole host (such as an ad network) and the CSS rules that hide elements. Rules for single URL paths or request types, and rules that run scripts in the page, are left out.

The lists are not part of this repo. They are fetched from their own sites:

- **On Cloudflare**, each time the Worker is built and deployed. Deploy again to get newer lists.
- **On a server**, when it starts and once a day after that. Set `FETCH_BLOCKLISTS=false` to turn this off.

If a list can't be fetched, the others are still used, and a small built-in list of the biggest ad and tracker hosts is always there. The lists keep their own licences (see [Credits](#credits)). They are read with [Ghostery's adblocker](https://github.com/ghostery/adblocker) parser (MPL-2.0) at build or start time only; the Worker itself doesn't include it.

## Sites that block bots

Some sites block automated browsers. You get a `blocked` error for those, with a `reason`, never a shot of the captcha. This project doesn't solve captchas, and beyond a few settings that make a headless Chrome look like a desktop one (below), it doesn't fake what the browser is.

What helps:

- **Try the other runtime.** Sites judge the address a request comes from as much as the browser. In a test of 28 URLs on 15 and 16 Nov 2026, the Worker got 23 clean shots and the Docker version on a data-centre server 19 (21 with a retry): G2 and IKEA let Cloudflare through, Wikipedia and Hacker News refused the server's address. Other sites go the other way, so if one runtime gets `blocked`, the other may not.
- **Use your own proxy.** Set `PROXY_URL` to an `http://`, `https://` or `socks5://` proxy, with `user:pass@` if it needs a login. Every shot then goes out through it. The login never shows up in logs or error messages.
- **Or a list of them.** Set `PROXY_URLS` to several proxies, separated by commas, spaces or new lines (percent-encode a comma or space inside a login). Each shot takes the next one in turn, and a blocked page is tried again through another. See [Retries](#retries).
- **Or one per request.** With `ALLOW_REQUEST_PROXY=true` and an `API_KEY`, a request may send `proxy` itself. Send it in a POST body, so the login stays out of URLs and access logs. A proxy from a request must be on the public internet, and it is used alone, never mixed with your list.

The safety checks still apply through every proxy: your server looks up each site's address first and refuses private ones, then asks the proxy for that exact address. So the proxy never looks up a name itself, and a name that points into the proxy's own network is refused. A retry goes through the same checks.

### A desktop Chrome, nothing more

On a server the browser runs as a real Chromium in Chrome's new headless mode, and changes a few things so it reads as a desktop Chrome rather than an automated one:

- the user agent and its client hints say Chrome, not "HeadlessChrome";
- `navigator.webdriver` is false, and Chromium's automation flag is off;
- the screen is 1920 × 1080, where headless reports 800 × 600;
- the language and time zone are the ones you set with `BROWSER_LANGUAGE` and `BROWSER_TIMEZONE`. Set them to match where your proxies are.

`DESKTOP_CHROME=false` drops the user agent change and the flags, and shows the browser as headless Chromium.

That is all it does. It doesn't fake hardware, canvas, WebGL, fonts or plugins, and it doesn't solve captchas. In a test of 30 popular sites from a data-centre address it took 23 clean shots where plain headless Chromium took 20 (El País, Zalando and CNN came through). The other 7 still blocked it: Forbes, Medium, Reddit, G2, IKEA, Zillow and bol.com. Those seem to judge the address as much as the browser; a proxy on a home or mobile address may get you past some of them.

On Cloudflare the user agent is set the same way, but it makes little difference: Cloudflare's browser adds signed headers that tell sites it is a bot, whatever the user agent says, and its traffic comes from Cloudflare's addresses.

### Retries

`retry` (default `1`, up to `2`) tries a shot again when a second try has a fair chance:

- after a browser crash, a timeout or a blank page;
- with a list of proxies, after a blocked page, a failed proxy, or a site that couldn't be reached through it. The retry goes through a proxy not yet tried for this shot. Without another proxy, a blocked page is reported as it is: the same address would get the same answer.

All tries share the request's `timeout`, and a retry only starts with at least 8 seconds of it left. A failure after retries says what happened on each try. A shot that came through on a retry is cached like any other; a request that ends blocked or failed is not cached, and a cached shot is served without any new try.

A proxy that fails (refuses the connection, can't be reached, or rejects the login) is skipped for 30 seconds, then for twice as long each time it fails again, up to 10 minutes. A blocked page doesn't count against a proxy: its address may still be fine for other sites. If every proxy is resting, the one due back first is tried.

`fail_on_status` turns a page with a status you list into an `error_page` error instead of a shot, for example `404,500-599`. It is never retried.

### On Cloudflare

A proxy only works on a server. Cloudflare's browser can't send its traffic through one. If `PROXY_URL` or `PROXY_URLS` is set on Cloudflare, every screenshot is refused with `not_configured`, rather than going out without the proxy. A `proxy` in a request gets `proxy_not_allowed`. `retry` still works there for crashes, timeouts and blank pages, but a retry goes out from the same Cloudflare addresses.

## Safety

A screenshot API loads any URL it is given, so it would otherwise let anyone reach your private network. This one refuses local, private and cloud-metadata addresses. It checks the first URL, every redirect and every request the page makes, and refuses when in doubt.

- **On a server**, all browser traffic goes through a small built-in proxy. The proxy resolves each host itself and connects only to the public address it checked. That also covers WebSockets and DNS tricks that point a public name at 127.0.0.1. With your own proxy set, these checks stay on your server and the proxy is only asked for addresses that passed them.
- **On Cloudflare**, the browser runs in Cloudflare's network, not yours, so there is little private network to reach. Every request the browser makes (the page itself, each redirect, frame, image and script) is held until its host passes the check, by name and by a DNS lookup over HTTPS. Two gaps remain, and Browser Rendering offers no way to close them:
  - The browser looks the name up again itself, so a name that changes its answer between the two lookups (DNS rebinding) can get past the check. The Worker can't make the browser connect to the address it checked.
  - WebSocket connections from the page are not seen by the check at all.

  Cloudflare doesn't document whether its browser network can reach private addresses. If you need every connection checked, run it on a server.

Each shot runs in a fresh incognito context: no cookies or storage carry over between requests.

`scripts`, `html`, `headers` and `cookies` don't open a way around this. Any page can already run its own scripts, and these run in the same page under the same checks: every request they cause, to any address, passes the guard like the page's own. A header can't change where a request goes (`Host` and connection headers are refused), and extra headers and cookies only reach the site you asked for. The API key or signature is checked before any option is read, and every option is part of the cache key, so two requests that differ in any way never share a shot. `/mcp` takes the API key too (not a signed URL), and every tool call goes through the same checks as `/screenshot`.

## Limits

- **Bot walls.** Some sites block every headless browser (in a test of 30 popular sites: Forbes, Medium, Reddit, G2, IKEA, Zillow and bol.com). You get a `blocked` error for those, not a shot. Which runtime gets through depends on the site and on the address it comes from, and a proxy can help. See [Sites that block bots](#sites-that-block-bots).
- **Cloudflare's free plan** gives 10 minutes of browser time a day, reset at 00:00 UTC. A full-page shot of a real site took 10.9 seconds median and 15.7 on average in a test of 20 sites (16 Nov 2026), so that is roughly 40 shots a day; simple pages take about 6.5 seconds. After that you get `quota_exceeded` until the next day. Cloudflare answers both a used-up day and a short wait for a free browser with a 429, sometimes with the same "Rate limit exceeded" text; the API tells them apart by Cloudflare's `Retry-After`, which runs to 00:00 UTC only for a used-up day. Shots served from the cache don't count, and Workers KV's free plan allows 1,000 new shots kept and 100,000 served from it a day. It also allows 3 browsers at once and 1 new browser every 20 seconds, so requests that arrive together wait their turn (up to about 20 seconds) or get `busy`. Each browser is closed right after its shot, so no time is spent idle.
- **Cloudflare's paid plan** ($5 a month for Workers) includes 10 browser hours a month, then $0.09 an hour, with no daily cap, and 10 browsers at once (the monthly average of each day's peak), then $2.00 a month for each extra one. With steady traffic, set `BROWSER_KEEP_ALIVE_SECONDS=60` so shots reuse a warm browser.
- **Lazy images** are loaded before a full-page shot. The page is scrolled down a screen at a time, each step waiting for what came into view, and then every image in the shot is waited for. A page that is still fetching when `timeout` runs out can miss an image near the bottom; a longer `timeout` helps.
- **Very long pages** are cut at `full_page_max_height`, and the `x-truncated` header says so. Chromium can't draw an image taller than 16384 device pixels (it starts repeating the page), so a shot is also cut there: 16384 CSS pixels at `device_scale_factor` 1, 8192 at 2, 5461 at 3.
- **Very wide shots.** `viewport_width` (or `clip_width`) times `device_scale_factor` can be at most 3840 device pixels, a 4K screen. Above that you get `invalid_options`, so no single shot needs much more than 250 MB of memory to draw. A page wider than its viewport can still give a full-page or `selector` shot a little wider than this.
- **Cookie banners** are dismissed with the rules from [DuckDuckGo's autoconsent](https://github.com/duckduckgo/autoconsent), over 1,600 rules for the common consent tools and for single sites. A banner it doesn't know is hidden with the EasyList Cookie List, or by a fallback that looks for fixed overlays. A banner that survives is named in `x-overlay-remaining`. A small one can still slip through now and then.
- **Ads** are blocked by host and hidden by CSS, as above. An ad served from the site's own domain, or one built into the page in a way the lists don't name, can still show.

## Develop

```sh
npm test               # unit tests, plus browser tests when Chrome is installed
npm run typecheck
npm run build:worker   # bundles the Worker without deploying it
npm run live-test      # 30 real sites; writes shots and a report to your temp folder
```

To check a running install from the outside (up, closed without the key, a real PNG back):

```sh
APISHOT_TEST_URL=https://api-screenshot.your-subdomain.workers.dev APISHOT_TEST_KEY=your-key ops/watch.sh
```

To shoot real sites through a running install (five by default, `--all` for the whole list in `ops/live-sites.txt`):

```sh
APISHOT_TEST_URL=http://localhost:3000 APISHOT_TEST_KEY=your-key ops/smoke-sites.sh --all ./shots
```

CI runs the tests on Node 22 and 24, builds the Worker, then builds the Docker image, checks that it refuses requests without a key, and shoots five real sites through it. Run the CI workflow by hand with `sites: all` to put the whole list through the Docker image.

## Credits

Cookie banners are handled with [autoconsent](https://github.com/duckduckgo/autoconsent) by DuckDuckGo (MPL-2.0). Filter lists are read with [Ghostery's adblocker](https://github.com/ghostery/adblocker) (MPL-2.0). The lists come from [EasyList](https://easylist.to) (EasyList and EasyPrivacy: GPL 3 or CC BY-SA 3.0, at your choice; the Cookie List: CC BY 3.0), fetched when you build or start. All of them, with their licences, are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Licence

MIT
