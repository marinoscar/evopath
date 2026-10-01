import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { createHash, type Hash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

import { ANDROID_RELEASE_REASONS, MAX_APK_BYTES, ZIP_MAGIC } from './android-release.constants';

// =============================================================================
// ApkInspector — validate and fingerprint an APK while it streams (#285)
// =============================================================================
//
// A pass-through `Transform` placed between the multipart file stream and the
// storage upload, so a 150 MB APK is never buffered:
//
//   * the first four bytes must be the ZIP local-file-header magic `PK\x03\x04`
//     (every APK is a ZIP); anything else fails the stream before a second
//     chunk reaches storage;
//   * the byte count must stay within the limit;
//   * the SHA-256 of exactly the bytes passed on is computed as they pass.
//
// A failure DESTROYS the stream with an HTTP exception, and the same exception
// is kept on `failure`, so the caller can report it even when the storage SDK
// rethrows its own wrapper of the stream error.
// =============================================================================

export class ApkInspector extends Transform {
  private readonly hash: Hash = createHash('sha256');
  private header = Buffer.alloc(0);
  private checkedMagic = false;
  private bytes = 0;

  /** The first validation failure, if any. */
  failure: BadRequestException | PayloadTooLargeException | null = null;

  constructor(private readonly maxBytes: number = MAX_APK_BYTES) {
    super();
  }

  /** Bytes passed through so far (the file size once the stream ended). */
  get sizeBytes(): number {
    return this.bytes;
  }

  /** Lowercase hex SHA-256 of every byte passed through. Call once, after the end. */
  digest(): string {
    return this.hash.digest('hex');
  }

  /** Fail the stream as too large (the multipart parser hit its own limit). */
  rejectTooLarge(): void {
    this.fail(tooLarge(this.maxBytes));
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.failure) return callback(this.failure);

    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      return callback(this.remember(tooLarge(this.maxBytes)));
    }

    if (!this.checkedMagic) {
      this.header = Buffer.concat([this.header, chunk.subarray(0, ZIP_MAGIC.length - this.header.length)]);
      if (this.header.length >= ZIP_MAGIC.length) {
        if (!this.header.equals(ZIP_MAGIC)) return callback(this.remember(notAnApk()));
        this.checkedMagic = true;
      }
    }

    this.hash.update(chunk);
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    if (this.failure) return callback(this.failure);
    if (!this.checkedMagic) return callback(this.remember(notAnApk()));
    callback();
  }

  private remember(error: BadRequestException | PayloadTooLargeException) {
    this.failure ??= error;
    return this.failure;
  }

  private fail(error: BadRequestException | PayloadTooLargeException): void {
    this.destroy(this.remember(error));
  }
}

function notAnApk(): BadRequestException {
  return new BadRequestException({
    message: 'The uploaded file is not an APK (it does not start with the ZIP signature PK\\x03\\x04).',
    details: { reason: ANDROID_RELEASE_REASONS.NOT_AN_APK },
  });
}

function tooLarge(maxBytes: number): PayloadTooLargeException {
  return new PayloadTooLargeException({
    message: `The APK exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB limit.`,
    details: { reason: ANDROID_RELEASE_REASONS.TOO_LARGE, maxBytes },
  });
}
