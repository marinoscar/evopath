// =============================================================================
// TelemetryAssistantService (issue #536, reworked as a troubleshooting agent
// in #571) — driven through the REAL AiService (createAiRuntimeHarness +
// FakeAiProvider), with the telemetry side faked.
// =============================================================================

import type { SystemTelemetryValue } from '../../common/schemas/settings.schema';
import { AiError } from '../../ai/core/ai-error';
import type { AiInputItem, AiResponseRequest } from '../../ai/core/types/responses.types';
import {
  createAiRuntimeHarness,
  HARNESS_MODEL,
  HARNESS_PROVIDER,
  HARNESS_USER,
  type AiRuntimeHarnessOptions,
} from '../../ai/testing/ai-runtime-harness';
import type { FakeAiScriptedResponse } from '../../ai/testing/fake-ai-provider';
import type { TelemetryAssistantEventMap, TelemetryAssistantEventName, TelemetryAssistantReport } from '../dto/telemetry-assistant.dto';
import type { TelemetrySchema } from '../dto/telemetry-query.dto';
import { TELEMETRY_ERROR_REASONS, TelemetryHttpError } from '../query/telemetry-query.errors';
import { LOGS_TABLE, TRACES_TABLE } from './telemetry-assistant.sql';
import {
  buildTelemetryAssistantInstructions,
  CELL_MAX_CHARS,
  guardReport,
  parseReport,
  pickDeployInfo,
  REPORT_MAX_FINDINGS,
  REPORT_MAX_QUERIES,
  REPORT_MAX_RECOMMENDATIONS,
  TELEMETRY_ASSISTANT_AUDIT_ACTION,
  TELEMETRY_ASSISTANT_INSTRUCTIONS,
  TelemetryAssistantService,
  TOOL_OUTPUT_MAX_CHARS,
  withBudget,
  parseFinalAnswer,
  shapeQueryOutput,
} from './telemetry-assistant.service';

const call = (callId: string, name: string, args: unknown): FakeAiScriptedResponse => ({
  output: [{ type: 'function_call', callId, name, arguments: JSON.stringify(args) }],
});

const answer = (sql: string | null, explanation: string): FakeAiScriptedResponse => ({
  outputText: JSON.stringify({ sql, explanation }),
});

const reportAnswer = (report: Partial<TelemetryAssistantReport>): FakeAiScriptedResponse => ({
  outputText: JSON.stringify({
    status: 'issue_found',
    summary: 'summary',
    findings: [],
    rootCause: null,
    confidence: 'medium',
    recommendations: [],
    queries: [],
    ...report,
  }),
});

/** Legacy `{ sql, explanation }` re-expressed as the minimal report `fromLegacy` builds. */
function legacyReport(sql: string | null, explanation: string): TelemetryAssistantReport {
  const trimmed = sql?.trim() ?? '';

  return {
    status: 'inconclusive',
    summary: explanation,
    findings: [],
    rootCause: null,
    confidence: 'low',
    recommendations: [],
    queries: trimmed === '' ? [] : [{ title: 'Suggested query', sql: trimmed }],
  };
}

function outputsOf(req: AiResponseRequest | undefined): Extract<AiInputItem, { type: 'function_call_output' }>[] {
  if (!req || typeof req.input === 'string') return [];
  return req.input.filter(
    (item): item is Extract<AiInputItem, { type: 'function_call_output' }> => item.type === 'function_call_output',
  );
}

const SCHEMA: TelemetrySchema = {
  tables: [
    {
      name: 'opentelemetry_logs',
      rows: 10,
      columns: [
        { name: 'timestamp', type: 'TimestampNanosecond', semanticType: 'TIMESTAMP' },
        { name: 'trace_id', type: 'String', semanticType: 'TAG' },
        { name: 'severity_text', type: 'String', semanticType: 'FIELD' },
        { name: 'severity_number', type: 'Int32', semanticType: 'FIELD' },
        { name: 'body', type: 'String', semanticType: 'FIELD' },
      ],
    },
    {
      name: 'opentelemetry_traces',
      rows: 200,
      columns: [
        { name: 'timestamp', type: 'TimestampNanosecond', semanticType: 'TIMESTAMP' },
        { name: 'duration_nano', type: 'UInt64', semanticType: 'FIELD' },
        { name: 'trace_id', type: 'String', semanticType: 'TAG' },
        { name: 'span_status_code', type: 'String', semanticType: 'FIELD' },
        { name: 'span_name', type: 'String', semanticType: 'FIELD' },
      ],
    },
  ],
};

function policyWith(assistant: Partial<SystemTelemetryValue['assistant']> = {}, enabled = true): SystemTelemetryValue {
  return {
    enabled,
    retentionDays: 30,
    instanceId: null,
    query: { maxRows: 1000, timeoutSeconds: 10 },
    assistant: {
      enabled: true,
      provider: HARNESS_PROVIDER,
      modelId: HARNESS_MODEL,
      shareResults: true,
      maxResultRowsToModel: 5,
      maxSteps: 6,
      ...assistant,
    },
  };
}

interface Setup {
  script?: FakeAiScriptedResponse[] | ((req: AiResponseRequest) => FakeAiScriptedResponse);
  policy?: SystemTelemetryValue;
  configured?: boolean;
  run?: jest.Mock;
  harness?: AiRuntimeHarnessOptions;
  systemSettings?: Partial<{
    ai: boolean;
    maintenanceMode: boolean;
    databaseBackup: boolean;
    browserNotifications: boolean;
    nodeJobSecretBroker: boolean;
  }>;
}

