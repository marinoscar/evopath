// =============================================================================
// EquipmentScanHandler (E3.4) — the `ai.equipment.scan` job
// =============================================================================
//
// Over the #432 AI harness: the REAL `AiService` gate pipeline, usage
// recorder and storage input resolver (in-memory object storage), with
// `FakeAiProvider` answering the reference fixtures. The intake reads and
// writes are stubs recording what the handler asked for; the real
// `IntakeService` round trip is `test/gyms/gym-equipment-scan.db.spec.ts`.
// =============================================================================

import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { loadExpectedDrafts, loadModelOutput, seedVocabulary } from '../../../test/fixtures/gym-scan.fixtures';
import { AiError } from '../../ai/core/ai-error';
import {
  createAiRuntimeHarness,
  HARNESS_MODEL,
  HARNESS_PROVIDER,
  HARNESS_USER,
  type AiRuntimeHarnessOptions,
} from '../../ai/testing/ai-runtime-harness';
import type { FakeAiScript } from '../../ai/testing/fake-ai-provider';
import type { AiDraftInput } from '../../intake/intake-kind.interface';
import { JobSettledEvent } from '../../jobs/events/job-settled.event';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { JOB_TYPE_LABELS } from '../../jobs/job-type-labels';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { gymEquipmentValueSchema, normalizeEquipmentValue, resolveCatalogType } from '../intake/gym-equipment.value';
import { EquipmentScanHandler, buildScanContent, chunkPhotos } from './equipment-scan.handler';
import { EQUIPMENT_SCAN_PROMPT_VERSION } from './equipment-scan.prompt';

const INTAKE = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '66666666-6666-4666-8666-666666666666';
const vocab = seedVocabulary();

type Script = FakeAiScript;

function setup(opts: { harness?: AiRuntimeHarnessOptions; script?: Script; photos?: number; status?: string } = {}) {
  let script: Script | undefined = opts.script;
  const h = createAiRuntimeHarness({
    ...opts.harness,
    fake: {
      responses: (req, ctx) => {
        if (typeof script === 'function') return script(req, ctx);
        throw new Error('no script');
      },
    },
  });

  const photos = Array.from({ length: opts.photos ?? 1 }, (_, i) =>
    h.storage.addObject({ uploadedById: HARNESS_USER, mimeType: 'image/jpeg', name: `photo-${i}.jpg` }),
  );
  const photoIds = photos.map((p) => p.id);

  const intake = {
    id: INTAKE,
    userId: HARNESS_USER,
    status: opts.status ?? 'scanning',
    provider: HARNESS_PROVIDER,
    modelId: HARNESS_MODEL,
    photos: photoIds.map((storageObjectId) => ({ storageObjectId })),
  };
  let present = true;

  const prisma = {
    photoIntake: {
      findUnique: jest.fn(async (args: { select?: Record<string, unknown> }) => {
        if (!present) return null;
        return args.select && !('photos' in args.select) ? { status: intake.status } : { ...intake };
      }),
    },
  };

  const written: { drafts: AiDraftInput[]; resultMeta: Record<string, any> }[] = [];
  const intakes = {
    replaceAiDrafts: jest.fn(async (_id: string, drafts: AiDraftInput[], options: { resultMeta?: any }) => {
      written.push({ drafts: [...drafts], resultMeta: options.resultMeta });
      intake.status = 'ready';
      return { inserted: drafts.length, removed: 0, invalid: [] };
    }),
    failIntake: jest.fn(async (_id: string, _code: string, _message: string) => {
      if (intake.status !== 'scanning') return false;
      intake.status = 'failed';
      return true;
    }),
  };

  const registry = new JobHandlerRegistry();
  const handler = new EquipmentScanHandler(
    registry,
    h.ai,
    intakes as never,
    { load: async () => vocab } as never,
    prisma as never,
  );
  handler.onModuleInit();

  const job = { id: JOB_ID, type: 'ai.equipment.scan', payload: { intakeId: INTAKE } } as unknown as Job;

  return {
    h,
    handler,
    registry,
    job,
    photoIds,
    intake,
    intakes,
    written,
    prisma,
    setScript(next: Script) {
      script = next;
    },
    discard() {
      present = false;
    },
  };
}

