import { ConflictException, Logger } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import type { Job } from '@prisma/client';

import { createMockPrismaService, type MockPrismaService } from '../../../test/mocks/prisma.mock';
import { labReportFixture } from '../../../test/fixtures/lab-report/load';
import { AiError } from '../../ai/core/ai-error';
import type { AiService } from '../../ai/runtime/ai.service';
import { PDF_INPUT_UNSUPPORTED_MESSAGE } from '../../intake/intake-inputs';
import type { IntakeService } from '../../intake/intake.service';
import { JobSettledEvent } from '../../jobs/events/job-settled.event';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { RateLimitError } from '../../jobs/rate-limit.error';
import type { PrismaService } from '../../prisma/prisma.service';
import { LAB_REPORT_SPAN_ATTRIBUTES, LabReportHandler } from './lab-report.handler';
import { LAB_REPORT_INSTRUCTIONS, labReportOutputSchema, labReportUserText } from './lab-report.prompt';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const INTAKE_ID = '33333333-3333-4333-8333-333333333333';
const PDF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAGE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JOB_ID = 'job-1';

const job = (payload: unknown = { intakeId: INTAKE_ID }) => ({ id: JOB_ID, payload }) as unknown as Job;

function scanningIntake(overrides: Record<string, unknown> = {}) {
  return {
    id: INTAKE_ID,
    userId: USER_ID,
    kind: 'lab_report',
    status: 'scanning',
    provider: 'openai',
    modelId: 'gpt-vision',
    jobId: JOB_ID,
    context: null,
    photos: [{ storageObjectId: PDF, storageObject: { mimeType: 'application/pdf' } }],
    ...overrides,
  };
}

