import { Logger } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { Prisma, type Job } from '@prisma/client';

import { createMockPrismaService, type MockPrismaService } from '../../test/mocks/prisma.mock';
import type { AiFeatureModelResolver } from '../ai/assignments/ai-feature-model-resolver.service';
import { AiError } from '../ai/core/ai-error';
import type { AiService } from '../ai/runtime/ai.service';
import type { EvoPathMetricsService } from '../app-metrics/domain-metrics.service';
import { JobHandlerRegistry } from '../jobs/job-handler.registry';
import { RateLimitError } from '../jobs/rate-limit.error';
import type { PrismaService } from '../prisma/prisma.service';
import { buildHealthDigest, digestHash, type HealthDigestSource } from './health-digest';
import { HealthSummaryHandler } from './health-summary.handler';
import { HEALTH_SUMMARY_INSTRUCTIONS, healthSummaryOutputSchema, type HealthSummaryOutput } from './health-summary.prompt';
import type { HealthSummaryReader } from './health-summary.reader';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

const job = (payload: unknown = {}, subjectId: string | null = USER_ID) =>
  ({ id: JOB_ID, type: 'ai.health.summary', subjectType: 'health_summary', subjectId, payload }) as unknown as Job;

const SOURCE: HealthDigestSource = {
  profile: { dateOfBirth: '1980-01-01', sexAtBirth: 'male' },
  measurements: [
    {
      metricKey: 'ferritin',
      value: 487.123,
      measuredAt: new Date('2026-09-20T08:00:00Z'),
      localDate: null,
      flag: 'low',
      referenceLow: 500,
      referenceHigh: 900,
    },
    { metricKey: 'bp_systolic', value: 151, measuredAt: new Date('2026-09-28T08:00:00Z'), localDate: null, flag: null, referenceLow: null, referenceHigh: null },
  ],
};

const GOOD: HealthSummaryOutput = {
  narrative: 'Blood pressure has been above the usual range; keep intensity moderate. Ferritin is below range; recommend a clinician follow-up.',
  trainingConsiderations: [{ text: 'Avoid maximal efforts until blood pressure is reviewed.', severity: 'caution', conservative: true }],
  dataAsOf: '1999-01-01',
};
const BAD: HealthSummaryOutput = { ...GOOD, narrative: 'You have anemia; take 65 mg of iron daily.' };

