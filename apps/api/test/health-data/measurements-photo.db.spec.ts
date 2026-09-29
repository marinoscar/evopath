// =============================================================================
// Real-Postgres test: "Read a value from a photo" (E2.6, #64)
// =============================================================================
//
// What only a real server can prove:
//   - the whole flow over real rows: an intake with a photo, `analyze` queues
//     the job, the handler (with a stubbed model answer) stores pending AI
//     drafts, the user edits and accepts, `apply` writes ONE entry whose
//     `source_ref` JSON round-trips exactly;
//   - `apply` is atomic: a failing second measurement row leaves no entry, the
//     intake `ready` and its items as they were; a 400 (the blood-pressure
//     pair) rolls back the same way;
//   - a repeated apply is 409 and creates no second entry;
//   - a later edit of the saved AI row recomputes `userEdited` on the new
//     revision (true when changed, false when changed back).
//
// The model is stubbed at `AiService.forUser(...).respondStructured` (the
// gate pipeline is covered by the mocked integration suite and the AI
// guardrails). Every user and storage object is created by this suite with
// run-unique values and removed in `afterAll`.
//
// THIS IS A `*.db.spec.ts` FILE — skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Run with
// `npm run test:db` against a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';

import type { AiService } from '../../src/ai/runtime/ai.service';
import { IntakeKindRegistry } from '../../src/intake/intake-kind.registry';
import { IntakeService } from '../../src/intake/intake.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobsService } from '../../src/jobs/jobs.service';
import { updateMeasurementEntrySchema, type CreateMeasurementEntryInput } from '../../src/measurements/dto/measurement.dto';
import { type EntryProvenance, MeasurementsService } from '../../src/measurements/measurements.service';
import { BodyMetricReadingHandler } from '../../src/measurements/photo/body-metric-reading.handler';
import { BodyMetricReadingIntakeKind } from '../../src/measurements/photo/body-metric-reading.kind';
import { bodyMetricOutputSchema } from '../../src/measurements/photo/body-metric-reading.prompt';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { bodyMetricFixture, type BodyMetricFixture } from '../fixtures/body-metric/load';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('measurements-photo.db.spec');

/** What a contributor's resolved permissions carry for this flow (the route passes `RequestUser.permissions`). */
const PERMS = ['intakes:read', 'intakes:write', 'health_data:read', 'health_data:write'];

/** A `MeasurementsService` whose Nth measurement insert inside a transaction fails. */
class FlakyMeasurementsService extends MeasurementsService {
  failOnInsert: number | null = null;

  override async createEntryInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    input: CreateMeasurementEntryInput,
    provenance: EntryProvenance | readonly EntryProvenance[],
  ) {
    const failOn = this.failOnInsert;
    if (failOn === null) return super.createEntryInTransaction(tx, userId, input, provenance);

    let inserts = 0;
    const flakyTx = new Proxy(tx, {
      get(target, prop, receiver) {
        if (prop !== 'measurement') return Reflect.get(target, prop, receiver);
        return {
          create: async (args: Prisma.MeasurementCreateArgs) => {
            inserts += 1;
            if (inserts === failOn) throw new Error('simulated failure on a measurement insert');
            return target.measurement.create(args);
          },
        };
      },
    });

    return super.createEntryInTransaction(flakyTx, userId, input, provenance);
  }
}

