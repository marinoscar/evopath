import { Inject, Injectable } from '@nestjs/common';
import type { Readable } from 'node:stream';

import { STORAGE_PROVIDER, type StorageProvider } from '../storage/providers/storage-provider.interface';
import {
  countPdfPages,
  INTAKE_SNIFF_BYTES,
  inputMaxBytes,
  sniffInputKind,
  type IntakeInputKind,
} from './intake-inputs';

// =============================================================================
// IntakeInputInspector — reads a stored file back to check what it is (H2, #186)
// =============================================================================
//
// The storage object's MIME type is whatever the uploader declared. Before a
// file joins an intake, this reads the STORED bytes through the storage
// provider:
//
//   - an image: only the first `INTAKE_SNIFF_BYTES`, then the download is
//     released;
//   - a PDF: the whole file, bounded by the 50 MiB input cap (a file that
//     turns out larger than its row claimed is reported `oversize`), so its
//     pages can be counted.
//
// It returns facts and never refuses: `IntakeService` owns the error shapes.
//
// ⚠ PRIVACY. The bytes live in memory for this call only. Nothing here logs,
// persists or returns them, nor a URL; storage errors propagate unchanged.
// =============================================================================

export interface IntakeInputInspection {
  /** What the leading bytes say the file is (`null`: neither an image nor a PDF). */
  detected: IntakeInputKind | null;
  /** A PDF's page count (`null`: not counted, or not countable). */
  pages: number | null;
  /** More bytes arrived than the input kind's cap allows. */
  oversize: boolean;
}

@Injectable()
export class IntakeInputInspector {
  constructor(@Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  /** Reads the object at `storageKey`, declared as `declared`, and reports what it really is. */
  async inspect(storageKey: string, declared: IntakeInputKind): Promise<IntakeInputInspection> {
    const stream = await this.storage.download(storageKey);

    if (declared === 'image') {
      const { bytes } = await readAtMost(stream, INTAKE_SNIFF_BYTES, true);
      return { detected: sniffInputKind(bytes), pages: null, oversize: false };
    }

    const maxBytes = inputMaxBytes('pdf');
    const { bytes, exceeded } = await readAtMost(stream, maxBytes, false);

    if (exceeded) return { detected: sniffInputKind(bytes), pages: null, oversize: true };

    const detected = sniffInputKind(bytes);
    return { detected, pages: detected === 'pdf' ? countPdfPages(bytes) : null, oversize: false };
  }
}

/**
 * Up to `limit` bytes of `stream`. With `headOnly` the read stops quietly at
 * `limit`; otherwise `exceeded` says more than `limit` bytes were there. The
 * download is always released.
 */
async function readAtMost(
  stream: Readable,
  limit: number,
  headOnly: boolean,
): Promise<{ bytes: Buffer; exceeded: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let exceeded = false;

  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      const room = limit - total;

      if (buffer.length > room) {
        if (room > 0) chunks.push(buffer.subarray(0, room));
        total += Math.max(room, 0);
        exceeded = !headOnly;
        break;
      }

      chunks.push(buffer);
      total += buffer.length;

      if (headOnly && total >= limit) break;
    }
  } finally {
    stream.destroy();
  }

  return { bytes: Buffer.concat(chunks, total), exceeded };
}
