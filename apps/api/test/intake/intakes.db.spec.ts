// =============================================================================
// Real-Postgres test: photo intakes (E3.1)
// =============================================================================
//
// What only a real server can prove:
//   - cascades: a user's deletion removes their intakes, photo links and
//     items; a discarded intake removes its links and items but not the
//     storage objects; a deleted storage object removes only its link, and
//     an item's `sourcePhotoIds` keeps pointing at it ("photo removed");
//   - the unique `(intake_id, storage_object_id)` link, as a 409;
//   - `replaceAiDrafts` keeps accepted, rejected, edited and user items, and
//     under concurrency: two analyzers racing produce exactly one batch (the
//     loser is 409 `NOT_SCANNING`), and a user edit racing a re-scan is
//     never lost;
//   - `originalAiValue` is write-once under two concurrent first edits;
//   - `apply` is one transaction: a kind that writes and then throws leaves
//     nothing written and the intake `ready`; two concurrent applies run the
//     kind once;
//   - `analyze` writes the `scanning` status and a `pending` job of the
//     kind's type together.
//
// A TEST-ONLY stub kind stands in for a consumer. Every user and storage
// object is created by this suite with run-unique values and removed in
// `afterAll`.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Run with
// `npm run test:db` against a migrated database.
// =============================================================================

import { stubFeatureResolver } from '../../src/ai/testing/feature-resolver.stub';
import { randomUUID } from 'node:crypto';