describe('LabReportHandler (H4, #188)', () => {
  let prisma: MockPrismaService;
  let respondStructured: jest.Mock;
  let forUser: jest.Mock;
  let intakes: { replaceAiDrafts: jest.Mock; failIntake: jest.Mock };
  let registry: JobHandlerRegistry;
  let handler: LabReportHandler;
  let span: { setAttribute: jest.Mock };

  beforeEach(() => {
    prisma = createMockPrismaService();
    respondStructured = jest.fn(async () => ({ parsed: labReportOutputSchema.parse(labReportFixture('lipid-glucose-panel')) }));
    forUser = jest.fn(() => ({ respondStructured }));
    intakes = {
      replaceAiDrafts: jest.fn(async () => ({ inserted: 7, removed: 0, invalid: [] })),
      failIntake: jest.fn(async () => true),
    };
    registry = new JobHandlerRegistry();
    handler = new LabReportHandler(
      registry,
      prisma as unknown as PrismaService,
      { forUser } as unknown as AiService,
      intakes as unknown as IntakeService,
    );
    (prisma.photoIntake.findUnique as jest.Mock).mockResolvedValue(scanningIntake());
    span = { setAttribute: jest.fn() };
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(span as never);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('is a server-only ai.* type with a 10-minute, single-attempt profile, and registers itself', () => {
    handler.onModuleInit();

    expect(handler.type).toBe('ai.health.lab_report');
    expect(handler.profile).toEqual({ maxRuntimeMs: 600_000, maxAttempts: 1 });
    expect('nodeResultSchema' in handler).toBe(false);
    expect('persistNodeResult' in handler).toBe(false);
    expect(registry.get('ai.health.lab_report')).toBe(handler);
    expect(registry.serverOnlyTypes()).toContain('ai.health.lab_report');
  });

  it('sends the PDF as a file part through AiService.forUser with the lab report schema, as the owner', async () => {
    await handler.process(job());

    expect(forUser).toHaveBeenCalledWith(USER_ID, { jobId: JOB_ID });
    const [request, opts] = respondStructured.mock.calls[0];
    expect(request).toMatchObject({
      provider: 'openai',
      model: 'gpt-vision',
      schema: labReportOutputSchema,
      schemaName: 'lab_report',
      strict: true,
      instructions: LAB_REPORT_INSTRUCTIONS,
      maxOutputTokens: 32_000,
    });
    expect(request.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'text', text: labReportUserText(1, true) },
          { type: 'text', text: 'Photo 1 (PDF document):' },
          { type: 'file', storageObjectId: PDF },
        ],
      },
    ]);
    expect(JSON.stringify(request.input)).not.toMatch(/https?:|base64/);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('stores every result as a draft, the unmatched one included, and fills the context', async () => {
    await handler.process(job());

    const [intakeId, drafts, options] = intakes.replaceAiDrafts.mock.calls[0];
    expect(intakeId).toBe(INTAKE_ID);
    expect(drafts).toHaveLength(7);
    expect(drafts.filter((d: any) => d.value.analyteKey === null)).toHaveLength(1);
    expect(options.context).toEqual({ collectionDate: '2026-09-15', labName: 'Acme Clinical Laboratories' });
    expect(options.resultMeta).toMatchObject({ promptVersion: 3, unmatched: 1, converted: 1 });

    expect(span.setAttribute).toHaveBeenCalledWith('intake.input_kind', 'pdf');
    expect(span.setAttribute).toHaveBeenCalledWith(LAB_REPORT_SPAN_ATTRIBUTES.inputCount, 1);
    expect(span.setAttribute).toHaveBeenCalledWith(LAB_REPORT_SPAN_ATTRIBUTES.draftCount, 7);
    expect(span.setAttribute).toHaveBeenCalledWith(LAB_REPORT_SPAN_ATTRIBUTES.unmatchedCount, 1);
    expect(intakes.failIntake).not.toHaveBeenCalled();
  });

  it('keeps a context field the model could not read, and sends page photos as images', async () => {
    (prisma.photoIntake.findUnique as jest.Mock).mockResolvedValue(
      scanningIntake({
        context: { collectionDate: '2026-09-01', labName: 'Typed by the user' },
        photos: [
          { storageObjectId: PAGE, storageObject: { mimeType: 'image/jpeg' } },
          { storageObjectId: PDF, storageObject: { mimeType: 'image/png' } },
        ],
      }),
    );
    respondStructured.mockResolvedValue({
      // No date anywhere (neither the report's nor a result's): the user's date stays.
      parsed: labReportOutputSchema.parse({
        ...labReportFixture('lipid-glucose-panel'),
        collectionDate: null,
        labName: 'Read lab',
        results: labReportFixture('lipid-glucose-panel').results.map((r: object) => ({ ...r, collectionDate: null })),
      }),
    });

    await handler.process(job());

    expect(intakes.replaceAiDrafts.mock.calls[0][2].context).toEqual({ collectionDate: '2026-09-01', labName: 'Read lab' });
    const content = respondStructured.mock.calls[0][0].input[0].content;
    expect(content[0].text).toBe(labReportUserText(2, false));
    expect(content.filter((part: any) => part.type === 'image')).toHaveLength(2);
  });

  it('is a no-op for a gone or settled intake, and fails an intake of another kind', async () => {
    (prisma.photoIntake.findUnique as jest.Mock).mockResolvedValueOnce(null);
    await handler.process(job());
    (prisma.photoIntake.findUnique as jest.Mock).mockResolvedValueOnce(scanningIntake({ status: 'ready' }));
    await handler.process(job());
    expect(respondStructured).not.toHaveBeenCalled();

    (prisma.photoIntake.findUnique as jest.Mock).mockResolvedValueOnce(scanningIntake({ kind: 'body_metric_reading' }));
    await expect(handler.process(job())).rejects.toThrow(/not lab_report/);
    expect(intakes.failIntake).toHaveBeenCalledWith(INTAKE_ID, 'READ_FAILED', 'Reading the lab report failed.');
  });

  it('refuses a malformed payload', async () => {
    await expect(handler.process(job({ nope: 1 }))).rejects.toThrow(/Invalid ai.health.lab_report payload/);
  });

  it('fails the intake without throwing on a terminal AI code, with the PDF message for file_input', async () => {
    respondStructured.mockRejectedValue(
      new AiError('AI_CAPABILITY_UNSUPPORTED', 'no files', { details: { capability: 'file_input' } }),
    );

    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(intakes.failIntake).toHaveBeenCalledWith(INTAKE_ID, 'AI_CAPABILITY_UNSUPPORTED', PDF_INPUT_UNSUPPORTED_MESSAGE);
    expect(intakes.replaceAiDrafts).not.toHaveBeenCalled();
  });

  it('warns on AI_INVALID_REQUEST with the whitelisted provider details only (#301)', async () => {
    const cause = new Error('Invalid file https://files.example/secret?sig=abc for key sk-live-123');
    respondStructured.mockRejectedValueOnce(
      new AiError('AI_INVALID_REQUEST', 'The AI provider rejected the request.', {
        cause,
        details: {
          provider: 'openai',
          status: 400,
          providerCode: 'invalid_value',
          providerType: 'invalid_request_error',
          param: 'file',
          providerRequestId: 'req_123',
          url: 'https://files.example/secret',
        },
      }),
    );

    await expect(handler.process(job())).resolves.toBeUndefined();

    const warn = Logger.prototype.warn as jest.Mock;
    const line = String(warn.mock.calls.find(([msg]) => String(msg).includes('Lab report intake'))?.[0]);

    expect(line).toContain(`Lab report intake ${INTAKE_ID} ended with AI_INVALID_REQUEST`);
    expect(line).toContain(
      'status=400 providerCode="invalid_value" providerType="invalid_request_error" param="file" providerRequestId="req_123"',
    );
    expect(line).not.toMatch(/https?:|sk-live|sig=|rejected the request/);
    expect(Logger.prototype.log).not.toHaveBeenCalledWith(expect.stringContaining('ended with'));
  });

  it('defers on a rate limit, leaving the intake scanning', async () => {
    respondStructured.mockRejectedValue(new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 1000 }));

    await expect(handler.process(job())).rejects.toBeInstanceOf(RateLimitError);
    expect(intakes.failIntake).not.toHaveBeenCalled();
  });

  it('fails and rethrows an unexpected error', async () => {
    respondStructured.mockRejectedValue(new Error('boom'));

    await expect(handler.process(job())).rejects.toThrow('boom');
    expect(intakes.failIntake).toHaveBeenCalledWith(INTAKE_ID, 'READ_FAILED', 'Reading the lab report failed.');
  });

  it('discards the result quietly when the intake changed while it was read', async () => {
    intakes.replaceAiDrafts.mockRejectedValue(new ConflictException('not scanning'));

    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(intakes.failIntake).not.toHaveBeenCalled();
  });

  it('fails a still-scanning intake when its own job settles failed', async () => {
    (prisma.photoIntake.findUnique as jest.Mock).mockResolvedValue({ status: 'scanning', jobId: JOB_ID });

    await handler.onJobSettled({
      type: 'ai.health.lab_report',
      succeeded: false,
      subjectType: 'photo_intake',
      subjectId: INTAKE_ID,
      jobId: JOB_ID,
    } as JobSettledEvent);
    expect(intakes.failIntake).toHaveBeenCalledWith(INTAKE_ID, 'AI_PROVIDER_UNAVAILABLE', expect.any(String));

    intakes.failIntake.mockClear();
    await handler.onJobSettled({
      type: 'ai.health.lab_report',
      succeeded: false,
      subjectType: 'photo_intake',
      subjectId: INTAKE_ID,
      jobId: 'another-job',
    } as JobSettledEvent);
    expect(intakes.failIntake).not.toHaveBeenCalled();
  });
});