function setup(opts: Setup = {}) {
  const h = createAiRuntimeHarness({
    ...opts.harness,
    fake: { responses: opts.script as never, ...opts.harness?.fake },
  });
  const policy = opts.policy ?? policyWith();
  const greptime = { isConfigured: jest.fn(() => opts.configured ?? true), database: 'public' };
  const settings = { getPolicy: jest.fn(async () => policy) };
  const run =
    opts.run ??
    jest.fn(async () => ({
      columns: [{ name: 'n', type: 'int8' }],
      rows: [['1']],
      rowCount: 1,
      truncated: false,
      elapsedMs: 3,
    }));
  const schema = {
    getSchema: jest.fn(async () => SCHEMA),
    describeTable: jest.fn(async (name: string) => SCHEMA.tables.find((t) => t.name === name) ?? null),
  };
  const audits: Array<Record<string, any>> = [];
  const prisma = {
    auditEvent: {
      create: jest.fn(async (args: { data: Record<string, any> }) => {
        audits.push(args.data);
        return args.data;
      }),
    },
  };
  const featureFlags = {
    ai: true,
    maintenanceMode: false,
    databaseBackup: false,
    browserNotifications: true,
    nodeJobSecretBroker: false,
    ...opts.systemSettings,
  };
  const systemSettings = {
    getAiPolicy: jest.fn(async () => ({ enabled: featureFlags.ai })),
    getMaintenancePolicy: jest.fn(async () => ({ enabled: featureFlags.maintenanceMode })),
    getDatabaseBackupPolicy: jest.fn(async () => ({ enabled: featureFlags.databaseBackup })),
    getNotificationsPolicy: jest.fn(async () => ({ browserEnabled: featureFlags.browserNotifications })),
    getNodesPolicy: jest.fn(async () => ({ jobSecretBrokerEnabled: featureFlags.nodeJobSecretBroker })),
  };

  const service = new TelemetryAssistantService(
    h.ai,
    greptime as never,
    settings as never,
    { run } as never,
    schema as never,
    prisma as never,
    systemSettings as never,
  );

  const events: Array<{ event: TelemetryAssistantEventName; data: unknown }> = [];
  const emit = <E extends TelemetryAssistantEventName>(event: E, data: TelemetryAssistantEventMap[E]) => {
    events.push({ event, data });
  };

  const of = <E extends TelemetryAssistantEventName>(name: E) =>
    events.filter((e) => e.event === name).map((e) => e.data as TelemetryAssistantEventMap[E]);

  const requests = () => h.fake.callsTo('responses.create').map((c) => c.request);

  return { h, service, run, schema, audits, events, emit, of, requests, settings, systemSettings };
}

/** A `run` mock for `get_trace`: distinguishes the spans and logs statements by table name. */
function traceRunMock(opts: { failLogs?: boolean } = {}) {
  return jest.fn(async (_userId: string, sql: string) => {
    if (sql.includes(LOGS_TABLE)) {
      if (opts.failLogs) {
        throw new TelemetryHttpError(TELEMETRY_ERROR_REASONS.QUERY_FAILED, 'logs query failed');
      }
      return {
        columns: [{ name: 'timestamp' }, { name: 'service' }, { name: 'severity_number' }, { name: 'body' }],
        rows: [['2024-01-01T00:00:01Z', 'api', 17, 'boom']],
        rowCount: 1,
        truncated: false,
        elapsedMs: 1,
      };
    }

    if (sql.includes(TRACES_TABLE)) {
      return {
        columns: [
          { name: 'timestamp' },
          { name: 'service' },
          { name: 'span_name' },
          { name: 'is_error' },
          { name: 'duration_ms' },
          { name: 'http_status' },
        ],
        rows: [['2024-01-01T00:00:00Z', 'api', 'GET /x', false, 12.5, 200]],
        rowCount: 1,
        truncated: false,
        elapsedMs: 1,
      };
    }

    return { columns: [{ name: 'n' }], rows: [['1']], rowCount: 1, truncated: false, elapsedMs: 1 };
  });
}

