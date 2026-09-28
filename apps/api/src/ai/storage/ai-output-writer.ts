// =============================================================================
// AiOutputWriter — AI outputs as the user's storage objects (issue #437)
// =============================================================================
//
// Media an AI operation produces — generated images (#437), synthesized
// speech (#439), a hosted tool's image (#442) — is persisted as ordinary
// `storage_objects` rows OWNED BY THE USER who asked, never as base64 in an
// API response or a JSONB column. The caller gets storage object ids, and the
// client downloads through the existing `GET /api/storage/objects/:id/download`
// (owner-scoped, signed, short-lived) exactly as for a file it uploaded.
//
// KEYS. `ai-outputs/<userId>/<runId>/<n>-<uuid>.<ext>` — under
// `AI_OUTPUTS_KEY_PREFIX`, which is on `STORAGE_KEY_PREFIXES`, so
// `appctl deploy uninstall --purge-storage` finds these objects too. The key
// is built here from server-side values only; no caller string reaches it.
// A job whose output has one fixed name (speech, #439: `speech.mp3`) passes
// it as `keyName` — a constant of its own, validated here, never user input.
//
// ROWS are written `ready` with the exact byte count: the bytes are already
// in hand, so there is no multipart upload to finish and no post-processing
// step that would discover the size later.
//
// ALL OR NOTHING. A write of several files that fails part-way deletes what
// it already stored (best effort) before rethrowing, so a failed run leaves
// no orphaned half-set behind; `discard` is the same clean-up for a caller
// whose run was cancelled after the files were written.
//
// `assertWritable()` answers "is there storage to write to?" WITHOUT writing:
// a caller asks it before spending a provider call whose output it could not
// keep. It throws the storage layer's own `StorageNotConfiguredError` (503).
// =============================================================================

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { StorageConfigService } from '../../storage/config/storage-config.service';
import { StorageNotConfiguredError } from '../../storage/config/storage-not-configured.error';
import { STORAGE_PROVIDER, type StorageProvider } from '../../storage/providers/storage-provider.interface';
import { AI_OUTPUTS_KEY_PREFIX } from '../../storage/storage-key-prefixes';

/** The folder one run's outputs live in: `ai-outputs/<userId>/<runId>/`. */
export function aiOutputKeyPrefix(userId: string, runId: string): string {
  return `${AI_OUTPUTS_KEY_PREFIX}${userId}/${runId}/`;
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/pcm': 'pcm',
  'text/plain': 'txt',
  'application/json': 'json',
};

/** The file extension for `mimeType`, or `bin` for one this table does not know. */
export function extensionForMime(mimeType: string): string {
  return EXTENSIONS[mimeType.split(';')[0].trim().toLowerCase()] ?? 'bin';
}

/** One file to store. */
export interface AiOutputFile {
  data: Uint8Array;
  mimeType: string;
  /** The row's display name. Defaults to `<namePrefix>-<n>.<ext>`. */
  name?: string;
  /**
   * The key's last segment, when the output has a fixed name (`speech.mp3`).
   * Server-chosen only; `[A-Za-z0-9._-]`, not starting with a dot. Defaults
   * to `<n>-<uuid>.<ext>`.
   */
  keyName?: string;
}

const KEY_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

export interface AiOutputWriteOptions {
  /** Owner of the new objects (and the first key segment). */
  userId: string;
  /** The run the files belong to (the second key segment). */
  runId: string;
  files: AiOutputFile[];
  /** Default display-name stem, e.g. `ai-image`. */
  namePrefix?: string;
  /** Extra, non-secret metadata recorded on each row (e.g. provider, model). */
  metadata?: Record<string, string>;
}

/** One stored file. */
export interface AiStoredOutput {
  storageObjectId: string;
  name: string;
  mimeType: string;
  size: number;
}

@Injectable()
export class AiOutputWriter {
  private readonly logger = new Logger(AiOutputWriter.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly storageConfig: StorageConfigService,
  ) {}

  /**
   * Throws `StorageNotConfiguredError` (503) when this deployment has no
   * usable object storage. Writes nothing.
   */
  async assertWritable(): Promise<void> {
    const resolution = await this.storageConfig.resolve();

    if (!resolution.configured) {
      throw StorageNotConfiguredError.missing(resolution.provider, resolution.missing);
    }
  }

  /** Stores every file as a `ready` storage object owned by `userId`, in order. */
  async write(opts: AiOutputWriteOptions): Promise<AiStoredOutput[]> {
    const prefix = aiOutputKeyPrefix(opts.userId, opts.runId);
    const stored: Array<AiStoredOutput & { storageKey: string }> = [];

    try {
      for (const [index, file] of opts.files.entries()) {
        const ext = extensionForMime(file.mimeType);
        if (file.keyName !== undefined && !KEY_NAME.test(file.keyName)) {
          throw new Error(`Invalid AI output key name: ${JSON.stringify(file.keyName)}`);
        }

        const storageKey = `${prefix}${file.keyName ?? `${index + 1}-${randomUUID()}.${ext}`}`;
        const name = file.name ?? `${opts.namePrefix ?? 'ai-output'}-${index + 1}.${ext}`;
        const bytes = Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength);

        const result = await this.storage.upload(storageKey, Readable.from([bytes]), {
          mimeType: file.mimeType,
          contentLength: bytes.length,
        });

        try {
          const row = await this.prisma.storageObject.create({
            data: {
              name,
              size: BigInt(bytes.length),
              mimeType: file.mimeType,
              storageKey,
              storageProvider: await this.storageConfig.activeProvider(),
              bucket: result.bucket,
              status: 'ready',
              uploadedById: opts.userId,
              metadata: { source: 'ai', runId: opts.runId, ...(opts.metadata ?? {}) } as Prisma.InputJsonValue,
            },
            select: { id: true },
          });

          stored.push({ storageObjectId: row.id, name, mimeType: file.mimeType, size: bytes.length, storageKey });
        } catch (err) {
          await this.deleteKey(storageKey);
          throw err;
        }
      }
    } catch (err) {
      await this.removeAll(stored);
      throw err;
    }

    return stored.map(({ storageKey: _key, ...output }) => output);
  }

  /** Deletes objects this writer stored (a run cancelled after its files were written). Best effort. */
  async discard(storageObjectIds: string[]): Promise<void> {
    if (storageObjectIds.length === 0) return;

    try {
      const rows = await this.prisma.storageObject.findMany({
        where: { id: { in: storageObjectIds } },
        select: { id: true, storageKey: true },
      });

      await this.removeAll(rows.map((row) => ({ storageObjectId: row.id, storageKey: row.storageKey })));
    } catch (err) {
      this.logger.warn(`Could not discard AI outputs: ${describe(err)}`);
    }
  }

  private async removeAll(items: Array<{ storageObjectId: string; storageKey: string }>): Promise<void> {
    for (const item of items) {
      await this.deleteKey(item.storageKey);

      try {
        await this.prisma.storageObject.delete({ where: { id: item.storageObjectId } });
      } catch (err) {
        this.logger.warn(`Could not delete AI output row ${item.storageObjectId}: ${describe(err)}`);
      }
    }
  }

  private async deleteKey(storageKey: string): Promise<void> {
    try {
      await this.storage.delete(storageKey);
    } catch (err) {
      this.logger.warn(`Could not delete AI output object ${storageKey}: ${describe(err)}`);
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
