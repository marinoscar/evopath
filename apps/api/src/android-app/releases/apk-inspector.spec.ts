import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';

import { ApkInspector } from './apk-inspector';

const APK = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('rest of a zip archive')]);

async function run(chunks: Buffer[], maxBytes?: number) {
  const inspector = new ApkInspector(maxBytes);
  const received: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      received.push(chunk);
      cb();
    },
  });
  let error: unknown = null;
  try {
    await pipeline(Readable.from(chunks), inspector, sink);
  } catch (caught) {
    error = caught;
  }
  return { inspector, received: Buffer.concat(received), error };
}

describe('ApkInspector', () => {
  it('passes the bytes through and reports their size and SHA-256', async () => {
    const { inspector, received, error } = await run([APK]);

    expect(error).toBeNull();
    expect(received.equals(APK)).toBe(true);
    expect(inspector.sizeBytes).toBe(APK.length);
    expect(inspector.digest()).toBe(createHash('sha256').update(APK).digest('hex'));
  });

  it('checks the magic across chunks smaller than four bytes', async () => {
    const { error, inspector } = await run([APK.subarray(0, 1), APK.subarray(1, 3), APK.subarray(3)]);

    expect(error).toBeNull();
    expect(inspector.sizeBytes).toBe(APK.length);
  });

  it('refuses a file that does not start with PK\\x03\\x04, before passing anything on', async () => {
    const { error, inspector, received } = await run([Buffer.from('MZ not a zip')]);

    expect(error).toBe(inspector.failure);
    expect((error as { getStatus(): number }).getStatus()).toBe(400);
    expect((error as { getResponse(): { details: { reason: string } } }).getResponse().details.reason).toBe(
      'RELEASE_NOT_AN_APK',
    );
    expect(received.length).toBe(0);
  });

  it('refuses an empty file and one shorter than the signature', async () => {
    expect((await run([])).error).not.toBeNull();
    expect((await run([Buffer.from('PK')])).error).not.toBeNull();
  });

  it('refuses a file over the limit with 413', async () => {
    const { error } = await run([APK, Buffer.alloc(10)], APK.length + 5);

    expect((error as { getStatus(): number }).getStatus()).toBe(413);
    expect((error as { getResponse(): { details: { reason: string } } }).getResponse().details.reason).toBe(
      'RELEASE_TOO_LARGE',
    );
  });

  it('accepts a file exactly at the limit', async () => {
    expect((await run([APK], APK.length)).error).toBeNull();
  });

  it('fails the stream when told the parser truncated the file', async () => {
    const inspector = new ApkInspector();
    const failed = new Promise((resolve) => inspector.on('error', resolve));
    inspector.rejectTooLarge();

    expect(((await failed) as { getStatus(): number }).getStatus()).toBe(413);
  });
});
