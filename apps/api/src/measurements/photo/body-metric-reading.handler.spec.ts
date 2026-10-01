import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import type { Job } from '@prisma/client';

import { createMockPrismaService, type MockPrismaService } from '../../../test/mocks/prisma.mock';
import { bodyMetricFixture } from '../../../test/fixtures/body-metric/load';
import { AiError } from '../../ai/core/ai-error';
import type { AiService } from '../../ai/runtime/ai.service';
import type { IntakeService } from '../../intake/intake.service';
import { JobSettledEvent } from '../../jobs/events/job-settled.event';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { RateLimitError } from '../../jobs/rate-limit.error';
import type { PrismaService } from '../../prisma/prisma.service';
import { BodyMetricReadingHandler } from './body-metric-reading.handler';
import { BODY_METRIC_INSTRUCTIONS, bodyMetricOutputSchema } from './body-metric-reading.prompt';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const INTAKE_ID = '33333333-3333-4333-8333-333333333333';
const PHOTO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PHOTO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JOB_ID = 'job-1';

const job = (payload: unknown = { intakeId: INTAKE_ID }) => ({ id: JOB_ID, payload }) as unknown as Job;

function scanningIntake(overrides: Record<string, unknown> = {}) {
  return {
    id: INTAKE_ID,
    userId: USER_ID,
    kind: 'body_metric_reading',
    status: 'scanning',
    provider: 'openai',
    modelId: 'gpt-vision',
    jobId: JOB_ID,
    photos: [{ storageObjectId: PHOTO_A }, { storageObjectId: PHOTO_B }],
    ...overrides,
  };
}