describe('TelemetryAssistantService', () => {
  describe('preconditions (thrown before any event)', () => {
    it.each([
      ['store not configured', { configured: false }, TELEMETRY_ERROR_REASONS.NOT_CONFIGURED, 503],
      ['telemetry disabled', { policy: policyWith({}, false) }, TELEMETRY_ERROR_REASONS.DISABLED, 409],
      ['assistant disabled', { policy: policyWith({ enabled: false }) }, TELEMETRY_ERROR_REASONS.ASSISTANT_DISABLED, 409],
      ['no provider', { policy: policyWith({ provider: null }) }, TELEMETRY_ERROR_REASONS.ASSISTANT_NOT_CONFIGURED, 409],
      ['no model', { policy: policyWith({ modelId: null }) }, TELEMETRY_ERROR_REASONS.ASSISTANT_NOT_CONFIGURED, 409],
    ] as const)('%s', async (_name, opts, reason, status) => {
      const t = setup(opts as Setup);

      const error = await t.service
        .stream(HARNESS_USER, { question: 'how many spans?' }, { emit: t.emit })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TelemetryHttpError);
      expect((error as TelemetryHttpError).reason).toBe(reason);
      expect((error as TelemetryHttpError).getStatus()).toBe(status);
      expect(t.events).toEqual([]);
      expect(t.h.fake.callsTo('responses.create')).toHaveLength(0);
      expect(t.audits).toEqual([]);
    });
  });

  it('runs list_tables -> run_query -> final JSON, emitting steps, answer and done', async () => {
    const sql = 'SELECT count(*) AS n FROM opentelemetry_traces';
    const t = setup({
      script: [call('c1', 'list_tables', {}), call('c2', 'run_query', { sql }), answer(sql, 'Counts spans.')],
    });

    await t.service.stream(HARNESS_USER, { question: 'how many spans?' }, { emit: t.emit });

    expect(t.events.map((e) => e.event)).toEqual(['step', 'step', 'answer', 'done']);
    expect(t.of('step')[0]).toEqual({ index: 0, tool: 'list_tables', durationMs: expect.any(Number) });
    expect(t.of('step')[1]).toEqual({
      index: 1,
      tool: 'run_query',
      input: { sql },
      rowCount: 1,
      truncated: false,
      durationMs: expect.any(Number),
    });
    expect(t.of('answer')).toEqual([
      { sql, explanation: 'Counts spans.', report: legacyReport(sql, 'Counts spans.') },
    ]);
    expect(t.of('done')).toEqual([{}]);

    expect(t.run).toHaveBeenCalledWith(HARNESS_USER, sql, expect.objectContaining({ source: 'assistant', maxRows: 5 }));

    const first = t.requests()[0]!;
    expect(first.model).toBe(HARNESS_MODEL);
    expect(first.instructions).toBe(buildTelemetryAssistantInstructions(6));
    expect(first.tools?.map((tool) => (tool as { name: string }).name)).toEqual([
      'list_tables',
      'describe_table',
      'run_query',
      'get_app_context',
      'health_overview',
      'get_trace',
    ]);

    const listed = JSON.parse(outputsOf(t.requests()[1])[0].output);
    expect(listed.tables).toEqual([
      { name: 'opentelemetry_logs', rows: 10 },
      { name: 'opentelemetry_traces', rows: 200 },
    ]);
    // maxSteps is 6: the first round's tool output stands at round 1 of 6.
    expect(listed.stepsLeft).toBe(5);
    expect(listed.budget).toBeUndefined();

    const ranQuery = JSON.parse(outputsOf(t.requests()[2])[0].output);
    expect(ranQuery.stepsLeft).toBe(4);

    expect(t.audits).toEqual([
      expect.objectContaining({
        actorUserId: HARNESS_USER,
        action: TELEMETRY_ASSISTANT_AUDIT_ACTION,
        meta: expect.objectContaining({
          questionLength: 'how many spans?'.length,
          provider: HARNESS_PROVIDER,
          model: HARNESS_MODEL,
          steps: 3,
          toolCalls: 2,
          stopReason: 'completed',
        }),
      }),
    ]);
    expect(JSON.stringify(t.audits)).not.toContain('Counts spans.');
  });

  it('streams a full structured report from the model, guarded, through the answer event', async () => {
    const t = setup({
      script: [
        reportAnswer({
          status: 'issue_found',
          summary: 'Errors spiked on /api/jobs.',
          findings: [{ title: 'jobs failing', severity: 'high', evidence: '42 error spans', queryIndex: 0 }],
          rootCause: 'Database timeout',
          confidence: 'medium',
          recommendations: ['Check pool saturation.'],
          queries: [{ title: 'Error spans', sql: 'SELECT 1' }],
        }),
      ],
    });

    await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

    const [final] = t.of('answer');
    expect(final.sql).toBe('SELECT 1');
    expect(final.explanation).toBe('Errors spiked on /api/jobs.');
    expect(final.report).toEqual({
      status: 'issue_found',
      summary: 'Errors spiked on /api/jobs.',
      findings: [{ title: 'jobs failing', severity: 'high', evidence: '42 error spans', queryIndex: 0 }],
      rootCause: 'Database timeout',
      confidence: 'medium',
      recommendations: ['Check pool saturation.'],
      queries: [{ title: 'Error spans', sql: 'SELECT 1' }],
    });
  });

  it('never sends the model more rows than maxResultRowsToModel, even if the query returned more', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => [String(i)]);
    const run = jest.fn(async () => ({
      columns: [{ name: 'n', type: 'int8' }],
      rows,
      rowCount: 50,
      truncated: false,
      elapsedMs: 1,
    }));
    const t = setup({
      run,
      policy: policyWith({ maxResultRowsToModel: 3 }),
      script: [call('c1', 'run_query', { sql: 'SELECT n FROM t' }), answer('SELECT n FROM t', 'ok')],
    });

    await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

    const output = JSON.parse(outputsOf(t.requests()[1])[0].output);
    expect(output.rows).toHaveLength(3);
    expect(output.truncated).toBe(true);
    expect(run).toHaveBeenCalledWith(HARNESS_USER, 'SELECT n FROM t', expect.objectContaining({ maxRows: 3 }));
  });

  it('with shareResults off sends zero rows and says why', async () => {
    const t = setup({
      policy: policyWith({ shareResults: false }),
      script: [call('c1', 'run_query', { sql: 'SELECT 1' }), answer('SELECT 1', 'ok')],
    });

    await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

    const output = JSON.parse(outputsOf(t.requests()[1])[0].output);
    expect(output.rows).toEqual([]);
    expect(output.rowCount).toBe(1);
    expect(output.columns).toEqual([{ name: 'n', type: 'int8' }]);
    expect(output.note).toMatch(/hidden from the assistant by policy/);
    expect(t.requests()[1]!.input).not.toContain('"1"');
  });

  it('answers describe_table for an unknown table with error text listing the valid tables', async () => {
    const t = setup({
      script: [
        call('c1', 'describe_table', { table: 'nope"; DROP' }),
        call('c2', 'describe_table', { table: 'opentelemetry_traces' }),
        answer(null, 'Not answerable.'),
      ],
    });

    await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

    const missing = JSON.parse(outputsOf(t.requests()[1])[0].output);
    expect(missing.error).toBe('TABLE_NOT_FOUND');
    expect(missing.message).toContain('opentelemetry_logs, opentelemetry_traces');

    const found = JSON.parse(outputsOf(t.requests()[2])[0].output);
    expect(found.columns).toEqual([
      { name: 'timestamp', type: 'TimestampNanosecond', semanticType: 'TIMESTAMP' },
      { name: 'duration_nano', type: 'UInt64', semanticType: 'FIELD' },
      { name: 'trace_id', type: 'String', semanticType: 'TAG' },
      { name: 'span_status_code', type: 'String', semanticType: 'FIELD' },
      { name: 'span_name', type: 'String', semanticType: 'FIELD' },
    ]);

    const steps = t.of('step');
    expect(steps[0]).toMatchObject({ index: 0, tool: 'describe_table', input: { table: 'nope"; DROP' } });
    expect(steps[0].error).toContain('There is no table named');
    expect(steps[1]).toMatchObject({ index: 1, tool: 'describe_table', input: { table: 'opentelemetry_traces' } });
    expect(steps[1].error).toBeUndefined();
    expect(t.of('answer')).toEqual([{ sql: null, explanation: 'Not answerable.', report: legacyReport(null, 'Not answerable.') }]);
  });

  it('returns a rejected or failed query to the model as an error, and lets it retry', async () => {
    const run = jest
      .fn()
      .mockRejectedValueOnce(
        new TelemetryHttpError(TELEMETRY_ERROR_REASONS.QUERY_FAILED, 'No field named "duration".'),
      )
      .mockResolvedValueOnce({ columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 1 });
    const t = setup({
      run,
      script: [
        call('c1', 'run_query', { sql: 'SELECT duration FROM opentelemetry_traces' }),
        call('c2', 'run_query', { sql: 'SELECT duration_nano FROM opentelemetry_traces LIMIT 1' }),
        answer('SELECT duration_nano FROM opentelemetry_traces LIMIT 1', 'ok'),
      ],
    });

    await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

    expect(JSON.parse(outputsOf(t.requests()[1])[0].output)).toMatchObject({
      error: 'TELEMETRY_QUERY_FAILED',
      message: 'No field named "duration".',
    });
    expect(t.of('step')[0].error).toBe('No field named "duration".');
    expect(t.of('step')[1]).toMatchObject({ rowCount: 0, truncated: false });
    expect(t.of('step')[1].error).toBeUndefined();
    expect(t.of('answer')[0].sql).toBe('SELECT duration_nano FROM opentelemetry_traces LIMIT 1');
  });

  it('ends the turn on TELEMETRY_UNREACHABLE instead of handing it to the model', async () => {
    const run = jest
      .fn()
      .mockRejectedValue(new TelemetryHttpError(TELEMETRY_ERROR_REASONS.UNREACHABLE, 'The telemetry store did not answer.'));
    const t = setup({ run, script: [call('c1', 'run_query', { sql: 'SELECT 1' }), answer('SELECT 1', 'x')] });

    await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

    expect(t.events.map((e) => e.event)).toEqual(['error', 'done']);
    expect(t.of('error')).toEqual([{ code: 'TELEMETRY_UNREACHABLE', message: 'The telemetry store did not answer.' }]);
    expect(t.requests()).toHaveLength(1);
    expect(t.audits[0].meta).toMatchObject({ error: 'TELEMETRY_UNREACHABLE' });
  });

  it('withdraws a final SQL the guard refuses', async () => {
    const t = setup({ script: [answer('DROP TABLE opentelemetry_traces', 'Drops it.')] });

    await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

    const [final] = t.of('answer');
    expect(final.sql).toBeNull();
    expect(final.explanation).toMatch(/^Drops it\.\n\n1 suggested query was withdrawn/);
    expect(final.report?.queries).toEqual([]);
  });

  it('tolerates a code-fenced final answer, and falls back to plain text', async () => {
    const fenced = setup({
      script: [{ outputText: '```json\n{"sql":"SELECT 1","explanation":"One."}\n```' }],
    });
    await fenced.service.stream(HARNESS_USER, { question: 'q' }, { emit: fenced.emit });
    expect(fenced.of('answer')).toEqual([
      { sql: 'SELECT 1', explanation: 'One.', report: legacyReport('SELECT 1', 'One.') },
    ]);

    const prose = setup({ script: [{ outputText: 'I cannot help with that.' }] });
    await prose.service.stream(HARNESS_USER, { question: 'q' }, { emit: prose.emit });
    expect(prose.of('answer')).toEqual([{ sql: null, explanation: 'I cannot help with that.', report: null }]);
  });

  it('on steps_exhausted still answers, inconclusive, with the last good query and a note', async () => {
    const sql = 'SELECT count(*) AS n FROM opentelemetry_traces';
    const t = setup({
      policy: policyWith({ maxSteps: 2 }),
      script: [call('c1', 'run_query', { sql }), call('c2', 'list_tables', {})],
    });

    await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

    expect(t.events.map((e) => e.event)).toEqual(['step', 'answer', 'done']);
    const [final] = t.of('answer');
    expect(final.sql).toBe(sql);
    expect(final.explanation).toMatch(/used all 2 of its steps/);
    expect(final.report?.status).toBe('inconclusive');
    expect(final.report?.queries).toEqual([{ title: 'Last query that ran successfully', sql }]);
    expect(t.audits[0].meta).toMatchObject({ stopReason: 'steps_exhausted', steps: 2 });
  });

  it('maps an AiError to an error event, then done', async () => {
    const t = setup({ harness: { userKey: false }, script: [answer('SELECT 1', 'x')] });

    await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

    expect(t.events.map((e) => e.event)).toEqual(['error', 'done']);
    expect(t.of('error')[0].code).toBe('AI_KEY_REQUIRED');
    expect(t.of('error')[0].message).toMatch(/No API key is available for openai for your account/);
    expect(t.audits[0].meta).toMatchObject({ error: 'AI_KEY_REQUIRED' });
  });

  it('maps a rate limit with its retry hint', async () => {
    const t = setup({
      script: () => {
        throw new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 4_500 });
      },
    });

    await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

    expect(t.of('error')).toEqual([{ code: 'AI_RATE_LIMITED', message: expect.stringMatching(/about 5 seconds/) }]);
  });

  it('passes history before the new question', async () => {
    const t = setup({ script: [answer(null, 'n/a')] });

    await t.service.stream(
      HARNESS_USER,
      {
        question: 'and per service?',
        history: [
          { role: 'user', content: 'how many spans?' },
          { role: 'assistant', content: 'SELECT count(*) FROM opentelemetry_traces' },
          { role: 'assistant', content: '   ' },
        ],
      },
      { emit: t.emit },
    );

    expect(t.requests()[0]!.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'how many spans?' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'SELECT count(*) FROM opentelemetry_traces' }] },
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'and per service?' }] },
    ]);
  });

  it('a client disconnect aborts the turn without an error frame', async () => {
    const controller = new AbortController();
    const t = setup({
      script: (req) => {
        if (outputsOf(req).length === 0) return call('c1', 'run_query', { sql: 'SELECT 1' });
        return answer('SELECT 1', 'x');
      },
      run: jest.fn(async () => {
        controller.abort(new Error('Client disconnected'));
        throw new Error('The telemetry query was cancelled.');
      }),
    });

    await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit, signal: controller.signal });

    expect(t.of('error')).toEqual([]);
    expect(t.of('answer')).toEqual([]);
    expect(t.events.at(-1)?.event).toBe('done');
    expect(t.audits[0].meta).toMatchObject({ error: 'CANCELLED' });
  });

  it('passes the tool signal to the query service', async () => {
    const t = setup({ script: [call('c1', 'run_query', { sql: 'SELECT 1' }), answer('SELECT 1', 'x')] });

    await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

    expect(t.run.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);
  });

  describe('step budget carried on every tool output', () => {
    it('carries stepsLeft on ordinary rounds, and a budget warning on the second-to-last round', async () => {
      const t = setup({
        policy: policyWith({ maxSteps: 3 }),
        script: [call('c1', 'list_tables', {}), call('c2', 'list_tables', {}), answer(null, 'done')],
      });

      await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

      const first = JSON.parse(outputsOf(t.requests()[1])[0].output);
      expect(first.stepsLeft).toBe(2);
      expect(first.budget).toBeUndefined();

      const second = JSON.parse(outputsOf(t.requests()[2])[0].output);
      expect(second.budget).toMatch(/LAST STEP NEXT/);
      expect(second.stepsLeft).toBeUndefined();
    });
  });

  describe('interim thought', () => {
    it('rides on the first tool call of a round only, bounded to 1000 characters', async () => {
      const longThought = 'x'.repeat(2_000);
      const t = setup({
        script: [
          {
            outputText: longThought,
            output: [
              { type: 'function_call', callId: 'c1', name: 'list_tables', arguments: '{}' },
              {
                type: 'function_call',
                callId: 'c2',
                name: 'describe_table',
                arguments: JSON.stringify({ table: 'opentelemetry_traces' }),
              },
            ],
          },
          answer(null, 'ok'),
        ],
      });

      await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

      const steps = t.of('step');
      expect(steps[0].thought).toBe(`${'x'.repeat(999)}…`);
      expect(steps[0].thought).toHaveLength(1000);
      expect(steps[1].thought).toBeUndefined();
    });

    it('is absent when the model wrote no interim text', async () => {
      const t = setup({ script: [call('c1', 'list_tables', {}), answer(null, 'ok')] });

      await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

      expect(t.of('step')[0].thought).toBeUndefined();
    });
  });

  describe('get_app_context', () => {
    it('returns app/telemetry/deploy/features/tables/data, skipping sections without a service column', async () => {
      const t = setup({ script: [call('c1', 'get_app_context', {}), answer(null, 'ok')] });

      await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

      const output = JSON.parse(outputsOf(t.requests()[1])[0].output);

      expect(output.app).toMatchObject({ nodeVersion: process.version });
      expect(output.telemetry.assistant).toMatchObject({ shareResults: true, maxResultRowsToModel: 5, maxSteps: 6 });
      expect(output.features).toEqual({
        ai: true,
        maintenanceMode: false,
        databaseBackup: false,
        browserNotifications: true,
        nodeJobSecretBroker: false,
      });
      expect(output.tables.count).toBe(2);
      expect(output.tables.list).toEqual([
        { name: 'opentelemetry_logs', rows: 10 },
        { name: 'opentelemetry_traces', rows: 200 },
      ]);
      // Neither table carries a service column in the test schema.
      expect(output.data.traceServices).toEqual({ skipped: expect.stringContaining('service') });
      expect(output.data.logServices).toEqual({ skipped: expect.stringContaining('service') });
      // But both have a timestamp column, so range/coverage sections DO run.
      expect(output.data.tracesRange.skipped).toBeUndefined();
      expect(output.data.logsRange.skipped).toBeUndefined();
    });

    it('reports the platform features as booleans from an explicit allowlist', async () => {
      const t = setup({
        systemSettings: { ai: false, maintenanceMode: true, databaseBackup: true, browserNotifications: false, nodeJobSecretBroker: true },
        script: [call('c1', 'get_app_context', {}), answer(null, 'ok')],
      });

      await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

      const output = JSON.parse(outputsOf(t.requests()[1])[0].output);
      expect(output.features).toEqual({
        ai: false,
        maintenanceMode: true,
        databaseBackup: true,
        browserNotifications: false,
        nodeJobSecretBroker: true,
      });
    });
  });

  describe('health_overview', () => {
    it('runs the chosen window and returns every section (none skipped, given the columns)', async () => {
      const t = setup({ script: [call('c1', 'health_overview', { window: '6h' }), answer(null, 'ok')] });

      await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

      const output = JSON.parse(outputsOf(t.requests()[1])[0].output);
      expect(output.window).toBe('6h');

      for (const key of [
        'tracesCoverage',
        'tracesRange',
        'services',
        'latencyP95',
        'failingRoutes',
        'slowestSpans',
        'logsCoverage',
        'logsRange',
        'logSeverities',
        'topErrorLogs',
      ]) {
        expect(output.sections[key]).toBeDefined();
        expect(output.sections[key].skipped).toBeUndefined();
        expect(output.sections[key].unavailable).toBeUndefined();
      }
    });

    it('defaults the window to 1h when the model omits it', async () => {
      const t = setup({ script: [call('c1', 'health_overview', {}), answer(null, 'ok')] });

      await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

      expect(t.of('step')[0].input).toEqual({ window: '1h' });
    });
  });

  describe('get_trace', () => {
    it('hides non-shareable cells when shareResults is off, keeping numbers/booleans/timestamps', async () => {
      const run = traceRunMock();
      const t = setup({
        run,
        policy: policyWith({ shareResults: false }),
        script: [call('c1', 'get_trace', { traceId: 'a'.repeat(32) }), answer(null, 'ok')],
      });

      await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

      const output = JSON.parse(outputsOf(t.requests()[1])[0].output);
      expect(output.traceId).toBe('a'.repeat(32));
      // columns: timestamp, service, span_name, is_error, duration_ms, http_status
      // shareable: timestamp, is_error, duration_ms, http_status
      expect(output.spans.rows[0]).toEqual(['2024-01-01T00:00:00Z', null, null, false, 12.5, 200]);
      expect(output.spans.note).toMatch(/hidden from the assistant by policy/);
      // columns: timestamp, service, severity_number, body / shareable: timestamp, severity_number
      expect(output.logs.rows[0]).toEqual(['2024-01-01T00:00:01Z', null, 17, null]);
    });

    it('lower-cases the trace id it queries with', async () => {
      const run = traceRunMock();
      const t = setup({
        run,
        script: [call('c1', 'get_trace', { traceId: 'ABCDEF0123456789' }), answer(null, 'ok')],
      });

      await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

      const output = JSON.parse(outputsOf(t.requests()[1])[0].output);
      expect(output.traceId).toBe('abcdef0123456789');
    });

    it('a failing section is reported as unavailable, and does not lose the others', async () => {
      const run = traceRunMock({ failLogs: true });
      const t = setup({ run, script: [call('c1', 'get_trace', { traceId: 'b'.repeat(32) }), answer(null, 'ok')] });

      await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

      const output = JSON.parse(outputsOf(t.requests()[1])[0].output);
      expect(output.spans.rowCount).toBe(1);
      expect(output.spans.unavailable).toBeUndefined();
      expect(output.logs).toEqual({ unavailable: expect.stringContaining('TELEMETRY_QUERY_FAILED') });
    });

    it('a fatal telemetry failure ends the whole turn instead of one section', async () => {
      const run = jest
        .fn()
        .mockRejectedValue(new TelemetryHttpError(TELEMETRY_ERROR_REASONS.UNREACHABLE, 'store is down'));
      const t = setup({ run, script: [call('c1', 'get_trace', { traceId: 'c'.repeat(32) }), answer(null, 'ok')] });

      await t.service.stream(HARNESS_USER, { question: 'q' }, { emit: t.emit });

      expect(t.events.map((e) => e.event)).toEqual(['error', 'done']);
      expect(t.of('error')).toEqual([{ code: 'TELEMETRY_UNREACHABLE', message: 'store is down' }]);
      expect(t.requests()).toHaveLength(1);
    });
  });
});

