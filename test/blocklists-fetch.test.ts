// The list hosts answer with gzip and "Connection: close". When the end of a
// list and the close arrive while the event loop is busy, the HTTP client in
// Node 22 and 24 throws from inside the socket and ends the whole process
// (nodejs/undici#5360). Compiling one list keeps the loop busy for a while, so
// lists still downloading at that moment hit exactly this.
// Kept in a file of its own: other work in the same process shifts the timing.

import net from 'node:net';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { fetchBlocklists } from '../src/blocklists-build.ts';

function list(tag: string, rules: number): Buffer {
  const lines = Array.from({ length: rules }, (_, i) => `||${tag}-${i}-${Math.random().toString(36).slice(2)}.example.net^\n##.${tag}-${i}`);
  return gzipSync(`[Adblock Plus 2.0]\n! Title: ${tag}\n${lines.join('\n')}`);
}

it('survives lists that end and close while another list is compiled', async () => {
  const bodies: Record<string, Buffer> = { '/ads.txt': list('ads', 40_000), '/trackers.txt': list('trackers', 60_000), '/cookies.txt': list('cookies', 60_000) };
  const server = net.createServer((sock) => {
    sock.once('data', (req) => {
      const body = bodies[req.toString().split(' ')[1] ?? ''] ?? Buffer.alloc(0);
      sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nContent-Encoding: gzip\r\nConnection: close\r\n\r\n`);
      if (body === bodies['/ads.txt']) return void sock.end(body);
      // The other two trickle in, so they are still arriving while the first is compiled.
      let sent = 0;
      const next = () => {
        sock.write(body.subarray(sent, (sent += 32_768)));
        if (sent < body.length) setTimeout(next, 5);
        else sock.end();
      };
      next();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    const { lists, problems } = await fetchBlocklists([
      { kind: 'ads', name: 'Ads', url: `${base}/ads.txt` },
      { kind: 'trackers', name: 'Trackers', url: `${base}/trackers.txt` },
      { kind: 'cookies', name: 'Cookies', url: `${base}/cookies.txt` },
    ]);
    expect(problems).toEqual([]);
    expect(lists.ads.block).toHaveLength(40_000);
    expect(lists.trackers.block).toHaveLength(60_000);
    expect(lists.cookies.hide).toHaveLength(60_000);
  } finally {
    server.close();
  }
}, 30_000);