describeWithDb('read a value from a photo (real Postgres)', () => {
  let client: PrismaClient;
  let intakes: IntakeService;
  let measurements: FlakyMeasurementsService;
  let handler: BodyMetricReadingHandler;
  let answer: BodyMetricFixture;
  const run = randomUUID().slice(0, 8);
  const createdUserIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const user = await client.user.create({
      data: { email: `photo-read-${label}-${run}@example.com` },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  async function makePhoto(userId: string, label: string): Promise<string> {
    const object = await client.storageObject.create({
      data: {
        name: `${label}.jpg`,
        size: BigInt(2048),
        mimeType: 'image/jpeg',
        storageKey: `test/photo-read/${run}/${label}-${randomUUID()}`,
        status: 'ready',
        uploadedById: userId,
      },
      select: { id: true },
    });
    return object.id;
  }

  /** An intake read by the handler: create, attach, analyze (queues the job), run the job. */
  async function readPhoto(userId: string, fixture: BodyMetricFixture) {
    const intake = await intakes.create(userId, { kind: 'body_metric_reading' }, PERMS);
    const photoId = await makePhoto(userId, fixture);
    await intakes.attachPhoto(userId, intake.id, photoId, PERMS);
    const { jobId } = await intakes.analyze(userId, intake.id, { provider: 'openai', modelId: 'vision-model' }, PERMS);

    const job = await client.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ type: 'ai.health.body_metric_reading', subjectType: 'photo_intake', subjectId: intake.id });

    answer = fixture;
    await handler.process(job);
    // The job row is only scaffolding for this suite; settle it so it never blocks a re-analyze.
    await client.job.update({ where: { id: jobId }, data: { status: 'succeeded', finishedAt: new Date() } });

    return { intakeId: intake.id, photoId };
  }

  const items = (intakeId: string) =>
    client.draftItem.findMany({ where: { intakeId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });

  const rowsOf = (userId: string) =>
    client.measurement.findMany({ where: { userId }, orderBy: [{ metricKey: 'asc' }, { revision: 'asc' }] });

  beforeAll(() => {
    client = createDbClient();
    const prisma = client as unknown as PrismaService;
    const kinds = new IntakeKindRegistry();
    measurements = new FlakyMeasurementsService(prisma);
    new BodyMetricReadingIntakeKind(kinds, measurements).onModuleInit();
    intakes = new IntakeService(
      prisma,
      kinds,
      new JobsService(prisma),
      { assertUsable: jest.fn(async () => ({})) } as never,
      { delete: jest.fn(async () => undefined) } as never,
    );
    const respondStructured = jest.fn(async () => ({ parsed: bodyMetricOutputSchema.parse(bodyMetricFixture(answer)) }));
    handler = new BodyMetricReadingHandler(
      new JobHandlerRegistry(),
      prisma,
      { forUser: () => ({ respondStructured }) } as unknown as AiService,
      intakes,
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    measurements.failOnInsert = null;
  });

  afterAll(async () => {
    const rows = await client.photoIntake.findMany({ where: { userId: { in: createdUserIds } }, select: { id: true } });
    await client.job.deleteMany({ where: { subjectType: 'photo_intake', subjectId: { in: rows.map((r) => r.id) } } });
    await client.storageObject.deleteMany({ where: { uploadedById: { in: createdUserIds } } });
    await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await client.$disconnect();
    jest.restoreAllMocks();
  });

  it('scale photo -> edit -> accept -> apply: one entry, source_ref round-trips, later edits recompute userEdited', async () => {
    const userId = await makeUser('flow');
    const { intakeId, photoId } = await readPhoto(userId, 'scale-display');

    const intake = await client.photoIntake.findUniqueOrThrow({ where: { id: intakeId } });
    expect(intake.status).toBe('ready');
    expect(intake.resultMeta).toMatchObject({ promptVersion: 1, deviceKind: 'scale', unreadable: false });

    const [draft] = await items(intakeId);
    expect(draft).toMatchObject({
      origin: 'ai',
      status: 'pending',
      userVerified: false,
      confidence: 'high',
      sourcePhotoIds: [photoId],
      value: { metricKey: 'weight', value: 208.4, unit: 'lb', method: 'scale' },
    });
    expect(await rowsOf(userId)).toEqual([]); // nothing written before apply

    // The pending item blocks apply.
    await expect(intakes.apply(userId, intakeId, PERMS)).rejects.toBeInstanceOf(BadRequestException);

    await intakes.updateItem(
      userId,
      intakeId,
      draft.id,
      { value: { metricKey: 'weight', value: 207.4, unit: 'lb', method: 'scale' }, status: 'accepted' },
      PERMS,
    );

    const result = (await intakes.apply(userId, intakeId, PERMS)) as { entryId: string; items: unknown[] };
    expect(result.items).toHaveLength(1);

    const [row] = await rowsOf(userId);
    expect(row).toMatchObject({ entryId: result.entryId, metricKey: 'weight', value: 94.0751, unit: 'kg', origin: 'ai' });
    expect(row.sourceRef).toEqual({
      kind: 'photo_intake',
      intakeId,
      draftItemId: draft.id,
      storageObjectIds: [photoId],
      aiDraft: { metricKey: 'weight', value: 208.4, unit: 'lb', method: 'scale' },
      confidence: 'high',
      userEdited: true,
    });
    expect((await client.photoIntake.findUniqueOrThrow({ where: { id: intakeId } })).status).toBe('applied');
    // The photo stays stored and linked from the intake.
    expect(await client.photoIntakePhoto.count({ where: { intakeId, storageObjectId: photoId } })).toBe(1);

    // Back to what the photo said (in kg): userEdited flips to false on the new revision.
    await measurements.updateEntry(
      userId,
      result.entryId,
      updateMeasurementEntrySchema.parse({ readings: [{ metricKey: 'weight', value: 208.4, unit: 'lb' }] }),
    );
    let active = await client.measurement.findFirstOrThrow({ where: { userId, supersededAt: null } });
    expect(active).toMatchObject({ revision: 2, origin: 'ai' });
    expect(active.sourceRef).toMatchObject({ userEdited: false, aiDraft: { value: 208.4 } });

    await measurements.updateEntry(
      userId,
      result.entryId,
      updateMeasurementEntrySchema.parse({ readings: [{ metricKey: 'weight', value: 90 }] }),
    );
    active = await client.measurement.findFirstOrThrow({ where: { userId, supersededAt: null } });
    expect(active.sourceRef).toMatchObject({ userEdited: true });
  });

  it('without health_data:write, apply is a 403 that writes nothing and leaves the intake ready', async () => {
    const userId = await makeUser('no-health');
    const { intakeId } = await readPhoto(userId, 'scale-display');
    await intakes.acceptAll(userId, intakeId, PERMS);

    await expect(intakes.apply(userId, intakeId, ['intakes:read', 'intakes:write'])).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(await rowsOf(userId)).toEqual([]);
    expect((await client.photoIntake.findUniqueOrThrow({ where: { id: intakeId } })).status).toBe('ready');
  });

  it('a repeated apply is 409 and creates no second entry', async () => {
    const userId = await makeUser('twice');
    const { intakeId } = await readPhoto(userId, 'scale-display');
    await intakes.acceptAll(userId, intakeId, PERMS);

    await intakes.apply(userId, intakeId, PERMS);
    await expect(intakes.apply(userId, intakeId, PERMS)).rejects.toBeInstanceOf(ConflictException);

    expect(await rowsOf(userId)).toHaveLength(1);
  });

  it('apply is atomic: a failing second row leaves no entry and the intake ready', async () => {
    const userId = await makeUser('atomic');
    const { intakeId } = await readPhoto(userId, 'bp-cuff');
    const [, , pulse] = await items(intakeId);
    await intakes.updateItem(userId, intakeId, pulse.id, { status: 'rejected' }, PERMS);
    await intakes.acceptAll(userId, intakeId, PERMS);

    measurements.failOnInsert = 2;
    await expect(intakes.apply(userId, intakeId, PERMS)).rejects.toThrow('simulated failure');

    expect(await rowsOf(userId)).toEqual([]);
    expect((await client.photoIntake.findUniqueOrThrow({ where: { id: intakeId } })).status).toBe('ready');
    expect((await items(intakeId)).map((i) => i.status)).toEqual(['accepted', 'accepted', 'rejected']);

    // And the retry succeeds: one entry, the rejected pulse not saved.
    measurements.failOnInsert = null;
    await intakes.apply(userId, intakeId, PERMS);
    expect((await rowsOf(userId)).map((r) => [r.metricKey, r.value])).toEqual([
      ['bp_diastolic', 82],
      ['bp_systolic', 128],
    ]);
  });

  it('a blood-pressure refusal rolls back and leaves the intake ready', async () => {
    const userId = await makeUser('bp');
    const { intakeId } = await readPhoto(userId, 'bp-cuff');
    const [systolic, diastolic, pulse] = await items(intakeId);
    await intakes.updateItem(userId, intakeId, systolic.id, { status: 'accepted' }, PERMS);
    await intakes.updateItem(userId, intakeId, diastolic.id, { status: 'rejected' }, PERMS);
    await intakes.updateItem(userId, intakeId, pulse.id, { status: 'accepted' }, PERMS);

    await expect(intakes.apply(userId, intakeId, PERMS)).rejects.toThrow('Enter both blood pressure numbers');

    expect(await rowsOf(userId)).toEqual([]);
    expect((await client.photoIntake.findUniqueOrThrow({ where: { id: intakeId } })).status).toBe('ready');
  });

  it('an out-of-range AI reading is stored flagged and refused at apply until edited', async () => {
    const userId = await makeUser('range');
    const { intakeId } = await readPhoto(userId, 'out-of-range');
    const [wild] = await items(intakeId);
    expect(wild).toMatchObject({ confidence: 'low', uncertain: true, uncertaintyNote: 'Outside the usual range for weight' });

    await intakes.acceptAll(userId, intakeId, PERMS);
    await expect(intakes.apply(userId, intakeId, PERMS)).rejects.toBeInstanceOf(BadRequestException);
    expect((await client.photoIntake.findUniqueOrThrow({ where: { id: intakeId } })).status).toBe('ready');

    await intakes.updateItem(
      userId,
      intakeId,
      wild.id,
      { value: { metricKey: 'weight', value: 99.9, unit: 'kg' } },
      PERMS,
    );
    await intakes.apply(userId, intakeId, PERMS);

    const [row] = await rowsOf(userId);
    expect(row).toMatchObject({ value: 99.9, origin: 'ai' });
    expect(row.sourceRef).toMatchObject({ aiDraft: { value: 9999, unit: 'kg' }, confidence: 'low', userEdited: true });
  });

  it('unreadable photo: no items; a hand-added item applies as manual, linked to the intake', async () => {
    const userId = await makeUser('unreadable');
    const { intakeId } = await readPhoto(userId, 'unreadable');
    expect(await items(intakeId)).toEqual([]);
    expect((await client.photoIntake.findUniqueOrThrow({ where: { id: intakeId } })).resultMeta).toMatchObject({
      unreadable: true,
    });

    await intakes.addItem(
      userId,
      intakeId,
      { kind: 'reading', value: { metricKey: 'weight', value: 81.2, unit: 'kg' } },
      PERMS,
    );
    await intakes.apply(userId, intakeId, PERMS);

    const [row] = await rowsOf(userId);
    expect(row).toMatchObject({ value: 81.2, origin: 'manual', sourceRef: { kind: 'photo_intake', intakeId } });
  });
});