describe('shapeQueryOutput', () => {
  const result = (rows: unknown[][]) => ({
    columns: [{ name: 'body', type: 'text' }],
    rows,
    rowCount: rows.length,
    truncated: false,
  });

  it('caps rows at 100 whatever it is asked for', () => {
    const rows = Array.from({ length: 150 }, () => ['x']);

    expect(shapeQueryOutput(result(rows), { shareResults: true, rowsToModel: 500 }).rows).toHaveLength(100);
  });

  it('cuts long cells', () => {
    const out = shapeQueryOutput(result([['a'.repeat(2_000)], [{ big: 'b'.repeat(2_000) }]]), {
      shareResults: true,
      rowsToModel: 10,
    });

    expect(out.rows[0][0]).toBe(`${'a'.repeat(CELL_MAX_CHARS)}…`);
    expect((out.rows[1][0] as string).length).toBe(CELL_MAX_CHARS + 1);
  });

  it('drops rows from the end to stay valid JSON under the size bound', () => {
    const wide = Array.from({ length: 100 }, () => Array.from({ length: 5 }, () => 'z'.repeat(500)));
    const out = shapeQueryOutput(
      { columns: Array.from({ length: 5 }, (_, i) => ({ name: `c${i}`, type: 'text' })), rows: wide, rowCount: 100, truncated: false },
      { shareResults: true, rowsToModel: 100 },
    );

    expect(JSON.stringify(out).length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_CHARS);
    expect(out.rows.length).toBeLessThan(100);
    expect(out.note).toMatch(/left out/);
  });
});

