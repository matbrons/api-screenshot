// Server only: a cache store in a folder, one file per shot, with a size cap.
// When the folder grows past the cap, the shots used longest ago go first.
// Expired shots are skipped on read (src/cache.ts) and overwritten or evicted later.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CacheStore } from './cache.ts';

const KEY = /^[0-9a-f]{64}$/;

export async function openDiskStore(dir: string, maxBytes: number): Promise<CacheStore> {
  await mkdir(dir, { recursive: true, mode: 0o700 });

  // Least recently used first: a Map keeps insertion order, and every use moves a key to the end.
  const sizes = new Map<string, number>();
  let total = 0;
  const names = await readdir(dir);
  // Half-written files left by a crash.
  await Promise.all(names.filter((name) => name.endsWith('.tmp')).map((name) => unlink(path.join(dir, name)).catch(() => undefined)));
  const found = await Promise.all(
    names.filter((name) => KEY.test(name)).map(async (name) => ({ name, info: await stat(path.join(dir, name)) })),
  );
  for (const { name, info } of found.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs)) {
    sizes.set(name, info.size);
    total += info.size;
  }

  const forget = (key: string) => {
    total -= sizes.get(key) ?? 0;
    sizes.delete(key);
  };

  const evict = async () => {
    while (total > maxBytes && sizes.size > 0) {
      const oldest = sizes.keys().next().value as string;
      forget(oldest);
      await unlink(path.join(dir, oldest)).catch(() => undefined);
    }
  };
  await evict();

  return {
    async get(key) {
      if (!KEY.test(key) || !sizes.has(key)) return null;
      try {
        const data = await readFile(path.join(dir, key));
        sizes.delete(key);
        sizes.set(key, data.length);
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } catch {
        forget(key);
        return null;
      }
    },
    async put(key, value) {
      if (!KEY.test(key) || value.length > maxBytes) return;
      // Write to a temporary name first, so a reader never sees half a file.
      const tmp = path.join(dir, `${key}.${randomUUID()}.tmp`);
      await writeFile(tmp, value, { mode: 0o600 });
      await rename(tmp, path.join(dir, key));
      forget(key);
      sizes.set(key, value.length);
      total += value.length;
      await evict();
    },
  };
}
