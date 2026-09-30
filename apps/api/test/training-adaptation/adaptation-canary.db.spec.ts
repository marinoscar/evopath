// =============================================================================
// Quick workout adaptation: the data-minimisation canary on REAL rows (E6.1)
// =============================================================================
//
// A user whose every private column holds a unique token, in real Postgres:
// their name and email, date of birth and bio, weight history, a lab value and
// a medication in measurement notes, two gyms with names, notes, coordinates
// and equipment notes, another user's gym, the check-in NOTE, a workout note, a
// set's pain note, an exercise note, a limitation's description and the plan's
// name. The REAL `AdaptationContextBuilder` reads them through real queries;
// the planner and critic are the scripted `FakeAiProvider`.
//
// Nothing of it may appear in ANY recorded provider request, in the stored
// context snapshot, the run's events or the adaptation the API would return;
// and what the preview shows is exactly what was stored.
//
// THIS IS A `*.db.spec.ts` FILE: skipped with a warning when no Postgres is
// reachable; see `test/jobs/db-test-support.ts`. Needs a migrated database.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { createAiRuntimeHarness, HARNESS_MODEL } from '../../src/ai/testing/ai-runtime-harness';
import { FAKE_TEXT_MODEL_CAPABILITIES } from '../../src/ai/testing/fake-ai-provider';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobsService } from '../../src/jobs/jobs.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { NEVER_SEND_LABELS } from '../../src/training-agents/context/never-send';
import { RunEventsService } from '../../src/training-agents/runtime/run-events.service';
import type { TrainingModelResolver } from '../../src/training-agents/models/training-model-resolver.service';
import type { TrainingRunsService } from '../../src/training-agents/runtime/training-runs.service';
import { SCRIPT_USAGE } from '../../src/training-agents/testing/agent-scripts';
import { ADAPTATION_RUN_JOB_TYPE } from '../../src/training-adaptation/adaptation.constants';
import { AdaptationService } from '../../src/training-adaptation/adaptation.service';
import type { AdaptationContextBuilder } from '../../src/training-adaptation/context/adaptation-context.builder';
import { AdaptationRunHandler } from '../../src/training-adaptation/handlers/adaptation-run.handler';
import { parseContextBlock } from '../../src/training-adaptation/prompts/markers';
import { ACCEPT, adaptationRequestFixture, modelExercise, proposalAnswer } from '../../src/training-adaptation/testing/adaptation-fixtures';
import { READY_ROLE } from '../../src/training-adaptation/testing/adaptation-rig';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { type AdaptationDbRig, DB_NOW, createAdaptationDbRig } from './adaptation-db.helper';

const { describeWithDb } = resolveDbSuite('adaptation-canary.db.spec');