describe('withBudget', () => {
  it('adds stepsLeft before the second-to-last round', () => {
    expect(withBudget({ x: 1 }, 1, 5)).toEqual({ x: 1, stepsLeft: 4 });
    expect(withBudget({ x: 1 }, 3, 5)).toEqual({ x: 1, stepsLeft: 2 });
  });

  it('adds a budget warning instead, starting at round maxSteps - 1', () => {
    const out = withBudget({ x: 1 }, 4, 5);
    expect(out.budget).toMatch(/LAST STEP NEXT/);
    expect(out.stepsLeft).toBeUndefined();
  });
});

describe('buildTelemetryAssistantInstructions', () => {
  it('injects the given step budget', () => {
    expect(buildTelemetryAssistantInstructions(9)).toContain('at most 9 steps');
    expect(buildTelemetryAssistantInstructions(20)).toContain('at most 20 steps');
  });

  it('forbids handing the analysis back to the user', () => {
    const instructions = buildTelemetryAssistantInstructions(15);
    expect(instructions).toContain('if it returns rows');
    expect(instructions).toMatch(/You RUN the queries and ANALYSE the actual results yourself/);
  });

  it('the exported default is built at the settings default of 15', () => {
    expect(TELEMETRY_ASSISTANT_INSTRUCTIONS).toBe(buildTelemetryAssistantInstructions(15));
  });
});

