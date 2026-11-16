// Writes src/generated/blocklists.ts, the filter lists the Worker blocks ads,
// trackers and cookie banners with. Runs before every wrangler build, so each
// deploy gets the lists as they are that day. Compiling them inside the Worker
// would take far more CPU time than a request may use.
//
//   node scripts/blocklists.ts                # fetch the lists
//   node scripts/blocklists.ts --if-missing   # only make sure the file exists (npm run generate)
//
// A list that can't be fetched never fails the build: the Worker then uses the
// lists that did load, plus its small built-in list.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { blocklistsModule, fetchBlocklists } from '../src/blocklists-build.ts';

const out = path.join(import.meta.dirname, '..', 'src', 'generated', 'blocklists.ts');
mkdirSync(path.dirname(out), { recursive: true });

if (process.argv.includes('--if-missing')) {
  if (!existsSync(out)) writeFileSync(out, blocklistsModule(null));
} else {
  const { lists, problems } = await fetchBlocklists();
  for (const p of problems) console.warn(`blocklists: ${p}`);
  writeFileSync(out, blocklistsModule(lists));
  console.log(`blocklists: ${lists.source}`);
}
