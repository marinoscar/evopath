import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { withUploadProgress } from './upload-progress.js';

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A real HTTP server that echoes how many body bytes and which content type it got. */
async function echoServer(): Promise<string> {
  const server = createServer((req, res) => {
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
    });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ received, type: req.headers['content-type'] ?? null, auth: req.headers.authorization ?? null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`;
}

describe('withUploadProgress', () => {
  it('sends a multipart body intact and reports the bytes as they go', async () => {
    const url = await echoServer();
    const form = new FormData();
    form.append('versionName', '1.0.0');
    form.append('apk', new Blob([new Uint8Array(200_000)]), 'app.apk');

    const progress: number[] = [];
    const fetch = withUploadProgress(globalThis.fetch.bind(globalThis), (sent) => progress.push(sent));
    const response = await fetch(url, { method: 'POST', body: form, headers: { Authorization: 'Bearer t' } });
    const body = (await response.json()) as { received: number; type: string; auth: string };

    expect(body.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(body.auth).toBe('Bearer t');
    expect(body.received).toBeGreaterThan(200_000);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(body.received);
  });

  it('passes every other request through untouched', async () => {
    const base = vi.fn<typeof globalThis.fetch>(async () => new Response('ok'));
    const onProgress = vi.fn();
    const init = { method: 'POST', body: '{"a":1}' };
    await withUploadProgress(base, onProgress)('https://x.example.com/api', init);
    expect(base).toHaveBeenCalledWith('https://x.example.com/api', init);
    expect(onProgress).not.toHaveBeenCalled();
  });
});