describe('parseReport', () => {
  const REPORT: TelemetryAssistantReport = {
    status: 'issue_found',
    summary: 's',
    findings: [{ title: 't', severity: 'high', evidence: 'e', queryIndex: 0 }],
    rootCause: 'c',
    confidence: 'medium',
    recommendations: ['r'],
    queries: [{ title: 'q', sql: 'SELECT 1' }],
  };

  it('parses a well-formed report as-is', () => {
    expect(parseReport(JSON.stringify(REPORT))).toEqual(REPORT);
  });

  it('reads JSON embedded in prose', () => {
    expect(parseReport(`Here you go:\n${JSON.stringify(REPORT)}\nthanks`)).toEqual(REPORT);
  });

  it('maps a bad status to inconclusive', () => {
    expect(parseReport(JSON.stringify({ ...REPORT, status: 'nonsense' }))?.status).toBe('inconclusive');
  });

  it('maps an unknown severity to info', () => {
    const report = parseReport(
      JSON.stringify({ ...REPORT, findings: [{ title: 't', severity: 'catastrophic', evidence: 'e' }] }),
    );
    expect(report?.findings[0]).toMatchObject({ severity: 'info' });
  });

  it('caps findings, recommendations and queries at their maximums', () => {
    const many = (n: number, fn: (i: number) => unknown) => Array.from({ length: n }, (_, i) => fn(i));
    const report = parseReport(
      JSON.stringify({
        ...REPORT,
        findings: many(REPORT_MAX_FINDINGS + 5, (i) => ({ title: `t${i}`, severity: 'low', evidence: 'e' })),
        recommendations: many(REPORT_MAX_RECOMMENDATIONS + 5, (i) => `r${i}`),
        queries: many(REPORT_MAX_QUERIES + 5, (i) => ({ title: `q${i}`, sql: `SELECT ${i}` })),
      }),
    );

    expect(report?.findings).toHaveLength(REPORT_MAX_FINDINGS);
    expect(report?.recommendations).toHaveLength(REPORT_MAX_RECOMMENDATIONS);
    expect(report?.queries).toHaveLength(REPORT_MAX_QUERIES);
  });

  it('maps the legacy { sql, explanation } shape to a minimal report', () => {
    expect(parseReport(JSON.stringify({ sql: 'SELECT 1', explanation: 'ok' }))).toEqual(legacyReport('SELECT 1', 'ok'));
    expect(parseReport(JSON.stringify({ sql: null, explanation: 'n/a' }))).toEqual(legacyReport(null, 'n/a'));
    expect(parseReport(JSON.stringify({ sql: '   ', explanation: 'n/a' }))).toEqual(legacyReport(null, 'n/a'));
  });

  it('returns null for non-JSON or an unrelated shape', () => {
    expect(parseReport('nope, not JSON')).toBeNull();
    expect(parseReport('{"foo":"bar"}')).toBeNull();
    expect(parseReport('[1,2,3]')).toBeNull();
  });
});

