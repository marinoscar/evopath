// =============================================================================
// In-memory object storage for AI tests (issue #437). TEST-ONLY.
// =============================================================================
//
// Just enough of two collaborators for the REAL `AiStorageInputResolver`
// and `AiOutputWriter` to run against:
//
//   - `prisma`: `storageObject.findUnique/findMany/create/delete` over an
//     array of rows. Ownership (`uploadedById === userId`) is the only access
//     check the resolver makes (#516 removed the unseeded `storage:read_any`
//     bypass), so there is no permission table to fake here any more;
//   - `provider`: a `StorageProvider` whose `upload`/`download`/`delete` move
//     bytes in and out of a `Map`, whose `getSignedDownloadUrl` (#441) mints a
//     fake presigned URL carrying `IN_MEMORY_PRESIGNED_SIGNATURE` (a sentinel
//     the secret-egress suite hunts for), and whose every other method throws;
//   - `storageConfig`: `resolve()`/`activeProvider()`, switchable to the
//     unconfigured state with `setConfigured(false)` — which also makes every
//     provider call throw `StorageNotConfiguredError`, exactly as
//     `ResolvingStorageProvider` does.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { StorageNotConfiguredError } from '../../storage/config/storage-not-configured.error';
import type { StorageProvider } from '../../storage/providers/storage-provider.interface';

export interface InMemoryStorageObject {
  id: string;
  name: string;
  size: bigint;
  mimeType: string;
  storageKey: string;
  storageProvider: string;
  bucket: string | null;
  status: string;
  metadata: unknown;
  uploadedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const BUCKET = 'in-memory-bucket';

/**
 * Every presigned URL this storage mints carries this signature — a sentinel
 * that must never appear in a response, log line or persisted row (#441).
 */
export const IN_MEMORY_PRESIGNED_SIGNATURE = 'presigned-sentinel-5f3a9c';

/** The origin of every presigned URL this storage mints. */
export const IN_MEMORY_PRESIGNED_ORIGIN = 'https://in-memory-storage.test';

function pick(row: object, select?: Record<string, boolean>): Record<string, unknown> {
  const source = row as Record<string, unknown>;

  if (!select) return { ...source };

  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, source[k]]));
}

export function createInMemoryAiStorage() {
  const objects: InMemoryStorageObject[] = [];
  const blobs = new Map<string, Buffer>();
  let configured = true;

  const assertConfigured = () => {
    if (!configured) throw StorageNotConfiguredError.missing('s3', ['bucket', 'secretAccessKey']);
  };

  const unsupported = (name: string) => async () => {
    throw new Error(`in-memory storage: ${name} is not supported`);
  };

  const provider: StorageProvider = {
    upload: jest.fn(async (key: string, stream: Readable) => {
      assertConfigured();

      const chunks: Buffer[] = [];

      for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));

      blobs.set(key, Buffer.concat(chunks));

      return { key, bucket: BUCKET, location: `memory://${BUCKET}/${key}` };
    }),
    download: jest.fn(async (key: string) => {
      assertConfigured();

      const bytes = blobs.get(key);

      if (!bytes) throw new Error(`in-memory storage: no object at ${key}`);

      return Readable.from([bytes]);
    }),
    delete: jest.fn(async (key: string) => {
      assertConfigured();
      blobs.delete(key);
    }),
    exists: jest.fn(async (key: string) => blobs.has(key)),
    getBucket: () => BUCKET,
    initMultipartUpload: unsupported('initMultipartUpload'),
    getSignedUploadUrl: unsupported('getSignedUploadUrl'),
    completeMultipartUpload: unsupported('completeMultipartUpload'),
    abortMultipartUpload: unsupported('abortMultipartUpload'),
    getSignedDownloadUrl: jest.fn(async (key: string, options?: { expiresIn?: number }) => {
      assertConfigured();

      if (!blobs.has(key)) throw new Error(`in-memory storage: no object at ${key}`);

      return (
        `${IN_MEMORY_PRESIGNED_ORIGIN}/${BUCKET}/${key}?X-Amz-Expires=${options?.expiresIn ?? 3600}` +
        `&X-Amz-Signature=${IN_MEMORY_PRESIGNED_SIGNATURE}-${randomUUID()}`
      );
    }),
    getSignedPutUrl: unsupported('getSignedPutUrl'),
    getMetadata: unsupported('getMetadata'),
    setMetadata: unsupported('setMetadata'),
  };

  const storageConfig = {
    resolve: jest.fn(async () =>
      configured
        ? { configured: true as const, config: { provider: 's3', bucket: BUCKET } }
        : { configured: false as const, provider: 's3' as const, missing: ['bucket' as const, 'secretAccessKey' as const] },
    ),
    activeProvider: jest.fn(async () => 's3' as const),
  };

  const prisma = {
    storageObject: {
      findUnique: jest.fn(async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
        const row = objects.find((o) => o.id === args.where.id);
        return row ? pick(row, args.select) : null;
      }),
      findMany: jest.fn(async (args: { where: { id: { in: string[] } }; select?: Record<string, boolean> }) =>
        objects.filter((o) => args.where.id.in.includes(o.id)).map((o) => pick(o, args.select)),
      ),
      create: jest.fn(async (args: { data: Partial<InMemoryStorageObject>; select?: Record<string, boolean> }) => {
        const now = new Date();
        const row: InMemoryStorageObject = {
          id: randomUUID(),
          name: '',
          size: 0n,
          mimeType: 'application/octet-stream',
          storageKey: '',
          storageProvider: 's3',
          bucket: null,
          status: 'pending',
          metadata: null,
          uploadedById: null,
          createdAt: now,
          updatedAt: now,
          ...args.data,
        };
        objects.push(row);
        return pick(row, args.select);
      }),
      delete: jest.fn(async (args: { where: { id: string } }) => {
        const index = objects.findIndex((o) => o.id === args.where.id);
        if (index === -1) throw new Error('storageObject.delete: not found');
        return objects.splice(index, 1)[0];
      }),
    },
  };

  return {
    objects,
    blobs,
    provider,
    storageConfig,
    prisma,
    /** Adds a `ready` object (with bytes) owned by `uploadedById`; returns its row. */
    addObject(input: {
      uploadedById: string;
      bytes?: Buffer;
      mimeType?: string;
      name?: string;
      status?: string;
      /** The row's recorded size; defaults to the byte count. */
      size?: number;
    }): InMemoryStorageObject {
      const bytes = input.bytes ?? Buffer.from('fake-image-bytes');
      const now = new Date();
      const row: InMemoryStorageObject = {
        id: randomUUID(),
        name: input.name ?? 'upload.png',
        size: BigInt(input.size ?? bytes.length),
        mimeType: input.mimeType ?? 'image/png',
        storageKey: `uploads/${now.getTime()}/${randomUUID()}.png`,
        storageProvider: 's3',
        bucket: BUCKET,
        status: input.status ?? 'ready',
        metadata: null,
        uploadedById: input.uploadedById,
        createdAt: now,
        updatedAt: now,
      };

      objects.push(row);
      blobs.set(row.storageKey, bytes);

      return row;
    },
    /** Switch the deployment between configured and unconfigured storage. */
    setConfigured(value: boolean) {
      configured = value;
    },
    /** Forget every object and blob; configured again. */
    reset() {
      objects.length = 0;
      blobs.clear();
      configured = true;
    },
  };
}

export type InMemoryAiStorage = ReturnType<typeof createInMemoryAiStorage>;
