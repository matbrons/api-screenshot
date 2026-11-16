// Runs the API on your own server: `node src/server.ts` (Node 22.19 or newer).
//
// Settings (environment variables):
//   PORT, HOST              where to listen (default 3000 on 0.0.0.0)
//   API_KEY                 every screenshot request must carry it (16 characters or more)
//   SIGNING_SECRET          lets a GET request carry a signature instead of the key (16 characters or more)
//   ALLOW_PUBLIC_ACCESS     true serves screenshots without a key; without either, they are refused
//   MAX_CONCURRENCY         screenshots at the same time (default 2)
//   MAX_TIMEOUT_SECONDS     longest timeout a request may ask for (default 60)
//   MAX_FULL_PAGE_HEIGHT    tallest full-page shot in CSS pixels (default 20000)
//   CHROME_PATH             Chrome or Chromium to use (found automatically otherwise)
//   CHROME_NO_SANDBOX=1     run Chromium without its sandbox (some containers need this)
//   PROXY_URL               send browser traffic through your own proxy: http://, https:// or socks5://
//   PROXY_URLS              a list of your own proxies, taken in turn; a retry goes through the next one
//   ALLOW_REQUEST_PROXY     true lets a request with the API key bring its own proxy ("proxy" option)
//   CACHE_TTL_SECONDS       how long a shot is reused (default 86400; 0 turns the cache off)
//   CACHE_DIR               where shots are kept (default: api-screenshot-cache in the temp folder)
//   CACHE_MAX_MB            the most the cache folder may hold (default 1024)
//   DESKTOP_CHROME          false shows the browser as headless Chromium instead of a desktop Chrome
//   BROWSER_LANGUAGE        the browser's language (default en-US)
//   BROWSER_TIMEZONE        the browser's time zone (default America/New_York)
//   FETCH_BLOCKLISTS=false  don't fetch the ad, tracker and cookie filter lists; use the small built-in list

import { serve } from '@hono/node-server';
import os from 'node:os';
import path from 'node:path';
import { configFromEnv, createApp, isTrue } from './app.ts';
import { openDiskStore } from './disk-cache.ts';
import { browserSettingsFromEnv, proxyLogLine, startNodeBrowser } from './node-browser.ts';

const env = process.env;
const port = Number(env.PORT ?? 3000);
const hostname = env.HOST ?? '0.0.0.0';

const config = configFromEnv(env, { proxy: true });
const { warnings, ...look } = browserSettingsFromEnv(env);
for (const warning of warnings) console.warn(warning);
const browser = await startNodeBrowser({
  concurrency: Math.max(1, Number(env.MAX_CONCURRENCY ?? 2) || 2),
  sandbox: env.CHROME_NO_SANDBOX !== '1' && env.CHROME_NO_SANDBOX !== 'true',
  fetchBlocklists: !/^(0|false|no|off)$/i.test(env.FETCH_BLOCKLISTS?.trim() ?? ''),
  ...look,
  ...(config.proxies ? { proxies: config.proxies } : {}),
});
const cacheDir = env.CACHE_DIR?.trim() || path.join(os.tmpdir(), 'api-screenshot-cache');
const cacheMb = Number(env.CACHE_MAX_MB?.trim() || NaN);
const cacheMaxMb = Number.isFinite(cacheMb) && cacheMb >= 0 ? cacheMb : 1024;
// A cache folder that can't be used turns the cache off; it never stops the server.
const cache =
  config.cacheTtl > 0 && cacheMaxMb > 0
    ? await openDiskStore(cacheDir, cacheMaxMb * 1024 * 1024).catch((err) => {
        console.warn(`Cache off: can't use ${cacheDir} (${(err as Error).message}).`);
        return undefined;
      })
    : undefined;
const app = createApp({ ...config, ...(cache ? { cache } : {}), screenshot: (opts, signal) => browser.screenshot(opts, signal) });

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Listening on http://${hostname}:${info.port}`);
  if (config.keyProblem) console.warn(`${config.keyProblem} Screenshots are refused until then.`);
  else if (config.apiKey || config.signingSecret) {
    console.log([config.apiKey && 'API key required.', config.signingSecret && 'Signed URLs are on.'].filter(Boolean).join(' '));
  } else if (config.allowPublicAccess) console.warn('ALLOW_PUBLIC_ACCESS is on: anyone who can reach this port can take screenshots.');
  else console.warn('No API_KEY set, so screenshots are refused. Set API_KEY, or ALLOW_PUBLIC_ACCESS=true to serve without a key.');
  if (config.proxyProblem) console.warn(`${config.proxyProblem} Screenshots are refused until then.`);
  else if (config.proxies) console.log(proxyLogLine(config.proxies));
  if (!look.desktopChrome) console.log('DESKTOP_CHROME is off: the browser shows itself as headless Chromium.');
  if (config.requestProxy.allowed) console.log('Requests with the API key may bring their own proxy.');
  else if (isTrue(env.ALLOW_REQUEST_PROXY)) console.warn(config.requestProxy.reason);
  console.log(cache ? `Keeping shots for ${config.cacheTtl} s in ${cacheDir}, up to ${cacheMaxMb} MB.` : 'Cache off.');
});

const stop = async () => {
  server.close();
  await browser.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
