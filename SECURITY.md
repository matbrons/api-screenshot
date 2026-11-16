# Security

## Report a problem

Please don't open a public issue. Report it privately on GitHub: on this repo's **Security** tab, choose **Report a vulnerability** ([direct link](https://github.com/matbrons/api-screenshot/security/advisories/new)).

Say what you found, how to reproduce it, and where it runs: the Cloudflare Worker, the Docker image or Node on its own. Leave your API key and any proxy login out of it.

## In scope

- **The SSRF guard.** Any way to make the browser reach a private, local or cloud-metadata address: through the first URL, a redirect, a request the page makes, `html`, `scripts`, or a proxy.
- **The key check.** A shot without a valid `API_KEY`, or any shot at all while no usable key is set and `ALLOW_PUBLIC_ACCESS` is off.
- **Signed URLs.** A changed, added or removed parameter that still passes, or an expired link that still works.
- **Leaks.** The key, the signing secret or a proxy login showing up in a response, an error or a log, or a cached shot served to a request that couldn't have asked for it.

## Out of scope

- A site that blocks the browser, or a banner that isn't removed. Open an issue for those.
- What the README already lists as a limit, such as DNS rebinding and WebSocket connections from the page on Cloudflare (see Safety), or an install run with `ALLOW_PUBLIC_ACCESS=true`.
- Bugs in Cloudflare's Browser Rendering or in Chromium itself. Report those to them.

## Versions

Fixes go into the latest release.