describeWithDb('adaptation data minimisation on real rows (real Postgres)', () => {
  let client: PrismaClient;
  let prisma: PrismaService;
  let rig: AdaptationDbRig;
  let events: RunEventsService;
  const tag = randomUUID().slice(0, 8);
  const otherUsers: string[] = [];
  const equipmentTypeIds: string[] = [];
  const canary = {
    displayName: `CANARY-DISPLAY-NAME-${tag}`,
    providerName: `CANARY-PROVIDER-NAME-${tag}`,
    dateOfBirth: '1987-06-05',
    bio: `CANARY-BIO-${tag}`,
    weightNote: `CANARY-WEIGHT-NOTE-${tag}`,
    weightValue: '87.6543',
    labNote: `CANARY-LAB-NOTE-${tag}`,
    labValue: '13.9137',
    medicationNote: `CANARY-MEDICATION-${tag}`,
    checkInNote: `CANARY-CHECKIN-NOTE-${tag}`,
    workoutNote: `CANARY-WORKOUT-NOTE-${tag}`,
    painNote: `CANARY-PAIN-NOTE-${tag}`,
    exerciseNote: `CANARY-EXERCISE-NOTE-${tag}`,
    gymName: `CANARY-GYM-NAME-${tag}`,
    gymNotes: `CANARY-GYM-NOTES-${tag}`,
    otherGymName: `CANARY-OTHER-GYM-${tag}`,
    theirGymName: `CANARY-THEIR-GYM-${tag}`,
    latitude: '9.928134',
    longitude: '-84.090725',
    equipmentNote: `CANARY-EQUIPMENT-NOTE-${tag}`,
    equipmentBrand: `CANARY-BRAND-${tag}`,
    limitation: `CANARY-LIMITATION-${tag}`,
    planName: `CANARY-PLAN-NAME-${tag}`,
  };

  beforeAll(async () => {
    client = createDbClient();
    prisma = client as unknown as PrismaService;
    events = new RunEventsService(prisma);
    rig = await createAdaptationDbRig(client);
  });

  afterAll(async () => {
    const adaptations = await client.workoutAdaptation.findMany({ where: { user: { email: { contains: tag } } }, select: { id: true, runId: true } });
    const threads = adaptations.map((a) => a.runId).filter((id): id is string => !!id);
    await client.trainingRunCheckpointWrite.deleteMany({ where: { threadId: { in: threads } } });
    await client.trainingRunCheckpoint.deleteMany({ where: { threadId: { in: threads } } });
    await client.job.deleteMany({ where: { type: ADAPTATION_RUN_JOB_TYPE, subjectId: { in: adaptations.map((a) => a.id) } } });
    await rig.cleanup();
    await client.gym.deleteMany({ where: { userId: { in: otherUsers } } });
    await client.user.deleteMany({ where: { id: { in: otherUsers } } });
    await client.equipmentType.deleteMany({ where: { id: { in: equipmentTypeIds } } });
    await client.$disconnect();
  });

  /** The user with a plan, and every private column of theirs filled with a canary. */
  async function seededUser() {
    const user = await rig.user();
    await client.user.update({ where: { id: user.id }, data: { displayName: canary.displayName, providerDisplayName: canary.providerName } });
    await client.program.update({
      where: { id: user.programId! },
      data: {
        name: canary.planName,
        intake: { experience: 'intermediate', avoidExerciseKeys: [], limitations: [{ area: 'knee', description: canary.limitation }] },
      },
    });
    await client.healthProfile.create({ data: { userId: user.id, dateOfBirth: new Date(canary.dateOfBirth), bio: canary.bio, timeZone: 'UTC' } });

    const measurement = (metricKey: string, value: number, extra: Record<string, unknown> = {}) => ({
      userId: user.id,
      entryId: randomUUID(),
      metricKey,
      value,
      unit: 'x',
      measuredAt: DB_NOW,
      ...extra,
    });
    await client.measurement.createMany({
      data: [
        // Today's check-in: four scores, the note on one row.
        measurement('energy', 3, { localDate: new Date('2026-09-30'), notes: canary.checkInNote }),
        measurement('sleep_quality', 4, { localDate: new Date('2026-09-30') }),
        measurement('muscle_soreness', 2, { localDate: new Date('2026-09-30') }),
        measurement('stress', 2, { localDate: new Date('2026-09-30') }),
        // Weight history, a lab value and a medication note.
        measurement('weight', Number(canary.weightValue), { localDate: new Date('2026-09-01'), notes: canary.weightNote }),
        measurement('weight', 88.1234, { localDate: new Date('2026-08-01'), notes: canary.weightNote }),
        measurement('ldl_cholesterol', Number(canary.labValue), { notes: canary.labNote }),
        measurement('note_medication', 1, { notes: canary.medicationNote }),
      ],
    });

    const equipmentType = await client.equipmentType.create({
      data: { slug: `custom-${randomUUID().slice(0, 8)}`, name: `Adapt dumbbells ${tag}`, category: 'free_weights', ownerUserId: user.id },
      select: { id: true },
    });
    equipmentTypeIds.push(equipmentType.id);
    const gym = await client.gym.create({
      data: { userId: user.id, name: canary.gymName, notes: canary.gymNotes, latitude: Number(canary.latitude), longitude: Number(canary.longitude), isDefault: true, type: 'home' },
      select: { id: true },
    });
    await client.gymEquipment.create({ data: { gymId: gym.id, equipmentTypeId: equipmentType.id, quantity: 2, brand: canary.equipmentBrand, notes: canary.equipmentNote } });
    const other = await client.gym.create({ data: { userId: user.id, name: canary.otherGymName, notes: canary.gymNotes, latitude: 1.5, longitude: 2.5 }, select: { id: true } });

    const stranger = await rig.user(false);
    otherUsers.push(stranger.id);
    await client.gym.create({ data: { userId: stranger.id, name: canary.theirGymName, notes: canary.gymNotes }, select: { id: true } });

    // History: a workout with a note, an exercise note and a pain-flagged set with a pain note (on the third exercise).
    await client.workout.create({
      data: {
        userId: user.id,
        name: 'Earlier',
        date: new Date('2026-09-27'),
        status: 'completed',
        startedAt: new Date('2026-09-27T10:00:00Z'),
        endedAt: new Date('2026-09-27T11:00:00Z'),
        notes: canary.workoutNote,
        exercises: {
          create: [
            { exerciseId: rig.exerciseIds[2], position: 0, notes: canary.exerciseNote, sets: { create: [{ setNumber: 1, weightKg: 20, reps: 10, completed: true, painFlag: true, painNote: canary.painNote }] } },
            { exerciseId: rig.exerciseIds[1], position: 1, sets: { create: [{ setNumber: 1, weightKg: 40, reps: 8, completed: true }] } },
          ],
        },
      },
    });

    return { user, gymId: gym.id, otherGymId: other.id, equipmentTypeId: equipmentType.id };
  }

  /** The service, handler and provider over the REAL builder and rows. */
  function wire() {
    const resolver = {
      resolveForRun: async () => ({
        roles: { planner: READY_ROLE('planner'), critic: READY_ROLE('critic') },
        settings: undefined,
        limits: () => ({}),
      }),
    } as unknown as TrainingModelResolver;
    const service = new AdaptationService(
      prisma,
      new JobsService(prisma),
      resolver,
      events,
      { cancel: jest.fn() } as unknown as TrainingRunsService,
      rig.builder,
      {} as never,
      {} as never,
      {} as never,
    );

    const h = createAiRuntimeHarness({
      models: [{ modelId: HARNESS_MODEL, capabilities: FAKE_TEXT_MODEL_CAPABILITIES }],
      fake: {
        responses: (req) => {
          if (req.metadata?.agent === 'critic') return { outputText: JSON.stringify(ACCEPT), usage: SCRIPT_USAGE };
          // A planner that answers from what it was SENT: today's exercises, by key.
          const sent = parseContextBlock(req.input as string) as { today?: { exercises: Array<{ key: string }> } };
          const keys = (sent.today?.exercises ?? []).map((e) => e.key);
          const answer = proposalAnswer(keys.map((key, i) => modelExercise(key, { isPriority: i === 0, sets: 3, repMin: 6, repMax: 10, targetRpe: 7 })));
          return { outputText: JSON.stringify(answer), usage: SCRIPT_USAGE };
        },
      },
    });
    const contextPort = { build: (userId: string, request: never) => rig.builder.build(userId, request, DB_NOW) };
    const handler = new AdaptationRunHandler(new JobHandlerRegistry(), prisma, h.ai, h.aiConfig, events, rig.builder as unknown as AdaptationContextBuilder, {
      cancelPollMs: 50,
      contextPort,
    });

    return { service, h, handler };
  }

  async function run(userId: string, body: Record<string, unknown>) {
    const { service, h, handler } = wire();
    h.addUserKey(userId, `sk-canary-db-key-${tag}`, [HARNESS_MODEL]);
    const request = adaptationRequestFixture(body as never);
    const started = await service.create(userId, request, DB_NOW);
    const job = await client.job.findUniqueOrThrow({ where: { id: started.jobId! } });
    await handler.process(job);
    return { service, h, started, adaptation: await client.workoutAdaptation.findUniqueOrThrow({ where: { id: started.adaptationId } }) };
  }

  it('no private value of any of those rows reaches a provider request, the stored snapshot, the run events or the API view', async () => {
    const { user, gymId, otherGymId } = await seededUser();

    const { h, started, adaptation, service } = await run(user.id, { minutes: 30, lowEnergy: true, freeText: 'travelling this week' });

    expect(adaptation.status).toBe('ready');
    const requests = JSON.stringify(h.fake.calls.map((c) => c.request));
    const tokens = [
      ...Object.values(canary),
      user.email,
      user.id,
      user.programId!,
      gymId,
      otherGymId,
      ...rig.exerciseIds,
    ];
    for (const token of tokens) expect(requests).not.toContain(token);
    expect(requests).not.toContain('1987');
    // Nor in what was stored for review or what the API returns.
    const view = JSON.stringify(await service.get(user.id, started.adaptationId));
    const eventLog = JSON.stringify(await events.list(started.runId!, 0, 500));
    const stored = JSON.stringify({ snapshot: adaptation.contextSnapshot, proposal: adaptation.proposal, guardrails: adaptation.guardrailReport, critic: adaptation.criticReport, safety: adaptation.safety });
    for (const token of [...Object.values(canary), user.email]) {
      expect(view).not.toContain(token);
      expect(eventLog).not.toContain(token);
      expect(stored).not.toContain(token);
    }

    // Positive control: what is allowed did travel, and the plan's exercises by key.
    const planner = parseContextBlock(h.fake.calls.find((c) => c.request?.metadata?.agent === 'planner')!.request!.input as string) as {
      request: { minutes: number; freeText: string };
      readiness: unknown;
      gym: { type: string; equipment: Array<{ name: string; quantity: number }> };
      today: { exercises: Array<{ key: string }> };
      lastSessions?: Array<{ key: string; topSet: { weightKg: number } }>;
    };
    expect(planner.request).toMatchObject({ minutes: 30, freeText: 'travelling this week' });
    expect(planner.readiness).toEqual({ energy: 3, sleepQuality: 4, soreness: 2, stress: 2 });
    expect(planner.gym).toMatchObject({ type: 'home', equipment: [{ name: `Adapt dumbbells ${tag}`, quantity: 2 }] });
    expect(planner.today.exercises.map((e) => e.key)).toEqual(rig.slugs);
    expect(planner.lastSessions?.find((s) => s.key === rig.slugs[1])?.topSet.weightKg).toBe(40);
  });

  it('the pain-flagged exercise is excluded from the candidates by key, without a word of the pain note', async () => {
    const { user } = await seededUser();

    const { h } = await run(user.id, { minutes: 30 });

    const planner = parseContextBlock(h.fake.calls.find((c) => c.request?.metadata?.agent === 'planner')!.request!.input as string) as {
      candidates: Array<{ key: string }>;
      constraints: { avoidExerciseKeys: string[]; limitationAreas: string[] };
    };
    expect(planner.constraints.avoidExerciseKeys).toContain(rig.slugs[2]);
    expect(planner.constraints.limitationAreas).toEqual(['knee']);
    expect(planner.candidates.map((c) => c.key)).not.toContain(rig.slugs[2]);
    expect(JSON.stringify(h.fake.calls.map((c) => c.request))).not.toContain(canary.painNote);
  });

  it('what the preview shows is exactly what was stored as the snapshot, with the "never sent" list', async () => {
    const { user } = await seededUser();
    const body = { minutes: 30, soreness: { muscles: ['chest'], level: 'mild' } };
    const { service } = wire();

    const preview = await service.preview(user.id, body, DB_NOW);
    const { adaptation } = await run(user.id, body);

    const stored = adaptation.contextSnapshot as { summary: { sections: unknown[]; excluded: string[] } };
    expect(preview.sentData.sections).toEqual(stored.summary.sections);
    expect(preview.sentData.excluded).toEqual(stored.summary.excluded);
    expect(preview.sentData.excluded).toEqual([...NEVER_SEND_LABELS]);
    expect(JSON.stringify(preview)).not.toContain(canary.checkInNote);
    expect(JSON.stringify(preview)).not.toContain(user.email);
  });

  it('useReadiness: false sends no scores at all, and the note stays out either way', async () => {
    const { user } = await seededUser();

    const { h } = await run(user.id, { minutes: 30, useReadiness: false });

    for (const call of h.fake.calls) expect(call.request!.input as string).not.toContain('readiness');
    expect(JSON.stringify(h.fake.calls.map((c) => c.request))).not.toContain(canary.checkInNote);
  });

  it('another user\'s gym is a 404 (the same as a missing one), and nothing of it is read into a request', async () => {
    const { user } = await seededUser();
    const theirs = await client.gym.findFirstOrThrow({ where: { name: canary.theirGymName }, select: { id: true } });
    const { service, h } = wire();

    await expect(service.create(user.id, adaptationRequestFixture({ minutes: 30, gymId: theirs.id }), DB_NOW)).rejects.toMatchObject({ status: 404 });
    await expect(service.create(user.id, adaptationRequestFixture({ minutes: 30, gymId: randomUUID() }), DB_NOW)).rejects.toMatchObject({ status: 404 });

    expect(h.fake.calls).toHaveLength(0);
  });

  it('an only-equipment type that is not in the chosen gym is 400 ADAPTATION_EQUIPMENT_NOT_IN_GYM', async () => {
    const { user, equipmentTypeId } = await seededUser();
    const { service } = wire();
    const notInGym = randomUUID();

    const error = await service
      .create(user.id, adaptationRequestFixture({ minutes: 30, equipment: { mode: 'only', equipmentTypeIds: [equipmentTypeId, notInGym] } }), DB_NOW)
      .catch((e: unknown) => e as { getStatus(): number; getResponse(): { details: Record<string, unknown> } });

    expect((error as { getStatus(): number }).getStatus()).toBe(400);
    expect((error as { getResponse(): { details: Record<string, unknown> } }).getResponse().details).toMatchObject({ reason: 'ADAPTATION_EQUIPMENT_NOT_IN_GYM', equipmentTypeIds: [notInGym] });
  });
});
