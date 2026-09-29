// =============================================================================
// Real-Postgres test: "Scan gym" end to end (E3.4)
// =============================================================================
//
// The REAL `IntakeService`, `gym_equipment` kind, `EquipmentScanHandler`,
// `GymsService` and seeded catalog over Postgres, with the AI runtime from
// the #432 harness (`FakeAiProvider` answering the reference fixtures). Each
// photo exists twice: as a `storage_objects` row in Postgres (what the intake
// and gym tables reference) and, under the same id, in the harness's
// in-memory object storage (what the AI input resolver reads).
//
// What it proves:
//   - both reference examples, through create -> attach -> analyze -> the
//     job -> GET, yield exactly `*.expected-drafts.json`;
//   - apply: accepted items become `gym_equipment` rows with provenance
//     (`origin: ai`, confidence, `userVerified`, `originalAiValue` only when
//     edited), rejected ones nothing; every intake photo becomes a gym photo
//     (idempotently); each row links its source photos; an identical existing
//     row is untouched and counted `merged`; an `other` item creates ONE
//     reusable custom type;
//   - `assertContext`: another user's gym is a 404 on create.
//
//   - storage cleanup: removing a scanned gym photo, or the gym, deletes the
//     storage object even though the APPLIED intake still links it (the
//     links go by cascade); an unapplied intake still holds its photo; and
//     the other way round, discarding an intake (or detaching its photo)
//     never deletes an object that is still a gym photo.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a MIGRATED database;
// it does not need the seed: CI runs `test:db` before `prisma:seed`, so
// `beforeAll` upserts the catalog from `prisma/seed-data.ts` (idempotent, the
// same writes the seed makes).
// =============================================================================

import { randomUUID } from 'node:crypto';

import { Logger, NotFoundException } from '@nestjs/common';
import type { Job, PrismaClient } from '@prisma/client';

import { CAPABILITY_CATALOG, EQUIPMENT_CATALOG } from '../../prisma/seed-data';
import { createAiRuntimeHarness, HARNESS_MODEL, HARNESS_PROVIDER } from '../../src/ai/testing/ai-runtime-harness';
import { GymPhotosService } from '../../src/gyms/gym-photos.service';
import { GymStorageService } from '../../src/gyms/gym-storage.service';
import { GymsService } from '../../src/gyms/gyms.service';
import { GymEquipmentIntakeKind } from '../../src/gyms/intake/gym-equipment.intake-kind';
import { GymPhotoObjectReferences } from '../../src/gyms/intake/gym-photo-references';
import { EquipmentScanHandler } from '../../src/gyms/scan/equipment-scan.handler';
import { EquipmentVocabularyService } from '../../src/gyms/scan/equipment-vocabulary';
import { IntakeKindRegistry } from '../../src/intake/intake-kind.registry';
import { IntakeService } from '../../src/intake/intake.service';
import { StorageObjectReferences } from '../../src/intake/storage-object-references';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobsService } from '../../src/jobs/jobs.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { loadExpectedDrafts, loadModelOutput, type GymScanExample } from '../fixtures/gym-scan.fixtures';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('gym-equipment-scan.db.spec');

/** The seeded catalog, upserted by slug, for a database `prisma:seed` has not run on. */
async function ensureCatalog(client: PrismaClient): Promise<void> {
  const capabilityIds = new Map<string, string>();

  for (const cap of CAPABILITY_CATALOG) {
    const data = {
      name: cap.name,
      movementPattern: cap.movementPattern,
      primaryMuscles: cap.primaryMuscles,
      description: cap.description ?? null,
      sortOrder: cap.sortOrder,
    };
    const row = await client.capability.upsert({
      where: { slug: cap.slug },
      update: data,
      create: { slug: cap.slug, ...data },
      select: { id: true },
    });
    capabilityIds.set(cap.slug, row.id);
  }

  for (const item of EQUIPMENT_CATALOG) {
    const data = {
      name: item.name,
      category: item.category,
      aliases: item.aliases,
      description: item.description ?? null,
      sortOrder: item.sortOrder,
    };
    const row = await client.equipmentType.upsert({
      where: { slug: item.slug },
      update: data,
      create: { slug: item.slug, ...data },
      select: { id: true },
    });
    await client.equipmentTypeCapability.createMany({
      data: item.capabilities.map((slug) => ({ equipmentTypeId: row.id, capabilityId: capabilityIds.get(slug)! })),
      skipDuplicates: true,
    });
  }
}

