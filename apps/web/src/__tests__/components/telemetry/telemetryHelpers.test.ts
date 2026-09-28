import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  STARTER_QUERIES,
  quoteIdentifier,
  sqlStringLiteral,
  traceQuery,
} from '../../../components/telemetry/starterQueries';
import {
  QUERY_HISTORY_KEY,
  QUERY_HISTORY_LIMIT,
  pushQueryHistory,
  readQueryHistory,
} from '../../../components/telemetry/queryHistory';
import {
  ASSISTANT_HISTORY_TURNS,
  buildAssistantHistory,
  type AssistantMessage,
} from '../../../hooks/useTelemetryAssistant';
import { toSqlNamespace } from '../../../components/telemetry/SqlEditor';
import { formatCellValue } from '../../../components/telemetry/ResultsGrid';
import {
  filenameFromContentDisposition,
  telemetryErrorReason,
  telemetryExportFilename,
} from '../../../services/telemetry';
import { ApiError } from '../../../services/api';
import { toTelemetryError } from '../../../hooks/useTelemetryExplorer';
import { validateInteger } from '../../../pages/Admin/TelemetrySettingsPage';

/** Pure helpers behind the Telemetry Explorer and settings page (issue #537). */

describe('starter queries', () => {
  it('declares the six starter queries against the OpenTelemetry tables', () => {
    expect(STARTER_QUERIES.map((query) => query.title)).toEqual([
      'Recent errors (24h)',
      'Slowest routes (p95, 1h)',
      'Requests per service (24h)',
      'Recent warnings and errors in logs',
      'Full trace by ID',
      'Tables and sizes',
    ]);
  });

  it('quotes identifiers only when they are not plain lower-case names', () => {
    expect(quoteIdentifier('span_name')).toBe('span_name');
    expect(quoteIdentifier('span_attributes.http.route')).toBe('"span_attributes.http.route"');
    expect(quoteIdentifier('Weird"Name')).toBe('"Weird""Name"');
  });

  it('escapes string literals and builds a spans + logs trace query', () => {
    expect(sqlStringLiteral("a'b")).toBe("'a''b'");
    const sql = traceQuery("abc'1");
    expect(sql).toContain("FROM opentelemetry_traces WHERE trace_id = 'abc''1'");
    expect(sql).toContain("FROM opentelemetry_logs WHERE trace_id = 'abc''1'");
    expect(sql).toContain('UNION ALL');
  });
});

describe('query history', () => {
  beforeEach(() => window.localStorage.clear());

  it('keeps the last 20 distinct queries, newest first', () => {
    for (let i = 0; i < QUERY_HISTORY_LIMIT + 5; i += 1) pushQueryHistory(`SELECT ${i}`);
    pushQueryHistory('SELECT 10');
    const history = readQueryHistory();
    expect(history).toHaveLength(QUERY_HISTORY_LIMIT);
    expect(history[0]).toBe('SELECT 10');
    expect(history.filter((entry) => entry === 'SELECT 10')).toHaveLength(1);
  });

  it('reads a corrupt value as empty', () => {
    window.localStorage.setItem(QUERY_HISTORY_KEY, '{not json');
    expect(readQueryHistory()).toEqual([]);
  });

  it('survives storage that throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readQueryHistory()).toEqual([]);
    spy.mockRestore();
  });
});

describe('buildAssistantHistory', () => {
  const answered = (i: number): AssistantMessage[] => [
    { id: `u${i}`, role: 'user', text: `q${i}` },
    {
      id: `a${i}`,
      role: 'assistant',
      status: 'done',
      steps: [],
      answer: { sql: i % 2 ? `SELECT ${i}` : null, explanation: `e${i}` },
      error: null,
    },
  ];

  it('replays answered turns and drops failed ones', () => {
    const failed: AssistantMessage[] = [
      { id: 'u-x', role: 'user', text: 'bad' },
      { id: 'a-x', role: 'assistant', status: 'error', steps: [], answer: null, error: { code: null, message: 'x' } },
    ];
    expect(buildAssistantHistory([...answered(1), ...failed, ...answered(2)])).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'e1\n\nSQL:\nSELECT 1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'e2' },
    ]);
  });

  it('keeps only the last 10 turns (20 messages, the API maximum)', () => {
    const messages = Array.from({ length: 15 }, (_, i) => answered(i)).flat();
    const history = buildAssistantHistory(messages);
    expect(history).toHaveLength(ASSISTANT_HISTORY_TURNS * 2);
    expect(history[0]).toEqual({ role: 'user', content: 'q5' });
  });
});

describe('misc helpers', () => {
  it('maps the schema to a completion namespace', () => {
    expect(
      toSqlNamespace([{ name: 't', columns: [{ name: 'c', type: 'String' }] }]),
    ).toEqual({ t: [{ label: 'c', type: 'property', detail: 'String' }] });
  });

  it('formats cell values', () => {
    expect(formatCellValue(null)).toBe('NULL');
    expect(formatCellValue({ a: 1 })).toBe('{"a":1}');
    expect(formatCellValue(12)).toBe('12');
  });

  it('names exports telemetry-<timestamp>.<ext>', () => {
    expect(telemetryExportFilename('xlsx', new Date('2026-01-02T03:04:05.678Z'))).toBe(
      'telemetry-2026-01-02T03-04-05-678Z.xlsx',
    );
  });

  it('validates integer inputs against their range', () => {
    expect(validateInteger('10', { min: 1, max: 12 })).toBeNull();
    expect(validateInteger('13', { min: 1, max: 12 })).toBe('Must be from 1 to 12.');
    expect(validateInteger('1.5', { min: 1, max: 12 })).toMatch(/whole number/);
    expect(validateInteger('', { min: 1, max: 12 })).toMatch(/whole number/);
  });

  it('reads the filename from Content-Disposition', () => {
    expect(filenameFromContentDisposition('attachment; filename=telemetry-1.csv')).toBe('telemetry-1.csv');
    expect(filenameFromContentDisposition('attachment; filename="a b.xlsx"')).toBe('a b.xlsx');
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''t%C3%A9l.csv")).toBe('tél.csv');
    expect(filenameFromContentDisposition('attachment; filename="../../x.csv"')).toBe('.._.._x.csv');
    expect(filenameFromContentDisposition(null)).toBeNull();
  });

  it('reads the telemetry reason from details, not the status-derived code', () => {
    const err = new ApiError('boom', 400, 'BAD_REQUEST', {
      reason: 'TELEMETRY_QUERY_FAILED',
      sqlState: '42703',
    });
    expect(telemetryErrorReason(err)).toBe('TELEMETRY_QUERY_FAILED');
    expect(toTelemetryError(err, 'x')).toMatchObject({
      code: 'BAD_REQUEST',
      reason: 'TELEMETRY_QUERY_FAILED',
      sqlState: '42703',
      timeoutMs: null,
    });
    expect(telemetryErrorReason(new Error('x'))).toBeNull();
  });
});
