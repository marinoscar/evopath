import { StorageObjectReferences } from '../intake/storage-object-references';
import { HealthDocumentObjectReferences } from './health-document-object-references';

// =============================================================================
// `health_documents` reference checker (H1, #185)
// =============================================================================
//
// A file a health document still holds (fileDeletedAt null) is referenced,
// whatever its retention: `keep` forever, `delete_after_processing` until the
// purge job erased it. Real rows: `test/health-data/health-documents.db.spec.ts`.
// =============================================================================

const OBJECT = '55555555-5555-4555-8555-555555555555';

describe('HealthDocumentObjectReferences', () => {
  function make(count: number | Error) {
    const prisma = {
      healthDocument: {
        count: jest.fn(async () => {
          if (count instanceof Error) throw count;
          return count;
        }),
      },
    };
    const references = new StorageObjectReferences();
    const checker = new HealthDocumentObjectReferences(references, prisma as never);
    return { prisma, references, checker };
  }

  it('registers itself as health_documents', () => {
    const { references, checker } = make(0);

    checker.onModuleInit();

    expect(references.list()).toEqual(['health_documents']);
  });

  it('counts only documents that still hold the object (file not deleted)', async () => {
    const { prisma, checker } = make(1);

    await expect(checker.isReferenced(OBJECT)).resolves.toBe(true);
    expect(prisma.healthDocument.count).toHaveBeenCalledWith({
      where: { storageObjectId: OBJECT, fileDeletedAt: null },
    });
  });

  it('an object no live document holds is not referenced', async () => {
    const { checker } = make(0);

    await expect(checker.isReferenced(OBJECT)).resolves.toBe(false);
  });

  it('a failing check keeps the object (StorageObjectReferences fails safe)', async () => {
    const { references, checker } = make(new Error('db down'));
    checker.onModuleInit();
    jest.spyOn((references as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);

    await expect(references.isReferenced(OBJECT)).resolves.toBe(true);
  });
});