describe('HealthSummaryHandler (H8, #192)', () => {
  let prisma: MockPrismaService;
  let respondStructured: jest.Mock;
  let forUser: jest.Mock;
  let reader: { consentOn: jest.Mock; digestSource: jest.Mock; latestReady: jest.Mock };
  let features: { resolve: jest.Mock };
  let metrics: { healthSummaryGenerated: jest.Mock };
  let registry: JobHandlerRegistry;
  let handler: HealthSummaryHandler;
  let span: { setAttribute: jest.Mock };

  const answers = (...outputs: HealthSummaryOutput[]) => {
    for (const output of outputs) {
      respondStructured.mockResolvedValueOnce({ parsed: healthSummaryOutputSchema.parse(output), usage: { inputTokens: 500, outputTokens: 120 } });
    }
  };

  beforeEach(() => {
    prisma = createMockPrismaService();
    respondStructured = jest.fn();
    forUser = jest.fn(() => ({ respondStructured }));
    reader = {
      consentOn: jest.fn(async () => true),
      digestSource: jest.fn(async () => SOURCE),
      latestReady: jest.fn(async () => null),
    };
    features = {
      resolve: jest.fn(async () => ({
        featureId: 'health_summary',
        state: 'ready',
        model: { provider: 'openai', modelId: 'gpt-text', displayName: 'GPT text', keySource: 'user' },
      })),
    };
    metrics = { healthSummaryGenerated: jest.fn() };
    registry = new JobHandlerRegistry();
    handler = new HealthSummaryHandler(
      registry,
      prisma as unknown as PrismaService,
      { forUser } as unknown as AiService,
      features as unknown as AiFeatureModelResolver,
      reader as unknown as HealthSummaryReader,
      metrics as unknown as EvoPathMetricsService,
    );
    (prisma.healthSummary.findFirst as jest.Mock).mockResolvedValue({ version: 3 });
    (prisma.healthSummary.create as jest.Mock).mockResolvedValue({});
    span = { setAttribute: jest.fn() };
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(span as never);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const created = () => (prisma.healthSummary.create as jest.Mock).mock.calls.map(([args]) => args.data);

  it('is a server-only ai.* type with a declared profile, and registers itself', () => {
    handler.onModuleInit();

    expect(handler.type).toBe('ai.health.summary');
    expect(handler.profile).toEqual({ maxRuntimeMs: 240_000, maxAttempts: 1 });
    expect('nodeResultSchema' in handler).toBe(false);
    expect('persistNodeResult' in handler).toBe(false);
    expect(registry.serverOnlyTypes()).toContain('ai.health.summary');
  });

  it('calls the feature model through AiService.forUser as the owner, with the schema and the digest in <context>', async () => {
    answers(GOOD);

    await handler.process(job());

    expect(features.resolve).toHaveBeenCalledWith(USER_ID, 'health_summary');
    expect(forUser).toHaveBeenCalledWith(USER_ID, { jobId: JOB_ID });
    const [request, opts] = respondStructured.mock.calls[0];
    expect(request).toMatchObject({
      provider: 'openai',
      model: 'gpt-text',
      schema: healthSummaryOutputSchema,
      schemaName: 'health_summary',
      strict: true,
      instructions: HEALTH_SUMMARY_INSTRUCTIONS,
    });
    const text = request.input[0].content[0].text as string;
    expect(text).toContain('<context>');
    expect(text).toContain('"ferritin"');
    expect(text).toContain('Flagged lab values that need a clinician follow-up recommendation: ferritin.');
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('appends the next version as ready, with the digest date and hash (never the model date)', async () => {
    answers(GOOD);

    await handler.process(job());

    expect(created()).toEqual([
      expect.objectContaining({
        userId: USER_ID,
        version: 4,
        status: 'ready',
        narrative: GOOD.narrative,
        trainingConsiderations: GOOD.trainingConsiderations,
        dataAsOf: new Date('2026-09-28T00:00:00.000Z'),
        inputsHash: digestHash(buildHealthDigest(SOURCE)),
        provider: 'openai',
        model: 'gpt-text',
        regenerations: 0,
        errorCode: null,
        jobId: JOB_ID,
      }),
    ]);
    expect(metrics.healthSummaryGenerated).toHaveBeenCalledWith('ready', expect.any(Number), {
      regenerations: 0,
      rejections: 0,
      inputTokens: 500,
      outputTokens: 120,
    });
    expect(span.setAttribute).toHaveBeenCalledWith('health_summary.outcome', 'ready');
  });

  it('a post-check rejection is regenerated once with a nudge naming the rules; a clean second answer is stored', async () => {
    answers(BAD, GOOD);

    await handler.process(job());

    expect(respondStructured).toHaveBeenCalledTimes(2);
    const second = respondStructured.mock.calls[1][0].input[0].content[0].text as string;
    expect(second).toContain('rejected by a safety check (dosing, diagnosis)');
    expect(second).not.toContain('anemia');
    expect(created()).toEqual([expect.objectContaining({ status: 'ready', regenerations: 1, narrative: GOOD.narrative })]);
    expect(metrics.healthSummaryGenerated).toHaveBeenCalledWith('ready', expect.any(Number), expect.objectContaining({ regenerations: 1, rejections: 1 }));
  });

  it('two rejections: no third call, a failed version with HEALTH_SUMMARY_POST_CHECK_REJECTED and no text, job does not throw', async () => {
    answers(BAD, BAD);

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(respondStructured).toHaveBeenCalledTimes(2);
    expect(created()).toEqual([
      expect.objectContaining({ status: 'failed', errorCode: 'HEALTH_SUMMARY_POST_CHECK_REJECTED', narrative: null, regenerations: 1 }),
    ]);
    expect(created()[0].trainingConsiderations).toBe(Prisma.DbNull);
    expect(metrics.healthSummaryGenerated).toHaveBeenCalledWith('rejected', expect.any(Number), expect.objectContaining({ rejections: 2 }));
  });

  it('consent off: no model call and nothing stored (turning it off stops generation)', async () => {
    reader.consentOn.mockResolvedValue(false);

    await handler.process(job());

    expect(features.resolve).not.toHaveBeenCalled();
    expect(respondStructured).not.toHaveBeenCalled();
    expect(prisma.healthSummary.create).not.toHaveBeenCalled();
    expect(metrics.healthSummaryGenerated).toHaveBeenCalledWith('skipped', expect.any(Number), undefined);
  });

  it('no health data: a no-op', async () => {
    reader.digestSource.mockResolvedValue({ profile: SOURCE.profile, measurements: [] });

    await handler.process(job());

    expect(respondStructured).not.toHaveBeenCalled();
    expect(prisma.healthSummary.create).not.toHaveBeenCalled();
  });

  it('unchanged inputs: a no-op, unless forced (Refresh summary)', async () => {
    reader.latestReady.mockResolvedValue({ version: 3, inputsHash: digestHash(buildHealthDigest(SOURCE)) });

    await handler.process(job());
    expect(respondStructured).not.toHaveBeenCalled();

    answers(GOOD);
    await handler.process(job({ force: true }));
    expect(respondStructured).toHaveBeenCalledTimes(1);
  });

  it('AI disabled (feature state): zero provider calls, a failed version with AI_DISABLED, job does not throw', async () => {
    features.resolve.mockResolvedValue({ featureId: 'health_summary', state: 'ai_disabled' });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(forUser).not.toHaveBeenCalled();
    expect(created()).toEqual([expect.objectContaining({ status: 'failed', errorCode: 'AI_DISABLED' })]);
  });

  it('a terminal AiError is recorded and the job returns; a throttle defers; anything else is recorded and rethrown', async () => {
    respondStructured.mockRejectedValueOnce(new AiError('AI_KEY_INVALID', 'bad key'));
    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(created().at(-1)).toMatchObject({ status: 'failed', errorCode: 'AI_KEY_INVALID' });

    const throttled = new AiError('AI_RATE_LIMITED', 'slow down');
    jest.spyOn(throttled, 'toRateLimitError').mockReturnValue(new RateLimitError('openai', 1000));
    respondStructured.mockRejectedValueOnce(throttled);
    await expect(handler.process(job())).rejects.toBeInstanceOf(RateLimitError);

    respondStructured.mockRejectedValueOnce(new Error('boom'));
    await expect(handler.process(job())).rejects.toThrow('boom');
    expect(created().at(-1)).toMatchObject({ status: 'failed', errorCode: 'HEALTH_SUMMARY_GENERATION_FAILED' });
  });

  it('retries a lost version race on the unique (user, version) index', async () => {
    answers(GOOD);
    const race = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
    (prisma.healthSummary.create as jest.Mock).mockRejectedValueOnce(race).mockResolvedValueOnce({});
    (prisma.healthSummary.findFirst as jest.Mock).mockResolvedValueOnce({ version: 3 }).mockResolvedValueOnce({ version: 4 });

    await handler.process(job());

    expect(created().map((d) => d.version)).toEqual([4, 5]);
  });

  it('refuses a job with no user subject', async () => {
    await expect(handler.process(job({}, null))).rejects.toThrow('expected a user subject');
  });

  it('never logs the digest, the prompt or the answer', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');
    const warn = jest.spyOn(Logger.prototype, 'warn');
    answers(BAD, GOOD);

    await handler.process(job());

    const lines = [...log.mock.calls, ...warn.mock.calls].map((call) => String(call[0])).join('\n');
    expect(lines).not.toMatch(/ferritin|487|anemia|Blood pressure|clinician/i);
  });
});