describe('guardReport', () => {
  const BASE: TelemetryAssistantReport = {
    status: 'issue_found',
    summary: 'summary',
    findings: [],
    rootCause: null,
    confidence: 'low',
    recommendations: [],
    queries: [],
  };

  it('drops a non-read-only query, withdraws it with a note, and remaps queryIndex', () => {
    const report: TelemetryAssistantReport = {
      ...BASE,
      findings: [
        { title: 'f0', severity: 'high', evidence: 'e', queryIndex: 0 },
        { title: 'f1', severity: 'low', evidence: 'e', queryIndex: 1 },
      ],
      queries: [
        { title: 'bad', sql: 'DROP TABLE opentelemetry_traces' },
        { title: 'good', sql: 'SELECT 1' },
      ],
    };

    const guarded = guardReport(report);

    expect(guarded.queries).toEqual([{ title: 'good', sql: 'SELECT 1' }]);
    // f0 pointed at the withdrawn query, so it loses its queryIndex.
    expect(guarded.findings[0].queryIndex).toBeUndefined();
    // f1 pointed at the surviving query, remapped from 1 -> 0.
    expect(guarded.findings[1].queryIndex).toBe(0);
    expect(guarded.summary).toMatch(/^summary\n\n1 suggested query was withdrawn because it is not a single read-only statement/);
  });

  it('returns the report unchanged when every query passes the guard', () => {
    const report: TelemetryAssistantReport = { ...BASE, queries: [{ title: 'q', sql: 'SELECT 1' }] };

    expect(guardReport(report)).toBe(report);
  });

  it('pluralises the note for more than one withdrawn query', () => {
    const report: TelemetryAssistantReport = {
      ...BASE,
      queries: [
        { title: 'bad1', sql: 'DELETE FROM opentelemetry_traces' },
        { title: 'bad2', sql: 'DROP TABLE opentelemetry_logs' },
      ],
    };

    expect(guardReport(report).summary).toMatch(/2 suggested queries were withdrawn because they are not/);
  });
});