describe('BodyMetricReadingHandler (E2.6)', () => {
  let prisma: MockPrismaService;
  let respondStructured: jest.Mock;
  let forUser: jest.Mock;
  let intakes: { replaceAiDrafts: jest.Mock; failIntake: jest.Mock };
  let registry: JobHandlerRegistry;
  let handler: BodyMetricReadingHandler;

  beforeEach(() => {
    prisma = createMockPrismaService();
    respondStructured = jest.fn(async () => ({ parsed: bodyMetricOutputSchema.parse(bodyMetricFixture('scale-display')) }));
    forUser = jest.fn(() => ({ respondStructured }));
    intakes = {
      replaceAiDrafts: jest.fn(async () => ({ inserted: 1, removed: 0, invalid: [] })),
      failIntake: jest.fn(async () => true),
    };
    registry = new JobHandlerRegistry();
    handler = new BodyMetricReadingHandler(
      registry,
      prisma as unknown as PrismaService,
      { forUser } as unknown as AiService,
      intakes as unknown as IntakeService,
    );
    (prisma.photoIntake.findUnique as jest.Mock).mockResolvedValue(scanningIntake());
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('is a server-only ai.* type with a 3-minute, single-attempt profile, and registers itself', () => {
    handler.onModuleInit();

    expect(handler.type).toBe('ai.health.body_metric_reading');
    expect(handler.profile).toEqual({ maxRuntimeMs: 180_000, maxAttempts: 1 });
    expect('nodeResultSchema' in handler).toBe(false);
    expect('persistNodeResult' in handler).toBe(false);
    expect(registry.get('ai.health.body_metric_reading')).toBe(handler);
    expect(registry.serverOnlyTypes()).toContain('ai.health.body_metric_reading');
  });

  it("reads the photos as storage-object inputs with the intake's model, as the owner", async () => {
    await handler.process(job());

    expect(forUser).toHaveBeenCalledWith(USER_ID, { jobId: JOB_ID });
    const [request, opts] = respondStructured.mock.calls[0];
    expect(request).toMatchObject({
      provider: 'openai',
      model: 'gpt-vision',
      schema: bodyMetricOutputSchema,
      schemaName: 'body_metric_reading',
      strict: true,
      instructions: BODY_METRIC_INSTRUCTIONS,
    });
    expect(request.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'text', text: expect.stringContaining('2 photos') },
          { type: 'text', text: 'Photo 1:' },
          { type: 'image', storageObjectId: PHOTO_A, detail: 'high' },
          { type: 'text', text: 'Photo 2:' },
          { type: 'image', storageObjectId: PHOTO_B, detail: 'high' },
        ],
      },
    ]);
    // Never a URL or bytes: the runtime resolves storage objects itself.
    expect(JSON.stringify(request.input)).not.toMatch(/https?:|base64/);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends a PDF as a file part next to an image part (H2, #186)', async () => {
    (prisma.photoIntake.findUnique as jest.Mock).mockResolvedValue(
      scanningIntake({
        photos: [
          { storageObjectId: PHOTO_A, storageObject: { mimeType: 'image/jpeg' } },
          { storageObjectId: PHOTO_B, storageObject: { mimeType: 'application/pdf' } },
        ],
      }),
    );

    await handler.process(job());

    const [request] = respondStructured.mock.calls[0];
    expect(request.input[0].content).toEqual([
      { type: 'text', text: expect.stringContaining('2 photos and documents') },
      { type: 'text', text: 'Photo 1:' },
      { type: 'image', storageObjectId: PHOTO_A, detail: 'high' },
      { type: 'text', text: 'Photo 2 (PDF document):' },
      { type: 'file', storageObjectId: PHOTO_B },
    ]);
    expect(JSON.stringify(request.input)).not.toMatch(/https?:|base64|filename/);
    expect(intakes.replaceAiDrafts).toHaveBeenCalledTimes(1);
  });

  it('a model refusing the PDF at run time fails the intake with the PDF message, without throwing', async () => {
    (prisma.photoIntake.findUnique as jest.Mock).mockResolvedValue(
      scanningIntake({ photos: [{ storageObjectId: PHOTO_A, storageObject: { mimeType: 'application/pdf' } }] }),
    );
    respondStructured.mockRejectedValueOnce(
      new AiError('AI_CAPABILITY_UNSUPPORTED', 'Model "gpt-vision" does not accept file inputs (application/pdf).', {
        details: { capability: 'file_input' },
      }),
    );

    await handler.process(job());

    expect(intakes.failIntake).toHaveBeenCalledWith(
      INTAKE_ID,
      'AI_CAPABILITY_UNSUPPORTED',
      "Your AI model can't read PDFs; choose a model with file input or upload an image.",
    );
  });

  it('hands every mapped reading to replaceAiDrafts with diagnostics-only resultMeta', async () => {
    await handler.process(job());

    expect(intakes.replaceAiDrafts).toHaveBeenCalledWith(
      INTAKE_ID,
      [
        {
          kind: 'reading',
          value: { metricKey: 'weight', value: 208.4, unit: 'lb', method: 'scale' },
          confidence: 'high',
          uncertain: false,
          uncertaintyNote: null,
          sourcePhotoIds: [PHOTO_A],
        },
      ],
      { resultMeta: { promptVersion: 2, deviceKind: 'scale', unreadable: false, readingsFlagged: 0, readingsTruncated: 0 } },
    );
    expect(intakes.failIntake).not.toHaveBeenCalled();
  });

  it('an unreadable photo stores no items and marks resultMeta.unreadable', async () => {
    respondStructured.mockResolvedValueOnce({ parsed: bodyMetricOutputSchema.parse(bodyMetricFixture('unreadable')) });

    await handler.process(job());

    expect(intakes.replaceAiDrafts).toHaveBeenCalledWith(INTAKE_ID, [], {
      resultMeta: expect.objectContaining({ unreadable: true }),
    });
  });

  it.each([
    ['gone', null],
    ['not scanning', scanningIntake({ status: 'ready' })],
  ])('is a no-op when the intake is %s', async (_label, row) => {
    (prisma.photoIntake.findUnique as jest.Mock).mockResolvedValue(row);

    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(forUser).not.toHaveBeenCalled();
    expect(intakes.failIntake).not.toHaveBeenCalled();
  });

  it('refuses a malformed payload', async () => {
    await expect(handler.process(job({ runId: 'x' }))).rejects.toThrow('expected { intakeId }');
  });

  it('fails an intake with no model or no photo without calling AI', async () => {
    (prisma.photoIntake.findUnique as jest.Mock).mockResolvedValueOnce(scanningIntake({ modelId: null }));
    await handler.process(job());
    (prisma.photoIntake.findUnique as jest.Mock).mockResolvedValueOnce(scanningIntake({ photos: [] }));
    await handler.process(job());

    expect(forUser).not.toHaveBeenCalled();
    expect(intakes.failIntake.mock.calls.map((call) => call[1])).toEqual(['AI_INVALID_REQUEST', 'AI_INVALID_REQUEST']);
  });

  it('fails and throws for an intake of another kind (a routing bug)', async () => {
    (prisma.photoIntake.findUnique as jest.Mock).mockResolvedValueOnce(scanningIntake({ kind: 'gym_equipment' }));

    await expect(handler.process(job())).rejects.toThrow('not body_metric_reading');
    expect(forUser).not.toHaveBeenCalled();
    expect(intakes.failIntake).toHaveBeenCalledWith(INTAKE_ID, 'READ_FAILED', expect.any(String));
  });

  it.each([
    'AI_DISABLED',
    'AI_KEY_REQUIRED',
    'AI_MODEL_NOT_ENABLED',
    'AI_CAPABILITY_UNSUPPORTED',
    'AI_STRUCTURED_OUTPUT_INVALID',
    'AI_STORAGE_UNAVAILABLE',
  ] as const)('%s: fails the intake with the code and returns normally', async (code) => {
    respondStructured.mockRejectedValueOnce(new AiError(code, 'provider said something with sk-secret-key'));

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(intakes.failIntake).toHaveBeenCalledWith(INTAKE_ID, code, expect.any(String));
    // The user-safe message is ours, never the error's own text.
    expect(intakes.failIntake.mock.calls[0][2]).not.toContain('sk-secret');
    expect(intakes.replaceAiDrafts).not.toHaveBeenCalled();
  });

  it('AI_RATE_LIMITED defers the job and leaves the intake scanning', async () => {
    respondStructured.mockRejectedValueOnce(new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 5_000 }));

    await expect(handler.process(job())).rejects.toBeInstanceOf(RateLimitError);
    expect(intakes.failIntake).not.toHaveBeenCalled();
  });

  it('a non-terminal AI error fails the intake and throws', async () => {
    const error = new AiError('AI_PROVIDER_UNAVAILABLE', 'down');
    respondStructured.mockRejectedValueOnce(error);

    await expect(handler.process(job())).rejects.toBe(error);
    expect(intakes.failIntake).toHaveBeenCalledWith(INTAKE_ID, 'AI_PROVIDER_UNAVAILABLE', expect.any(String));
  });

  it('an unexpected error fails the intake with READ_FAILED and throws', async () => {
    respondStructured.mockRejectedValueOnce(new TypeError('boom'));

    await expect(handler.process(job())).rejects.toThrow('boom');
    expect(intakes.failIntake).toHaveBeenCalledWith(INTAKE_ID, 'READ_FAILED', 'Reading the photo failed.');
  });

  it.each([
    ['discarded mid-scan (404)', new NotFoundException('Photo intake not found')],
    ['no longer scanning (409)', new ConflictException({ message: 'x', details: { reason: 'NOT_SCANNING' } })],
  ])('drops the result when the intake was %s', async (_label, error) => {
    intakes.replaceAiDrafts.mockRejectedValueOnce(error);

    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(intakes.failIntake).not.toHaveBeenCalled();
  });

  it('a database failure while storing the drafts fails the intake and throws', async () => {
    intakes.replaceAiDrafts.mockRejectedValueOnce(new Error('connection lost'));

    await expect(handler.process(job())).rejects.toThrow('connection lost');
    expect(intakes.failIntake).toHaveBeenCalledWith(INTAKE_ID, 'READ_FAILED', expect.any(String));
  });

  describe('settle safety net', () => {
    const settled = (overrides: Partial<Job> = {}) =>
      new JobSettledEvent({
        id: JOB_ID,
        type: 'ai.health.body_metric_reading',
        status: 'failed',
        subjectType: 'photo_intake',
        subjectId: INTAKE_ID,
        ...overrides,
      } as Job);

    it('fails a still-scanning intake whose current job settled failed', async () => {
      (prisma.photoIntake.findUnique as jest.Mock).mockResolvedValueOnce({ status: 'scanning', jobId: JOB_ID });

      await handler.onJobSettled(settled());

      expect(intakes.failIntake).toHaveBeenCalledWith(INTAKE_ID, 'AI_PROVIDER_UNAVAILABLE', expect.any(String));
    });

    it('ignores success, other types, another job of the intake and a finished intake', async () => {
      await handler.onJobSettled(settled({ status: 'succeeded' }));
      await handler.onJobSettled(settled({ type: 'ai.response.run' }));
      (prisma.photoIntake.findUnique as jest.Mock).mockResolvedValueOnce({ status: 'scanning', jobId: 'job-2' });
      await handler.onJobSettled(settled());
      (prisma.photoIntake.findUnique as jest.Mock).mockResolvedValueOnce({ status: 'ready', jobId: JOB_ID });
      await handler.onJobSettled(settled());

      expect(intakes.failIntake).not.toHaveBeenCalled();
    });

    it('never throws out of the listener', async () => {
      (prisma.photoIntake.findUnique as jest.Mock).mockRejectedValueOnce(new Error('db down'));
      await expect(handler.onJobSettled(settled())).resolves.toBeUndefined();
    });
  });
});
