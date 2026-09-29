import { StorageObjectReferences } from '../../intake/storage-object-references';
import { GymPhotoObjectReferences } from './gym-photo-references';

describe('GymPhotoObjectReferences', () => {
  it('registers with the intake module and answers from gym_photos', async () => {
    const references = new StorageObjectReferences();
    const prisma = { gymPhoto: { count: jest.fn(async ({ where }: any) => (where.storageObjectId === 'kept' ? 1 : 0)) } };
    const checker = new GymPhotoObjectReferences(references, prisma as never);

    checker.onModuleInit();

    expect(references.list()).toEqual(['gym_photos']);
    await expect(references.isReferenced('kept')).resolves.toBe(true);
    await expect(references.isReferenced('free')).resolves.toBe(false);
    expect(prisma.gymPhoto.count).toHaveBeenCalledWith({ where: { storageObjectId: 'kept' } });
  });
});
