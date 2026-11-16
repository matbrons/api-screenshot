# Third-party notices

API Screenshot is MIT licensed (see [LICENSE](LICENSE)). It uses the work
below, each under its own licence.

## Inside the Worker bundle and the Docker image

### autoconsent

Answers cookie banners. The Worker bundle includes its in-page script and its
rules, unchanged; the Docker image installs the package itself.

- Copyright DuckDuckGo, Inc.
- Licence: [Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/)
- Source: https://github.com/duckduckgo/autoconsent

### Other packages

These are installed from npm with their own licence files. The Worker bundle
keeps their licence comments.

| Package | Licence | Source |
| --- | --- | --- |
| hono, @hono/node-server | MIT | https://github.com/honojs |
| puppeteer-core | Apache-2.0 | https://github.com/puppeteer/puppeteer |
| @cloudflare/puppeteer | Apache-2.0 | https://github.com/cloudflare/browser-run |
| @modelcontextprotocol/server | Apache-2.0 | https://github.com/modelcontextprotocol/typescript-sdk |

### Ghostery adblocker

Reads the filter lists below. It runs only when the Worker is built and when the
server starts; the Worker bundle doesn't include it.

- Copyright Ghostery GmbH
- Licence: [Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/)
- Source: https://github.com/ghostery/adblocker

## Filter lists

The lists are not part of this repository. They are fetched from their own
homes when the Worker is built (into `src/generated/blocklists.ts`, which is
not committed) and when the server starts. What is kept from them, host names
and CSS selectors, stays under the list's own licence.

| List | Licence |
| --- | --- |
| [EasyList](https://easylist.to/easylist/easylist.txt) | GPL 3.0 or later, or CC BY-SA 3.0 or later, at your choice |
| [EasyPrivacy](https://easylist.to/easylist/easyprivacy.txt) | GPL 3.0 or later, or CC BY-SA 3.0 or later, at your choice |
| [EasyList Cookie List](https://secure.fanboy.co.nz/fanboy-cookiemonster.txt) | CC BY 3.0, as its own header says |

Source: The EasyList authors (https://easylist.to/). Licence terms:
https://easylist.to/pages/licence.html

## In the Docker image only

The image installs Chromium and fonts (Liberation, Noto) from Debian. Their
licences are in the image under `/usr/share/doc/<package>/copyright`.