const answer = (example: 'cardio-row-wide' | 'leg-curl-placard' | 'both' | object): Script => () => ({
  outputText: JSON.stringify(typeof example === 'string' ? loadModelOutput(example) : example),
});

/** What `replaceAiDrafts` stores for an AI draft: value validated + normalized, provenance defaults. */
function stored(draft: AiDraftInput) {
  const parsed = gymEquipmentValueSchema.parse(draft.value);
  const resolved = parsed.equipmentTypeSlug ? resolveCatalogType(vocab, parsed.equipmentTypeSlug) : null;

  return {
    kind: draft.kind,
    origin: 'ai',
    status: 'pending',
    confidence: draft.confidence,
    uncertain: draft.uncertain ?? false,
    uncertaintyNote: draft.uncertaintyNote ?? null,
    sourcePhotoIds: draft.sourcePhotoIds ?? [],
    userVerified: false,
    originalAiValue: null,
    value: normalizeEquipmentValue(parsed, vocab, resolved),
  };
}

function imageParts(call: { request?: { input: unknown } }) {
  const input = call.request!.input as Array<{ content: Array<Record<string, unknown>> }>;
  return input.flatMap((item) => item.content).filter((part) => part.type === 'image');
}

describe('EquipmentScanHandler', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('is registered as a server-only type with a profile, one attempt, and a dashboard label', () => {
    const { registry, handler } = setup();

    expect(registry.get('ai.equipment.scan')).toBe(handler);
    expect(registry.serverOnlyTypes()).toContain('ai.equipment.scan');
    expect((handler as any).nodeResultSchema).toBeUndefined();
    expect((handler as any).persistNodeResult).toBeUndefined();
    expect(handler.profile).toEqual({ maxRuntimeMs: 10 * 60_000, maxAttempts: 1 });
    expect(JOB_TYPE_LABELS['ai.equipment.scan']).toBe('AI gym scan');
  });

  describe('the reference examples', () => {
    it.each(['cardio-row-wide', 'leg-curl-placard'] as const)('%s yields exactly the expected drafts', async (example) => {
      const t = setup({ script: answer(example) });

      await t.handler.process(t.job);

      expect(t.written).toHaveLength(1);
      expect(t.written[0].drafts.map(stored)).toEqual(loadExpectedDrafts(example, t.photoIds));
    });

    it('records the prompt version, counts and ignored objects; no draft mentions them', async () => {
      const t = setup({ script: answer('cardio-row-wide') });

      await t.handler.process(t.job);

      expect(t.written[0].resultMeta).toEqual({
        promptVersion: EQUIPMENT_SCAN_PROMPT_VERSION,
        chunks: 1,
        photoCount: 1,
        ignoredObjects: ['fire extinguisher', 'window blinds'],
        failedChunks: [],
      });
      const text = JSON.stringify(t.written[0].drafts).toLowerCase();
      expect(text).not.toContain('extinguisher');
      expect(text).not.toContain('blinds');
    });

    it('sends the photos as stored image parts only, with the schema, strict, and one usage row per call', async () => {
      const t = setup({ script: answer('both'), photos: 2 });

      await t.handler.process(t.job);

      const [call] = t.h.fake.callsTo('responses.create');
      expect(call.request!.structuredOutput).toMatchObject({ name: 'gym_equipment_scan', strict: true });
      expect(call.request!.model).toBe(HARNESS_MODEL);
      expect(imageParts(call)).toEqual(
        t.photoIds.map((storageObjectId) => ({ type: 'image', storageObjectId, detail: 'high' })),
      );
      expect(call.storageInputs!.map((input) => input.storageObjectId)).toEqual(t.photoIds);
      expect(t.h.usageEvents).toHaveLength(1);
      expect(t.written[0].drafts.map((d) => d.sourcePhotoIds)).toEqual([
        [t.photoIds[0]],
        [t.photoIds[0]],
        [t.photoIds[0]],
        [t.photoIds[0]],
        [t.photoIds[1]],
      ]);
    });
  });

  describe('location privacy (E3.5)', () => {
    it('never reads the gym and never sends a coordinate to the provider', async () => {
      const t = setup({ script: answer('both'), photos: 2 });
      // A gym with a saved position is reachable through the same Prisma; the
      // handler must not touch it, and nothing it sends may carry the position.
      const gymRow = { id: 'g', userId: HARNESS_USER, latitude: 9.93412, longitude: -84.08013 };
      const gymAccess = jest.fn(async () => gymRow);
      (t.prisma as Record<string, unknown>).gym = {
        findFirst: gymAccess,
        findUnique: gymAccess,
        findMany: jest.fn(async () => [gymRow]),
      };

      await t.handler.process(t.job);

      expect(t.written).toHaveLength(1);
      expect(gymAccess).not.toHaveBeenCalled();
      expect(((t.prisma as any).gym.findMany as jest.Mock)).not.toHaveBeenCalled();
      for (const call of t.prisma.photoIntake.findUnique.mock.calls) {
        expect(JSON.stringify(call)).not.toMatch(/gym|latitude|longitude/i);
      }

      const calls = t.h.fake.callsTo('responses.create');
      expect(calls.length).toBeGreaterThan(0);
      const sent = JSON.stringify(calls.map((call) => ({ request: call.request, storageInputs: call.storageInputs })));
      expect(sent).not.toMatch(/latitude|longitude|coordinat|gps/i);
      expect(sent).not.toContain('9.93412');
      expect(sent).not.toContain('84.08013');
      // The only content parts are the photo labels, the images and the reminder.
      const input = calls[0].request!.input as Array<{ content: Array<Record<string, unknown>> }>;
      const kinds = new Set(input.flatMap((item) => item.content).map((part) => part.type));
      expect([...kinds].sort()).toEqual(['image', 'text']);
    });
  });

  describe('chunking', () => {
    it('17 photos are two calls (16 + 1), and overlapping items merge with the max quantity', async () => {
      let calls = 0;
      const t = setup({
        photos: 17,
        script: () => {
          calls += 1;
          const output = loadModelOutput('cardio-row-wide');
          if (calls === 2) {
            output.items = [{ ...output.items[0], quantity: 4, quantityUncertain: false }];
            output.ignoredObjects = ['Fire extinguisher', 'mirror'];
          }
          return { outputText: JSON.stringify(output) };
        },
      });

      await t.handler.process(t.job);

      const responseCalls = t.h.fake.callsTo('responses.create');
      expect(responseCalls.map((call) => imageParts(call).length)).toEqual([16, 1]);
      for (const call of responseCalls) {
        const ids = imageParts(call).map((part) => part.storageObjectId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.length).toBeLessThanOrEqual(16);
      }
      expect(t.h.usageEvents).toHaveLength(2);

      const drafts = t.written[0].drafts;
      expect(drafts).toHaveLength(4);
      expect(drafts[0]).toMatchObject({
        confidence: 'medium',
        sourcePhotoIds: [t.photoIds[0], t.photoIds[16]],
        value: { equipmentTypeSlug: 'elliptical', quantity: 4, quantityUncertain: true },
      });
      expect(t.written[0].resultMeta).toMatchObject({
        chunks: 2,
        photoCount: 17,
        ignoredObjects: ['fire extinguisher', 'window blinds', 'mirror'],
      });
    });

    it('a terminal failure of a later chunk keeps the earlier drafts and records failedChunks', async () => {
      let calls = 0;
      const t = setup({
        photos: 20,
        script: () => {
          calls += 1;
          if (calls === 2) return { outputText: '{"items": [], "oops": true' };
          return { outputText: JSON.stringify(loadModelOutput('leg-curl-placard')) };
        },
      });

      await t.handler.process(t.job);

      expect(t.intakes.failIntake).not.toHaveBeenCalled();
      expect(t.written[0].drafts).toHaveLength(1);
      expect(t.written[0].resultMeta.failedChunks).toEqual([
        { index: 1, code: 'AI_STRUCTURED_OUTPUT_INVALID', firstPhotoIndex: 16, lastPhotoIndex: 19 },
      ]);
    });

    it('stops before the next chunk when the intake was discarded meanwhile', async () => {
      const t = setup({ photos: 17, script: answer('leg-curl-placard') });
      t.prisma.photoIntake.findUnique
        .mockImplementationOnce(async () => ({ ...t.intake }))
        .mockImplementationOnce(async () => null);

      await t.handler.process(t.job);

      expect(t.h.fake.callsTo('responses.create')).toHaveLength(1);
      expect(t.intakes.replaceAiDrafts).not.toHaveBeenCalled();
    });
  });

  describe('failures', () => {
    it.each([
      ['an unknown catalog slug', { items: [{ ...loadModelOutput('leg-curl-placard').items[0], catalogSlug: 'hovercraft' }], ignoredObjects: [] }],
      ['a missing key', { items: [{ ...loadModelOutput('leg-curl-placard').items[0], note: undefined }], ignoredObjects: [] }],
      ['a quantity of 0', { items: [{ ...loadModelOutput('leg-curl-placard').items[0], quantity: 0 }], ignoredObjects: [] }],
    ])('%s fails the intake with AI_STRUCTURED_OUTPUT_INVALID; the job returns; nothing is written', async (_label, output) => {
      const t = setup({ script: answer(output) });

      await expect(t.handler.process(t.job)).resolves.toBeUndefined();

      expect(t.intakes.failIntake).toHaveBeenCalledWith(INTAKE, 'AI_STRUCTURED_OUTPUT_INVALID', expect.any(String));
      expect(t.intakes.replaceAiDrafts).not.toHaveBeenCalled();
      expect(t.intake.status).toBe('failed');
    });

    it('AI switched off: zero provider calls, intake failed with AI_DISABLED, the job returns', async () => {
      const t = setup({ harness: { policy: { enabled: false } }, script: answer('leg-curl-placard') });

      await expect(t.handler.process(t.job)).resolves.toBeUndefined();

      expect(t.h.fake.calls).toEqual([]);
      expect(t.intakes.failIntake).toHaveBeenCalledWith(INTAKE, 'AI_DISABLED', expect.any(String));
      expect(t.intakes.replaceAiDrafts).not.toHaveBeenCalled();
    });

    it('a photo deleted since analyze is AI_INVALID_REQUEST, terminal', async () => {
      const t = setup({ script: answer('leg-curl-placard') });
      t.h.storage.reset();

      await expect(t.handler.process(t.job)).resolves.toBeUndefined();

      expect(t.intakes.failIntake).toHaveBeenCalledWith(INTAKE, 'AI_INVALID_REQUEST', expect.any(String));
    });

    it('rate limited: throws the deferral error and writes nothing; the re-run writes the drafts once', async () => {
      let limited = true;
      const t = setup({
        photos: 17,
        script: () => {
          if (limited) throw new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 1234 });
          return { outputText: JSON.stringify(loadModelOutput('leg-curl-placard')) };
        },
      });

      const error = await t.handler.process(t.job).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterMs).toBe(1234);
      expect(t.intakes.failIntake).not.toHaveBeenCalled();
      expect(t.intakes.replaceAiDrafts).not.toHaveBeenCalled();
      expect(t.intake.status).toBe('scanning');

      limited = false;
      await t.handler.process(t.job);

      expect(t.intakes.replaceAiDrafts).toHaveBeenCalledTimes(1);
    });

    it('an unexpected failure fails the intake with its code and THROWS', async () => {
      const t = setup({
        script: () => {
          throw new AiError('AI_PROVIDER_UNAVAILABLE', 'upstream down');
        },
      });

      await expect(t.handler.process(t.job)).rejects.toThrow();

      expect(t.intakes.failIntake).toHaveBeenCalledWith(INTAKE, 'AI_PROVIDER_UNAVAILABLE', expect.any(String));
    });

    it('is a no-op for a missing intake or one that is not scanning', async () => {
      const gone = setup({ script: answer('leg-curl-placard') });
      gone.discard();
      await gone.handler.process(gone.job);

      const ready = setup({ script: answer('leg-curl-placard'), status: 'ready' });
      await ready.handler.process(ready.job);

      for (const t of [gone, ready]) {
        expect(t.h.fake.calls).toEqual([]);
        expect(t.intakes.replaceAiDrafts).not.toHaveBeenCalled();
        expect(t.intakes.failIntake).not.toHaveBeenCalled();
      }
    });

    it('an intake discarded while the model ran drops the result (404/409 from replaceAiDrafts)', async () => {
      for (const error of [new NotFoundException(), new ConflictException()]) {
        const t = setup({ script: answer('leg-curl-placard') });
        t.intakes.replaceAiDrafts.mockRejectedValueOnce(error);

        await expect(t.handler.process(t.job)).resolves.toBeUndefined();
      }
    });

    it('rejects a malformed payload', async () => {
      const t = setup();
      await expect(t.handler.process({ ...t.job, payload: {} } as Job)).rejects.toThrow('Invalid ai.equipment.scan payload');
    });
  });

  describe('the settle safety net', () => {
    const settled = (overrides: Record<string, unknown>) =>
      new JobSettledEvent({
        id: JOB_ID,
        type: 'ai.equipment.scan',
        status: 'failed',
        subjectType: 'photo_intake',
        subjectId: INTAKE,
        ...overrides,
      } as unknown as Job);

    it('fails a still-scanning intake when its job settles failed', async () => {
      const t = setup();

      await t.handler.onJobSettled(settled({}));

      expect(t.intakes.failIntake).toHaveBeenCalledWith(
        INTAKE,
        'AI_PROVIDER_UNAVAILABLE',
        'The background job ended before the scan completed.',
      );
    });

    it('ignores a succeeded job, another type and another subject', async () => {
      const t = setup();

      await t.handler.onJobSettled(settled({ status: 'succeeded' }));
      await t.handler.onJobSettled(settled({ type: 'ai.response.run' }));
      await t.handler.onJobSettled(settled({ subjectType: 'ai_run' }));

      expect(t.intakes.failIntake).not.toHaveBeenCalled();
    });

    it('never throws from the listener', async () => {
      const t = setup();
      t.intakes.failIntake.mockRejectedValueOnce(new Error('db down'));

      await expect(t.handler.onJobSettled(settled({}))).resolves.toBeUndefined();
    });
  });
});

describe('chunkPhotos / buildScanContent', () => {
  it('chunks by 16', () => {
    expect(chunkPhotos(Array.from({ length: 33 }, (_, i) => i)).map((c) => c.length)).toEqual([16, 16, 1]);
  });

  it('numbers the photos from 0 and ends with the reminder', () => {
    const content = buildScanContent(['a', 'b']);

    expect(content.slice(0, 4)).toEqual([
      { type: 'text', text: 'Photo 0:' },
      { type: 'image', storageObjectId: 'a', detail: 'high' },
      { type: 'text', text: 'Photo 1:' },
      { type: 'image', storageObjectId: 'b', detail: 'high' },
    ]);
    expect(content[4]).toMatchObject({ type: 'text' });
  });
});
