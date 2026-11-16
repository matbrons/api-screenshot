// Live test: takes full-page shots of 30 real, varied sites with local Chromium
// and writes a report. Sites change, so this runs on demand, never in `npm test`.
//
//   npm run live-test                       # shots in a new folder under your temp dir
//   npm run live-test -- --out ./shots      # or a folder of your choice
//   npm run live-test -- --only bbc,github  # a few sites by name
//
// Each site ends up "clean" (shot taken), "blocked" (bot wall, captcha or
// consent wall, named as such) or "failed" (any other error). A clean shot
// that still shows a cookie banner or pop-up the engine noticed is marked
// "banner left" or "pop-up left". Open the shots and look all the same: the
// engine can miss one without noticing.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CaptureError } from '../src/errors.ts';
import { browserSettingsFromEnv, startNodeBrowser } from '../src/node-browser.ts';
import { parseOptions } from '../src/options.ts';

// The site list is shared with ops/smoke-sites.sh, which runs it against a running install.
const SITES = readFileSync(path.join(import.meta.dirname, '..', 'ops', 'live-sites.txt'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() && !line.startsWith('#'))
  .map((line): [name: string, url: string, note: string] => {
    const [name = '', url = '', ...note] = line.trim().split(/\s+/);
    return [name, url, note.join(' ')];
  });

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    only: { type: 'string' },
    concurrency: { type: 'string', default: '3' },
  },
});
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.resolve(values.out ?? path.join(os.tmpdir(), 'api-screenshot-live', stamp));
mkdirSync(outDir, { recursive: true });
const only = values.only?.split(',').map((s) => s.trim());
const sites = only ? SITES.filter(([name]) => only.includes(name)) : SITES;

type Row = { name: string; url: string; note: string; outcome: 'clean' | 'blocked' | 'failed'; detail: string; seconds: number; file?: string };

// DESKTOP_CHROME, BROWSER_LANGUAGE and BROWSER_TIMEZONE apply here as on the server.
const { warnings, ...look } = browserSettingsFromEnv(process.env);
for (const warning of warnings) console.warn(warning);
const browser = await startNodeBrowser({
  ...look,
  concurrency: Number(values.concurrency),
  sandbox: process.env.CHROME_NO_SANDBOX !== '1',
  fetchBlocklists: process.env.FETCH_BLOCKLISTS !== 'false',
});
await browser.blocklistsReady;
const rows: Row[] = [];
const queue = [...sites];

async function worker() {
  for (let site = queue.shift(); site; site = queue.shift()) {
    const [name, url, note] = site;
    const started = Date.now();
    const seconds = () => Math.round((Date.now() - started) / 100) / 10;
    try {
      const opts = parseOptions({ url, full_page: true, format: 'jpeg', image_quality: 70, timeout: 45 });
      const { image, info } = await browser.screenshot(opts);
      const file = `${name}.jpg`;
      writeFileSync(path.join(outDir, file), image);
      const detail = [
        `${info.removed} removed`,
        info.consentManager ? `consent: ${info.consentManager}` : '',
        info.overlayRemaining ? (info.overlayRemaining === 'popup' ? 'pop-up left' : 'banner left') : '',
        info.pageHeight ? `${info.pageHeight}px${info.truncated ? ' (cut)' : ''}` : '',
      ].filter(Boolean).join(', ');
      rows.push({ name, url, note, outcome: 'clean', detail, seconds: seconds(), file });
    } catch (err) {
      const e = err instanceof CaptureError ? err : new CaptureError('internal', String(err));
      const outcome = e.code === 'blocked' ? 'blocked' : 'failed';
      rows.push({ name, url, note, outcome, detail: `${e.code}${e.reason ? `/${e.reason}` : ''}: ${e.message}`, seconds: seconds() });
    }
    const row = rows.at(-1)!;
    console.log(`${row.outcome.padEnd(7)} ${name.padEnd(10)} ${String(row.seconds).padStart(5)}s  ${row.detail}`);
  }
}

await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
await browser.close();

rows.sort((a, b) => sites.findIndex((s) => s[0] === a.name) - sites.findIndex((s) => s[0] === b.name));
const count = (o: Row['outcome']) => rows.filter((r) => r.outcome === o).length;
const left = rows.filter((r) => / left\b/.test(r.detail)).length;
const summary = `${count('clean')} clean, ${count('blocked')} blocked, ${count('failed')} failed (of ${rows.length}); ${left} with a banner or pop-up left`;
const table = [
  '| Site | Kind | Outcome | Detail | Time |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| [${r.name}](${r.url}) | ${r.note} | ${r.outcome} | ${r.detail.replace(/\|/g, '/')} | ${r.seconds}s |`),
].join('\n');
writeFileSync(path.join(outDir, 'report.md'), `# Live test, ${new Date().toISOString()}\n\n${summary}\n\n${table}\n`);
writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(rows, null, 2));
console.log(`\n${summary}\nShots and report: ${outDir}`);