describe('pickDeployInfo', () => {
  it('keeps only version, commit, deployedAt, lastCommand and lastRunOutcome', () => {
    const result = pickDeployInfo({
      status: 'ok',
      document: {
        app: { version: '1.2.3', commitSha: 'abc123' },
        installedAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        lastCommand: 'deploy',
        run: { outcome: 'success' },
      } as never,
    });

    expect(result).toEqual({
      status: 'ok',
      version: '1.2.3',
      commitSha: 'abc123',
      deployedAt: '2024-01-02T00:00:00Z',
      lastCommand: 'deploy',
      lastRunOutcome: 'success',
    });
  });

  it('falls back to installedAt when updatedAt is absent, and a null run outcome', () => {
    const result = pickDeployInfo({
      status: 'ok',
      document: {
        app: { version: null, commitSha: null },
        installedAt: '2024-01-01T00:00:00Z',
        updatedAt: null,
        lastCommand: null,
        run: null,
      } as never,
    });

    expect(result.deployedAt).toBe('2024-01-01T00:00:00Z');
    expect(result.lastRunOutcome).toBeNull();
  });

  it('returns just the status when the document is absent or invalid', () => {
    expect(pickDeployInfo({ status: 'absent', document: null })).toEqual({ status: 'absent' });
    expect(pickDeployInfo({ status: 'invalid', document: null })).toEqual({ status: 'invalid' });
  });

  it('never returns hostname- or path-like fields, whatever the document carries', () => {
    const result = pickDeployInfo({
      status: 'ok',
      document: {
        app: { version: '1.0.0', commitSha: 'x' },
        installedAt: null,
        updatedAt: null,
        lastCommand: null,
        run: null,
        domain: 'example.com',
        host: { name: 'prod-1' },
        proxy: { kind: 'nginx' },
        bindPort: 3535,
        remote: { url: 'ssh://prod-1/srv/app' },
      } as never,
    });

    expect(Object.keys(result)).toEqual(['status', 'version', 'commitSha', 'deployedAt', 'lastCommand', 'lastRunOutcome']);
  });
});

describe('parseFinalAnswer', () => {
  it('reads JSON embedded in prose, and normalises an empty sql to null', () => {
    expect(parseFinalAnswer('Here you go: {"sql":"  ","explanation":"none"} thanks')).toEqual({
      sql: null,
      explanation: 'none',
      report: legacyReport(null, 'none'),
    });
  });

  it('returns null for text that is not the answer shape', () => {
    expect(parseFinalAnswer('{"query":"SELECT 1"}')).toBeNull();
    expect(parseFinalAnswer('nope')).toBeNull();
  });

  it('parses a full structured report', () => {
    const text = JSON.stringify({
      status: 'no_issue_found',
      summary: 'All quiet.',
      findings: [],
      rootCause: null,
      confidence: 'high',
      recommendations: [],
      queries: [{ title: 'Check errors', sql: 'SELECT 1' }],
    });

    expect(parseFinalAnswer(text)).toEqual({
      sql: 'SELECT 1',
      explanation: 'All quiet.',
      report: {
        status: 'no_issue_found',
        summary: 'All quiet.',
        findings: [],
        rootCause: null,
        confidence: 'high',
        recommendations: [],
        queries: [{ title: 'Check errors', sql: 'SELECT 1' }],
      },
    });
  });
});