describeWithDb('"Scan gym" end to end (real Postgres)', () => {
  let client: PrismaClient;
  let intakes: IntakeService;
  let handler: EquipmentScanHandler;
  let gyms: GymsService;
  let gymPhotos: GymPhotosService;
  let harness: ReturnType<typeof createAiRuntimeHarness>;
  let nextOutput: unknown;
  const run = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `gym-scan-${label}-${run}@example.com` },
      select: { id: true },
    });
    userIds.push(user.id);
    harness.addUserKey(user.id, `sk-db-${label}-${run}`, [HARNESS_MODEL]);
    return user.id;
  }

  async function makeGym(userId: string, name = 'Home Gym'): Promise<string> {
    const gym = await client.gym.create({ data: { userId, name }, select: { id: true } });
    return gym.id;
  }

  /** One photo: a Postgres row and the harness's in-memory object, same id. */
  async function makePhoto(userId: string, name: string): Promise<string> {
    const row = await client.storageObject.create({
      data: {
        name,
        size: BigInt(1024),
        mimeType: 'image/jpeg',
        storageKey: `test/gym-scan/${run}/${randomUUID()}`,
        status: 'ready',
        uploadedById: userId,
      },
      select: { id: true },
    });
    const memory = harness.storage.addObject({ uploadedById: userId, mimeType: 'image/jpeg', name });
    memory.id = row.id;
    return row.id;
  }

  /** create -> attach -> analyze -> run the queued job; returns the intake id and photo ids. */
  async function scan(userId: string, gymId: string, example: GymScanExample, photoCount = 1) {
    const intake = await intakes.create(userId, { kind: 'gym_equipment', context: { gymId } });
    const photoIds: string[] = [];

    for (let i = 0; i < photoCount; i += 1) {
      const id = await makePhoto(userId, `${example}-${i}.jpg`);
      await intakes.attachPhoto(userId, intake.id, id);
      photoIds.push(id);
    }

    nextOutput = loadModelOutput(example);
    const { jobId } = await intakes.analyze(userId, intake.id, { provider: HARNESS_PROVIDER, modelId: HARNESS_MODEL });
    const job = await client.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ type: 'ai.equipment.scan', subjectType: 'photo_intake', subjectId: intake.id });

    await handler.process(job as Job);

    return { intakeId: intake.id, photoIds };
  }

  const withoutIds = (items: Array<Record<string, unknown>>) =>
    items.map(({ id: _id, sortOrder: _sortOrder, ...rest }) => rest);

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    harness = createAiRuntimeHarness({
      fake: { responses: () => ({ outputText: JSON.stringify(nextOutput) }) },
    });

    await ensureCatalog(client);

    const registry = new IntakeKindRegistry();
    // Deletes the `storage_objects` row, as `ObjectsService.delete` does after the provider.
    const objects = {
      delete: async (id: string) => {
        await client.storageObject.delete({ where: { id } });
      },
    };
    const storage = new GymStorageService(prisma, objects as never);
    gyms = new GymsService(prisma, storage);
    gymPhotos = new GymPhotosService(prisma, gyms, storage);
    const vocabulary = new EquipmentVocabularyService(prisma);
    new GymEquipmentIntakeKind(registry, gyms, vocabulary, prisma).onModuleInit();

    const references = new StorageObjectReferences();
    new GymPhotoObjectReferences(references, prisma).onModuleInit();

    intakes = new IntakeService(
      prisma,
      registry,
      new JobsService(prisma),
      { assertUsable: jest.fn(async () => ({})) } as never,
      objects as never,
      references,
    );
    handler = new EquipmentScanHandler(new JobHandlerRegistry(), harness.ai, intakes, vocabulary, prisma);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    const intakeRows = await client.photoIntake.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    await client.job.deleteMany({
      where: { subjectType: 'photo_intake', subjectId: { in: intakeRows.map((row) => row.id) } },
    });
    // Gyms first: gym_equipment -> equipment_types is Restrict.
    await client.gym.deleteMany({ where: { userId: { in: userIds } } });
    await client.storageObject.deleteMany({ where: { uploadedById: { in: userIds } } });
    await client.user.deleteMany({ where: { id: { in: userIds } } });
    await client.$disconnect();
  });

  it.each(['cardio-row-wide', 'leg-curl-placard'] as const)(
    '%s yields exactly the expected drafts, and the intake is ready with the scan meta',
    async (example) => {
      const userId = await makeUser(`example-${example}`);
      const gymId = await makeGym(userId);

      const { intakeId, photoIds } = await scan(userId, gymId, example);
      const view = await intakes.get(userId, intakeId);

      expect(view.status).toBe('ready');
      expect(view.subjectType).toBe('gym');
      expect(view.subjectId).toBe(gymId);
      expect(withoutIds(view.items as never)).toEqual(loadExpectedDrafts(example, photoIds));
      expect(view.items.map((item) => item.sortOrder)).toEqual(view.items.map((_, index) => index));
      expect(view.resultMeta).toMatchObject({ promptVersion: 1, chunks: 1, photoCount: 1, failedChunks: [] });
      expect(harness.usageEvents.filter((row) => row.userId === userId)).toHaveLength(1);

      const listed = await intakes.list(userId, {
        kind: 'gym_equipment',
        subjectId: gymId,
        status: ['draft', 'scanning', 'ready'],
        limit: 20,
      });
      expect(listed.map((row) => row.id)).toEqual([intakeId]);
    },
  );

  it("refuses to start a scan of another user's gym with 404", async () => {
    const owner = await makeUser('owner');
    const stranger = await makeUser('stranger');
    const gymId = await makeGym(owner);

    await expect(
      intakes.create(stranger, { kind: 'gym_equipment', context: { gymId } }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('apply: provenance, rejected items, photos, links, merge with an identical row, one custom type', async () => {
    const userId = await makeUser('apply');
    const gymId = await makeGym(userId);
    const elliptical = await client.equipmentType.findUniqueOrThrow({ where: { slug: 'elliptical' } });
    const bike = await client.equipmentType.findUniqueOrThrow({ where: { slug: 'stationary_bike' } });

    // Already in the gym, identical to the Matrix bike (case-insensitive brand).
    const existing = await client.gymEquipment.create({
      data: { gymId, equipmentTypeId: bike.id, quantity: 2, brand: 'MATRIX', notes: 'Keep me' },
    });

    const { intakeId, photoIds } = await scan(userId, gymId, 'cardio-row-wide');
    const items = (await intakes.get(userId, intakeId)).items;
    const [ellipticalItem, matrixBike, precorBike, unknown] = items;

    // Edit the elliptical (4 instead of 3), reject the Precor bike, accept the rest.
    await intakes.updateItem(userId, intakeId, ellipticalItem.id, {
      value: { ...(ellipticalItem.value as object), quantity: 4 },
      status: 'accepted',
    });
    await intakes.updateItem(userId, intakeId, precorBike.id, { status: 'rejected' });
    await intakes.acceptAll(userId, intakeId);
    // A user item for the same unidentified machine name: one custom type, reused.
    await intakes.addItem(userId, intakeId, {
      kind: 'equipment',
      value: { equipmentTypeSlug: null, name: 'UNIDENTIFIED MACHINE (partly out of frame)', quantity: 1, brand: 'Acme' },
    });

    const result = await intakes.apply(userId, intakeId);

    expect(result).toEqual({ gymId, created: 3, merged: 1, photosAttached: 1, photosSkipped: 0 });

    const photos = await client.gymPhoto.findMany({ where: { gymId } });
    expect(photos.map((photo) => photo.storageObjectId)).toEqual(photoIds);

    const rows = await client.gymEquipment.findMany({
      where: { gymId },
      include: { equipmentType: true, photos: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(4);

    // The existing Matrix bike is untouched, but linked to the photo.
    const kept = rows.find((row) => row.id === existing.id)!;
    expect(kept).toMatchObject({ quantity: 2, brand: 'MATRIX', notes: 'Keep me', origin: 'manual' });
    expect(kept.photos.map((link) => link.gymPhotoId)).toEqual([photos[0].id]);
    expect(matrixBike.value).toMatchObject({ brand: 'Matrix' });

    const ellipticalRow = rows.find((row) => row.equipmentTypeId === elliptical.id)!;
    expect(ellipticalRow).toMatchObject({
      quantity: 4,
      brand: 'Precor',
      model: null,
      origin: 'ai',
      confidence: 'medium',
      userVerified: true,
    });
    expect(ellipticalRow.originalAiValue).toEqual({
      equipmentTypeId: elliptical.id,
      equipmentTypeSlug: 'elliptical',
      name: 'Elliptical',
      quantity: 3,
      brand: 'Precor',
      model: null,
      notes: null,
    });
    expect(ellipticalRow.photos.map((link) => link.gymPhotoId)).toEqual([photos[0].id]);

    // The rejected Precor bike created nothing: the only bike is the existing one.
    expect(rows.filter((row) => row.equipmentTypeId === bike.id)).toHaveLength(1);

    // The unidentified machine: an AI row (not edited: no originalAiValue) and
    // the user's row share ONE custom type.
    const custom = rows.filter((row) => row.equipmentType.ownerUserId === userId);
    expect(custom).toHaveLength(2);
    expect(new Set(custom.map((row) => row.equipmentTypeId)).size).toBe(1);
    expect(custom[0].equipmentType).toMatchObject({
      name: 'Unidentified machine (partly out of frame)',
      category: 'accessories',
    });
    expect(custom[0].equipmentType.slug).toMatch(/^custom-[a-z0-9]{8}$/);
    const aiUnknown = custom.find((row) => row.origin === 'ai')!;
    expect(aiUnknown).toMatchObject({ confidence: 'low', userVerified: true, originalAiValue: null });
    expect(aiUnknown.photos).toHaveLength(1);
    const userRow = custom.find((row) => row.origin === 'manual')!;
    expect(userRow).toMatchObject({ brand: 'Acme', confidence: null, userVerified: true });
    expect(userRow.photos).toHaveLength(0);
    expect(unknown.value).toMatchObject({ equipmentTypeSlug: null });

    expect((await client.photoIntake.findUniqueOrThrow({ where: { id: intakeId } })).status).toBe('applied');
  });

  it('a second scan of the same gym merges identical rows, reuses the custom type, and attaches only new photos', async () => {
    const userId = await makeUser('rescan');
    const gymId = await makeGym(userId);

    const first = await scan(userId, gymId, 'cardio-row-wide');
    await intakes.acceptAll(userId, first.intakeId);
    expect(await intakes.apply(userId, first.intakeId)).toMatchObject({ created: 4, merged: 0, photosAttached: 1 });

    const second = await scan(userId, gymId, 'both', 2);
    await intakes.acceptAll(userId, second.intakeId);
    expect(await intakes.apply(userId, second.intakeId)).toEqual({
      gymId,
      created: 1, // the leg curl
      merged: 4,
      photosAttached: 2,
      photosSkipped: 0,
    });

    expect(await client.gymPhoto.count({ where: { gymId } })).toBe(3);
    expect(await client.equipmentType.count({ where: { ownerUserId: userId } })).toBe(1);

    const legCurl = await client.gymEquipment.findFirstOrThrow({
      where: { gymId, equipmentType: { slug: 'leg_curl_machine' } },
      include: { photos: { include: { gymPhoto: true } } },
    });
    expect(legCurl).toMatchObject({ confidence: 'high', brand: 'Precor', origin: 'ai' });
    expect(legCurl.photos.map((link) => link.gymPhoto.storageObjectId)).toEqual([second.photoIds[1]]);
  });

  describe('storage cleanup after a scan', () => {
    const objectExists = async (id: string) => (await client.storageObject.count({ where: { id } })) === 1;

    it('removing a scanned gym photo deletes its object; the applied intake keeps its items', async () => {
      const userId = await makeUser('cleanup-photo');
      const gymId = await makeGym(userId);
      const { intakeId, photoIds } = await scan(userId, gymId, 'leg-curl-placard');
      await intakes.acceptAll(userId, intakeId);
      await intakes.apply(userId, intakeId);

      const [photo] = await client.gymPhoto.findMany({ where: { gymId } });
      expect(await client.photoIntakePhoto.count({ where: { storageObjectId: photoIds[0] } })).toBe(1);

      await gymPhotos.remove(userId, gymId, photo.id);

      expect(await objectExists(photoIds[0])).toBe(false);
      expect(await client.photoIntakePhoto.count({ where: { storageObjectId: photoIds[0] } })).toBe(0);
      const view = await intakes.get(userId, intakeId);
      expect(view.status).toBe('applied');
      expect(view.photos).toEqual([]);
      expect(view.items[0].sourcePhotoIds).toEqual([photoIds[0]]);
    });

    it('deleting the gym deletes the objects of its applied scans', async () => {
      const userId = await makeUser('cleanup-gym');
      const gymId = await makeGym(userId);
      const { intakeId, photoIds } = await scan(userId, gymId, 'both', 2);
      await intakes.acceptAll(userId, intakeId);
      await intakes.apply(userId, intakeId);

      await gyms.remove(userId, gymId);

      for (const id of photoIds) {
        expect(await objectExists(id)).toBe(false);
      }
    });

    it('discarding a ready intake whose object is also a gym photo keeps the object and the gym photo', async () => {
      const userId = await makeUser('discard-held');
      const gymId = await makeGym(userId);
      const { intakeId, photoIds } = await scan(userId, gymId, 'both', 2);
      const photo = await client.gymPhoto.create({ data: { gymId, storageObjectId: photoIds[0] } });

      await intakes.discard(userId, intakeId);

      expect(await client.photoIntake.count({ where: { id: intakeId } })).toBe(0);
      expect(await objectExists(photoIds[0])).toBe(true);
      expect(await client.gymPhoto.count({ where: { id: photo.id } })).toBe(1);
      // The control: the photo nothing else uses is deleted.
      expect(await objectExists(photoIds[1])).toBe(false);
    });

    it('detaching an intake photo that is also a gym photo keeps the object and the gym photo', async () => {
      const userId = await makeUser('detach-held');
      const gymId = await makeGym(userId);
      const { intakeId, photoIds } = await scan(userId, gymId, 'leg-curl-placard');
      const photo = await client.gymPhoto.create({ data: { gymId, storageObjectId: photoIds[0] } });

      await intakes.detachPhoto(userId, intakeId, photoIds[0]);

      expect(await objectExists(photoIds[0])).toBe(true);
      expect(await client.gymPhoto.count({ where: { id: photo.id } })).toBe(1);
      expect((await intakes.get(userId, intakeId)).photos).toEqual([]);
    });

    it('an unapplied intake still holds its photo: the object survives the gym photo removal', async () => {
      const userId = await makeUser('cleanup-held');
      const gymId = await makeGym(userId);
      const { intakeId, photoIds } = await scan(userId, gymId, 'leg-curl-placard');
      // Still `ready`: the same object is also a gym photo (attached by hand).
      const photo = await client.gymPhoto.create({ data: { gymId, storageObjectId: photoIds[0] } });

      await gymPhotos.remove(userId, gymId, photo.id);

      expect(await objectExists(photoIds[0])).toBe(true);
      expect((await intakes.get(userId, intakeId)).photos.map((p) => p.storageObjectId)).toEqual(photoIds);
    });
  });

  it('a photo already attached to the gym is not attached twice', async () => {
    const userId = await makeUser('idempotent');
    const gymId = await makeGym(userId);

    const { intakeId, photoIds } = await scan(userId, gymId, 'leg-curl-placard');
    const preexisting = await client.gymPhoto.create({ data: { gymId, storageObjectId: photoIds[0] } });
    await intakes.acceptAll(userId, intakeId);

    expect(await intakes.apply(userId, intakeId)).toMatchObject({ created: 1, photosAttached: 0 });

    const row = await client.gymEquipment.findFirstOrThrow({ where: { gymId }, include: { photos: true } });
    expect(row.photos.map((link) => link.gymPhotoId)).toEqual([preexisting.id]);
    expect(await client.gymPhoto.count({ where: { gymId } })).toBe(1);
  });
});
