// =============================================================================
// AiStorageInputResolver — storage objects as AI inputs (issue #437, epic #420)
// =============================================================================
//
// The one way the AI platform reads a user's file: an image to edit (#437),
// audio to transcribe (#438), a file a response reads (#441). Every one of
// those names its input by `storageObjectId`, never by bytes in a request
// body and never by a URL a provider would fetch, and every one needs the
// same two questions answered first:
//
//   1. MAY THIS CALLER USE THIS OBJECT? Only if the caller uploaded it
//      (`uploaded_by_id`) — ownership only, exactly like `ObjectsService`'s
//      read paths; no permission lets one user read another's object here
//      (#516 removed an unseeded `storage:read_any` bypass). The answers match
//      `ObjectsService` exactly: an unknown (or malformed) id is a 404
//      "Storage object not found", and somebody else's object is a 403 —
//      carrying `details.storageObjectId`, so the RBAC matrix (#435) can tell
//      it apart from a missing permission.
//   2. IS IT USABLE AS THIS INPUT? `ready` (a pending multipart upload has no
//      bytes yet), an allowed MIME type, not larger than the caller's cap.
//      Each is `AiError('AI_INVALID_REQUEST')` — a request the caller can fix.
//
// `resolve` answers both from the ROW ALONE — no storage call — so an HTTP
// route can refuse a bad input synchronously, before anything is queued.
// `read`/`open`/`openCapped` fetch the bytes later (in the job), and each
// re-enforces the size cap as the bytes arrive (`openCapped` also names the
// error afterwards, #438): `storage_objects.size` is `0` for a simple
// upload until post-processing fills it in, so the row cannot be trusted to
// bound memory on its own.
//
// `presign` (#441) mints the short-lived signed GET URL a provider fetches a
// Responses input from itself. ⚠ Nothing here logs a presigned URL; the one
// caller (`AiService`) hands it to exactly one provider call.
// =============================================================================

import { Readable, Transform } from 'node:stream';

import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_PROVIDER, type StorageProvider } from '../../storage/providers/storage-provider.interface';
import { mimeTypeMatches, normaliseMimeType } from '../../storage/mime-type-match';
import { AiError } from '../core/ai-error';
import type { AiBinaryPayload } from '../core/types/media.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What an input must be. Every field is optional; omitted means "any". */
export interface AiStorageInputConstraints {
  /**
   * Allowed MIME types (compared case-insensitively, parameters ignored). An
   * entry `type/*` allows every subtype — `audio/*` (#438).
   */
  mimeTypes?: readonly string[];
  /** Largest acceptable object, in bytes. */
  maxBytes?: number;
  /** How the input is named in error messages, e.g. `'image'` or `'mask'`. */
  label?: string;
}

/** `AiStorageInputResolver.openCapped`'s answer. */
export interface AiCappedInputStream {
  stream: AsyncIterable<Uint8Array>;
  /** The size-cap error, once the stream has thrown it. */
  exceeded(): AiError | undefined;
  /** Releases the underlying download. Idempotent. */
  close(): void;
}

/** A resolved, usable input — metadata only; fetch the bytes with `read`/`open`/`openCapped`. */
export interface AiStorageInput {
  id: string;
  name: string;
  mimeType: string;
  /** As recorded on the row; `0` when not yet known (see the file header). */
  size: number;
  storageKey: string;
}

@Injectable()
export class AiStorageInputResolver {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /**
   * The object `objectId` as an input for `userId`, checked against
   * `constraints`. Reads the row only — never storage.
   *
   * @throws NotFoundException for an unknown or malformed id;
   *   ForbiddenException for another user's object;
   *   AiError('AI_INVALID_REQUEST') for an object that is not ready, of a
   *   disallowed type, or too large.
   */
  async resolve(
    userId: string,
    objectId: string,
    constraints: AiStorageInputConstraints = {},
  ): Promise<AiStorageInput> {
    const row = UUID.test(objectId)
      ? await this.prisma.storageObject.findUnique({
          where: { id: objectId },
          select: { id: true, name: true, mimeType: true, size: true, storageKey: true, status: true, uploadedById: true },
        })
      : null;

    if (!row) {
      throw new NotFoundException('Storage object not found');
    }

    if (row.uploadedById !== userId) {
      throw new ForbiddenException({
        message: 'You do not have access to this storage object',
        details: { storageObjectId: objectId },
      });
    }

    const label = constraints.label ?? 'input';

    if (row.status !== 'ready') {
      throw new AiError('AI_INVALID_REQUEST', `The ${label} storage object is not ready (status: ${row.status}).`, {
        details: { storageObjectId: objectId, status: row.status },
      });
    }

    const mimeType = normaliseMimeType(row.mimeType);

    if (constraints.mimeTypes && !mimeTypeMatches(mimeType, constraints.mimeTypes)) {
      throw new AiError(
        'AI_INVALID_REQUEST',
        `The ${label} storage object must be one of ${constraints.mimeTypes.join(', ')} (it is ${row.mimeType}).`,
        { details: { storageObjectId: objectId, mimeType: row.mimeType, allowed: [...constraints.mimeTypes] } },
      );
    }

    const size = Number(row.size);

    if (constraints.maxBytes !== undefined && size > constraints.maxBytes) {
      throw tooLarge(label, objectId, constraints.maxBytes);
    }

    return { id: row.id, name: row.name, mimeType, size, storageKey: row.storageKey };
  }

