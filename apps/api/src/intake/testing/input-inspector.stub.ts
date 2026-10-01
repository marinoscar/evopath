import { Readable } from 'node:stream';

import type { StorageProvider } from '../../storage/providers/storage-provider.interface';
import { IntakeInputInspector } from '../intake-input-inspector';

/**
 * TEST-ONLY. A stand-in `IntakeInputInspector` (H2, #186) that trusts the
 * declared type: every file is what its MIME type says, and a PDF has `pages`
 * pages. For suites whose storage objects have no bytes behind them.
 */
export function trustingInputInspector(pages = 1): IntakeInputInspector {
  return {
    inspect: jest.fn(async (_storageKey: string, declared: 'image' | 'pdf') => ({
      detected: declared,
      pages: declared === 'pdf' ? pages : null,
      oversize: false,
    })),
  } as unknown as IntakeInputInspector;
}

/**
 * TEST-ONLY. The REAL `IntakeInputInspector` over an in-memory storage whose
 * `download(key)` streams `blobs.get(key)` (in `chunkSize` pieces, so the
 * bounded reads are exercised) and fails for a missing key.
 */
export function inMemoryInputInspector(
  blobs: ReadonlyMap<string, Buffer>,
  chunkSize = 64 * 1024,
): { inspector: IntakeInputInspector; download: jest.Mock } {
  const download = jest.fn(async (key: string) => {
    const bytes = blobs.get(key);
    if (!bytes) throw new Error(`in-memory storage: no object at ${key}`);

    const pieces: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += chunkSize) pieces.push(bytes.subarray(at, at + chunkSize));
    return Readable.from(pieces);
  });

  return { inspector: new IntakeInputInspector({ download } as unknown as StorageProvider), download };
}