import { ConflictException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import type { IntakeApplyArgs, IntakeKind } from '../../src/intake/intake-kind.interface';
import { IntakeKindRegistry } from '../../src/intake/intake-kind.registry';
import { IntakeService } from '../../src/intake/intake.service';
import { JobsService } from '../../src/jobs/jobs.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { trustingInputInspector } from '../../src/intake/testing/input-inspector.stub';

const { describeWithDb } = resolveDbSuite('intakes.db.spec');

const STUB_JOB_TYPE = 'test.intake.analyze';

function reasonOf(error: unknown): string | undefined {
  return ((error as { getResponse?: () => any }).getResponse?.() ?? {}).details?.reason;
}

describeWithDb('photo intakes (real Postgres)', () => {
  let client: PrismaClient;
  let registry: IntakeKindRegistry;
  let service: IntakeService;
  let applyImpl: (args: IntakeApplyArgs) => Promise<unknown>;
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];
  const objects = { delete: jest.fn(async () => undefined) };

  const stubKind: IntakeKind = {
    kind: 'test_stub',
    contextSchema: z.undefined(),
    valueSchema: z.object({ name: z.string().min(1).max(100) }).strict(),
    analyzeJobType: STUB_JOB_TYPE,
    aiFeature: 'gym_scan',
    apply: (args) => applyImpl(args),
  };

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `intake-${label}-${run}@example.com` },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  async function makeObject(userId: string, label: string): Promise<string> {
    const object = await client.storageObject.create({
      data: {
        name: `${label}.jpg`,
        size: BigInt(1024),
        mimeType: 'image/jpeg',
        storageKey: `test/intake/${run}/${label}-${randomUUID()}`,
        status: 'ready',
        uploadedById: userId,
      },
      select: { id: true },
    });
    return object.id;
  }

  async function makeIntake(userId: string, status = 'draft'): Promise<string> {
    const intake = await service.create(userId, { kind: 'test_stub' });
    if (status !== 'draft') {
      await client.photoIntake.update({ where: { id: intake.id }, data: { status } });
    }
    return intake.id;
  }

  const items = (intakeId: string) =>
    client.draftItem.findMany({ where: { intakeId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });

  beforeAll(() => {
    client = createDbClient();
    registry = new IntakeKindRegistry();
    registry.register(stubKind);
    service = new IntakeService(
      client as unknown as PrismaService,
      registry,
      new JobsService(client as unknown as PrismaService),
      { assertUsable: jest.fn(async () => ({})) } as never,
      objects as never,
      stubFeatureResolver({ provider: 'openai', modelId: 'vision-model' }) as never,
      trustingInputInspector(),
    );
  });

  beforeEach(() => {
    applyImpl = async ({ accepted }) => ({ applied: accepted.length });
    objects.delete.mockClear();
  });

  afterAll(async () => {
    const intakes = await client.photoIntake.findMany({
      where: { userId: { in: createdUserIds } },
      select: { id: true },
    });
    await client.job.deleteMany({ where: { subjectType: 'photo_intake', subjectId: { in: intakes.map((i) => i.id) } } });
    await client.storageObject.deleteMany({ where: { uploadedById: { in: createdUserIds } } });
    await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await client.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // Cascades and the unique link
  // ---------------------------------------------------------------------------

  it("deleting a user removes their intakes, photo links and items", async () => {
    const userId = await makeUser('cascade-user');
    const objectId = await makeObject(userId, 'a');
    const intakeId = await makeIntake(userId);
    await service.attachPhoto(userId, intakeId, objectId);
    await service.addItem(userId, intakeId, { kind: 'thing', value: { name: 'Bench' } });

    await client.storageObject.deleteMany({ where: { id: objectId } });
    await client.user.delete({ where: { id: userId } });

    expect(await client.photoIntake.count({ where: { id: intakeId } })).toBe(0);
    expect(await client.photoIntakePhoto.count({ where: { intakeId } })).toBe(0);
    expect(await client.draftItem.count({ where: { intakeId } })).toBe(0);
  });

  it('deleting a storage object removes only its link; items keep its id', async () => {
    const userId = await makeUser('cascade-object');
    const objectId = await makeObject(userId, 'b');
    const intakeId = await makeIntake(userId);
    await service.attachPhoto(userId, intakeId, objectId);
    await client.photoIntake.update({ where: { id: intakeId }, data: { status: 'scanning' } });
    await service.replaceAiDrafts(intakeId, [
      { kind: 'thing', value: { name: 'Rack' }, confidence: 'high', sourcePhotoIds: [objectId] },
    ]);

    await client.storageObject.delete({ where: { id: objectId } });

    const view = await service.get(userId, intakeId);
    expect(view.photos).toEqual([]);
    expect(view.items).toHaveLength(1);
    expect(view.items[0].sourcePhotoIds).toEqual([objectId]);
  });

  it('discarding an intake removes its links and items, and asks storage to delete the unreferenced object only', async () => {
    const userId = await makeUser('discard');
    const shared = await makeObject(userId, 'shared');
    const own = await makeObject(userId, 'own');
    const first = await makeIntake(userId);
    const second = await makeIntake(userId);
    await service.attachPhoto(userId, first, shared);
    await service.attachPhoto(userId, first, own);
    await service.attachPhoto(userId, second, shared);
    await service.addItem(userId, first, { kind: 'thing', value: { name: 'x' } });

    await service.discard(userId, first);

    expect(await client.photoIntake.count({ where: { id: first } })).toBe(0);
    expect(await client.photoIntakePhoto.count({ where: { intakeId: first } })).toBe(0);
    expect(await client.draftItem.count({ where: { intakeId: first } })).toBe(0);
    // The storage rows themselves survive the cascade...
    expect(await client.storageObject.count({ where: { id: { in: [shared, own] } } })).toBe(2);
    // ...and only the one no other intake links is handed to ObjectsService.
    expect(objects.delete.mock.calls).toEqual([[own, userId]]);
  });

  it('refuses a second link of the same object to one intake with 409 DUPLICATE_PHOTO (a real unique index)', async () => {
    const userId = await makeUser('unique');
    const objectId = await makeObject(userId, 'dup');
    const intakeId = await makeIntake(userId);

    await service.attachPhoto(userId, intakeId, objectId);
    const error = await service.attachPhoto(userId, intakeId, objectId).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(reasonOf(error)).toBe('DUPLICATE_PHOTO');
    await expect(
      client.photoIntakePhoto.create({ data: { intakeId, storageObjectId: objectId } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it("another user's intake and object are 404s", async () => {
    const owner = await makeUser('owner');
    const stranger = await makeUser('stranger');
    const objectId = await makeObject(owner, 'mine');
    const intakeId = await makeIntake(owner);
    const strangersIntake = await makeIntake(stranger);

    await expect(service.get(stranger, intakeId)).rejects.toMatchObject({ status: 404 });
    await expect(service.attachPhoto(stranger, strangersIntake, objectId)).rejects.toMatchObject({ status: 404 });
  });

  // ---------------------------------------------------------------------------
  // replaceAiDrafts
  // ---------------------------------------------------------------------------

  it('replaceAiDrafts never deletes accepted, rejected, edited or user items', async () => {
    const userId = await makeUser('replace');
    const intakeId = await makeIntake(userId, 'scanning');

    await service.replaceAiDrafts(intakeId, [
      { kind: 'thing', value: { name: 'accept me' }, confidence: 'high' },
      { kind: 'thing', value: { name: 'reject me' }, confidence: 'medium' },
      { kind: 'thing', value: { name: 'edit me' }, confidence: 'low' },
      { kind: 'thing', value: { name: 'untouched' }, confidence: 'low', uncertain: true },
    ]);
    const [accept, reject, edit, untouched] = await items(intakeId);
    expect(untouched.userVerified).toBe(false);

    await service.updateItem(userId, intakeId, accept.id, { status: 'accepted' });
    await service.updateItem(userId, intakeId, reject.id, { status: 'rejected' });
    await service.updateItem(userId, intakeId, edit.id, { value: { name: 'edited' } });
    await service.addItem(userId, intakeId, { kind: 'thing', value: { name: 'mine' } });

    await client.photoIntake.update({ where: { id: intakeId }, data: { status: 'scanning' } });
    const result = await service.replaceAiDrafts(intakeId, [{ kind: 'thing', value: { name: 'rescan' }, confidence: 'high' }]);

    expect(result).toMatchObject({ inserted: 1, removed: 1 });
    const after = await items(intakeId);
    expect(after.map((i) => (i.value as { name: string }).name)).toEqual(['accept me', 'reject me', 'edited', 'mine', 'rescan']);
    expect(after.find((i) => i.id === untouched.id)).toBeUndefined();
    expect((await client.photoIntake.findUniqueOrThrow({ where: { id: intakeId } })).status).toBe('ready');
  });

  it('two analyzers racing replaceAiDrafts store exactly one batch; the loser is 409 NOT_SCANNING', async () => {
    const userId = await makeUser('race');
    const intakeId = await makeIntake(userId, 'scanning');

    const outcomes = await Promise.allSettled([
      service.replaceAiDrafts(intakeId, [
        { kind: 'thing', value: { name: 'A1' }, confidence: 'high' },
        { kind: 'thing', value: { name: 'A2' }, confidence: 'high' },
      ]),
      service.replaceAiDrafts(intakeId, [
        { kind: 'thing', value: { name: 'B1' }, confidence: 'low' },
        { kind: 'thing', value: { name: 'B2' }, confidence: 'low' },
      ]),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(reasonOf(rejected[0].reason)).toBe('NOT_SCANNING');

    const names = (await items(intakeId)).map((i) => (i.value as { name: string }).name);
    expect([['A1', 'A2'], ['B1', 'B2']]).toContainEqual(names);
  });

  it('a user edit racing a re-scan is never lost', async () => {
    const userId = await makeUser('edit-race');

    for (let round = 0; round < 5; round += 1) {
      const intakeId = await makeIntake(userId, 'scanning');
      await service.replaceAiDrafts(intakeId, [{ kind: 'thing', value: { name: 'first scan' }, confidence: 'low' }]);
      const [item] = await items(intakeId);
      await client.photoIntake.update({ where: { id: intakeId }, data: { status: 'scanning' } });

      const [edit] = await Promise.allSettled([
        service.updateItem(userId, intakeId, item.id, { value: { name: 'my fix' } }),
        service.replaceAiDrafts(intakeId, [{ kind: 'thing', value: { name: 'second scan' }, confidence: 'high' }]),
      ]);

      const after = await items(intakeId);
      if (edit.status === 'fulfilled') {
        // The edit committed first: the re-scan kept it.
        expect(after.find((i) => i.id === item.id)).toMatchObject({ value: { name: 'my fix' }, userVerified: true });
      } else {
        // The re-scan removed the untouched draft first: the edit is a 404, never a silent loss.
        expect((edit.reason as { status?: number }).status).toBe(404);
        expect(after.find((i) => i.id === item.id)).toBeUndefined();
      }
      expect(after.some((i) => (i.value as { name: string }).name === 'second scan')).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Provenance
  // ---------------------------------------------------------------------------

  it('originalAiValue is written once: two concurrent first edits both keep the AI value', async () => {
    const userId = await makeUser('once');
    const intakeId = await makeIntake(userId, 'scanning');
    await service.replaceAiDrafts(intakeId, [{ kind: 'thing', value: { name: 'AI said' }, confidence: 'medium' }]);
    const [item] = await items(intakeId);

    await Promise.all([
      service.updateItem(userId, intakeId, item.id, { value: { name: 'tab one' } }),
      service.updateItem(userId, intakeId, item.id, { value: { name: 'tab two' } }),
    ]);
    await service.updateItem(userId, intakeId, item.id, { value: { name: 'later' } });

    const stored = await client.draftItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stored.originalAiValue).toEqual({ name: 'AI said' });
    expect(stored.value).toEqual({ name: 'later' });
    expect(stored.userVerified).toBe(true);
    expect(stored.confidence).toBe('medium');
  });

  // ---------------------------------------------------------------------------
  // Apply
  // ---------------------------------------------------------------------------

  it('a kind that writes and then throws rolls everything back and leaves the intake ready', async () => {
    const userId = await makeUser('rollback');
    const intakeId = await makeIntake(userId, 'ready');
    const item = await service.addItem(userId, intakeId, { kind: 'thing', value: { name: 'x' } });

    applyImpl = async ({ tx, accepted }) => {
      await tx.draftItem.updateMany({ where: { id: { in: accepted.map((a) => a.id) } }, data: { sortOrder: 999 } });
      throw new Error('domain write failed');
    };

    await expect(service.apply(userId, intakeId)).rejects.toThrow('domain write failed');

    const intake = await client.photoIntake.findUniqueOrThrow({ where: { id: intakeId } });
    expect(intake.status).toBe('ready');
    expect(intake.completedAt).toBeNull();
    expect((await client.draftItem.findUniqueOrThrow({ where: { id: item.id } })).sortOrder).toBe(item.sortOrder);
  });

  it('two concurrent applies run the kind once; the other is 409 ALREADY_APPLIED', async () => {
    const userId = await makeUser('apply-race');
    const intakeId = await makeIntake(userId, 'ready');
    await service.addItem(userId, intakeId, { kind: 'thing', value: { name: 'x' } });
    let calls = 0;
    applyImpl = async ({ accepted }) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { applied: accepted.length };
    };

    const outcomes = await Promise.allSettled([service.apply(userId, intakeId), service.apply(userId, intakeId)]);

    expect(calls).toBe(1);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toEqual([{ status: 'fulfilled', value: { applied: 1 } }]);
    const [loser] = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(reasonOf(loser.reason)).toBe('ALREADY_APPLIED');
    expect((await client.photoIntake.findUniqueOrThrow({ where: { id: intakeId } })).status).toBe('applied');
  });

  // ---------------------------------------------------------------------------
  // Analyze
  // ---------------------------------------------------------------------------

  it("analyze writes scanning, the model and a pending job of the kind's type together", async () => {
    const userId = await makeUser('analyze');
    const objectId = await makeObject(userId, 'scan');
    const intakeId = await makeIntake(userId);
    await service.attachPhoto(userId, intakeId, objectId);

    const started = await service.analyze(userId, intakeId, { provider: 'openai', modelId: 'vision-model' });

    const intake = await client.photoIntake.findUniqueOrThrow({ where: { id: intakeId } });
    const job = await client.job.findUniqueOrThrow({ where: { id: started.jobId } });
    expect(intake).toMatchObject({ status: 'scanning', provider: 'openai', modelId: 'vision-model', jobId: job.id });
    expect(job).toMatchObject({
      type: STUB_JOB_TYPE,
      status: 'pending',
      subjectType: 'photo_intake',
      subjectId: intakeId,
      payload: { intakeId },
    });

    const second = await service.analyze(userId, intakeId, { provider: 'openai', modelId: 'vision-model' }).catch((e: unknown) => e);
    expect(reasonOf(second)).toBe('INTAKE_SCANNING');

    expect(await service.failIntake(intakeId, 'AI_PROVIDER_ERROR', 'The provider failed')).toBe(true);
    expect(await client.photoIntake.findUniqueOrThrow({ where: { id: intakeId } })).toMatchObject({
      status: 'failed',
      errorCode: 'AI_PROVIDER_ERROR',
    });
  });
});