  /**
   * The input's bytes, buffered — for a provider SDK that wants a whole file.
   * Stops (and refuses with `AI_INVALID_REQUEST`) as soon as more than
   * `maxBytes` have arrived, whatever the row claimed.
   */
  async read(input: AiStorageInput, opts: { maxBytes?: number; label?: string } = {}): Promise<AiBinaryPayload> {
    const stream = await this.open(input);
    const chunks: Buffer[] = [];
    let total = 0;

    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);

        total += buffer.length;

        if (opts.maxBytes !== undefined && total > opts.maxBytes) {
          throw tooLarge(opts.label ?? 'input', input.id, opts.maxBytes);
        }

        chunks.push(buffer);
      }
    } finally {
      stream.destroy();
    }

    return { data: Buffer.concat(chunks, total), mimeType: input.mimeType, filename: input.name };
  }

  /**
   * The input's bytes as a stream — for a consumer that can pipe them. With
   * `maxBytes`, the stream fails with `AI_INVALID_REQUEST` as soon as more
   * than that has passed through, whatever the row claimed.
   */
  async open(input: AiStorageInput, opts: { maxBytes?: number; label?: string } = {}): Promise<Readable> {
    const source = await this.storage.download(input.storageKey);

    if (opts.maxBytes === undefined) return source;

    const maxBytes = opts.maxBytes;
    let total = 0;
    const capped = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        total += chunk.length;
        done(total > maxBytes ? tooLarge(opts.label ?? 'input', input.id, maxBytes) : null, chunk);
      },
    });

    source.on('error', (err) => capped.destroy(err));
    capped.on('close', () => source.destroy());

    return source.pipe(capped);
  }

  /**
   * A short-lived signed GET URL for the input (#441) — for a provider that
   * fetches an input itself, so the bytes never pass through this API.
   *
   * ⚠ The URL is a bearer capability for the object: the caller hands it to
   * exactly one provider call and never logs, persists or returns it.
   * Surfaces the storage layer's own errors (`StorageNotConfiguredError`).
   */
  async presign(input: AiStorageInput, expiresInSeconds: number): Promise<string> {
    return this.storage.getSignedDownloadUrl(input.storageKey, { expiresIn: expiresInSeconds });
  }

  /**
   * The input's bytes as a stream that FAILS (with `AI_INVALID_REQUEST`) as
   * soon as more than `maxBytes` have passed through it, whatever the row
   * claimed — for a provider upload that should not buffer the file (#438).
   * `exceeded()` names that error after the fact, so a caller whose consumer
   * wrapped it (an SDK turning a body-stream failure into a network error)
   * can still answer with it; `close()` releases the download.
   */
  async openCapped(
    input: AiStorageInput,
    opts: { maxBytes: number; label?: string },
  ): Promise<AiCappedInputStream> {
    const source = await this.open(input);
    let exceeded: AiError | undefined;

    async function* capped(): AsyncGenerator<Uint8Array> {
      let total = 0;

      for await (const chunk of source) {
        const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk as string);

        total += bytes.byteLength;

        if (total > opts.maxBytes) {
          exceeded = tooLarge(opts.label ?? 'input', input.id, opts.maxBytes);
          throw exceeded;
        }

        yield bytes;
      }
    }

    return {
      stream: capped(),
      exceeded: () => exceeded,
      close: () => {
        source.destroy();
      },
    };
  }
}

function tooLarge(label: string, objectId: string, maxBytes: number): AiError {
  return new AiError('AI_INVALID_REQUEST', `The ${label} storage object is larger than ${maxBytes} bytes.`, {
    details: { storageObjectId: objectId, maxBytes },
  });
}
