import { StorageObjectReferences } from '../intake/storage-object-references';
import { ProgressPhotoObjectReferences } from './progress-photo-references';

describe('ProgressPhotoObjectReferences', () => {
  it('registers with the intake module and answers from progress_photos', async () => {
    const references = new StorageObjectReferences();
    const prisma = { progressPhoto: { count: jest.fn(async ({ where }: any) => (where.storageObjectId === 'kept' ? 1 : 0)) } };
    const checker = new ProgressPhotoObjectReferences(references, prisma as never);

    checker.onModuleInit();

    expect(references.list()).toEqual(['progress_photos']);
    await expect(references.isReferenced('kept')).resolves.toBe(true);
    await expect(references.isReferenced('free')).resolves.toBe(false);
    expect(prisma.progressPhoto.count).toHaveBeenCalledWith({ where: { storageObjectId: 'kept' } });
  });
});
