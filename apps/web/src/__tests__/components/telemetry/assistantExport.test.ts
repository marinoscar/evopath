/** Markdown export of the telemetry assistant conversation (issue #302). */
import { describe, it, expect } from 'vitest';
import {
  assistantExportFilename,
  conversationToMarkdown,
  replyToMarkdown,
} from '../../../components/telemetry/assistantExport';
import type { AssistantMessage, AssistantReplyMessage } from '../../../hooks/useTelemetryAssistant';
import type { TelemetryAssistantReport } from '../../../services/telemetry';

const REPORT: TelemetryAssistantReport = {
  status: 'issue_found',
  summary: '42 requests failed.',
  findings: [{ title: 'Jobs failing', severity: 'high', evidence: '42 error spans.', queryIndex: 0 }],
  rootCause: 'Database timeouts.',
  confidence: 'medium',
  recommendations: ['Check the pool.', 'Add an index.'],
  queries: [{ title: 'Error spans', sql: 'SELECT 1' }],
};

function reply(overrides: Partial<AssistantReplyMessage> = {}): AssistantReplyMessage {
  return { id: 'a1', role: 'assistant', status: 'done', steps: [], answer: null, error: null, ...overrides };
}

const EXPORTED_AT = new Date('2026-10-02T12:34:56.789Z');

describe('replyToMarkdown', () => {
  it('renders a report: status, summary, findings, root cause, numbered recommendations, queries', () => {
    const md = replyToMarkdown(
      reply({ answer: { sql: 'SELECT 1', explanation: REPORT.summary, report: REPORT } }),
    );

    expect(md).toContain('Status: issue_found (confidence: medium)');
    expect(md).toContain('42 requests failed.');
    expect(md).toContain('- [high] Jobs failing');
    expect(md).toContain('Evidence: 42 error spans.');
    expect(md).toContain('Database timeouts.');
    expect(md).toContain('1. Check the pool.');
    expect(md).toContain('2. Add an index.');
    expect(md).toContain('**Error spans**');
    expect(md).toContain('```sql\nSELECT 1\n```');
  });

  it('renders a legacy answer as explanation plus SQL', () => {
    const md = replyToMarkdown(reply({ answer: { sql: 'SELECT 2', explanation: 'One row.' } }));
    expect(md).toBe('One row.\n\n```sql\nSELECT 2\n```');
  });

  it('omits the SQL block when a legacy answer has none', () => {
    expect(replyToMarkdown(reply({ answer: { sql: null, explanation: 'Nope.' } }))).toBe('Nope.');
  });

  it('renders the error code and message', () => {
    const md = replyToMarkdown(
      reply({ status: 'error', error: { code: 'ai_unavailable', message: 'Down.' } }),
    );
    expect(md).toBe('Error (ai_unavailable): Down.');
  });

  it('renders "Stopped" for a stopped reply', () => {
    expect(replyToMarkdown(reply({ status: 'stopped' }))).toBe('Stopped');
  });

  it('does not include the investigation steps', () => {
    const md = replyToMarkdown(
      reply({
        steps: [{ index: 0, tool: 'health_overview', durationMs: 5 }],
        answer: { sql: null, explanation: 'x' },
      }),
    );
    expect(md).not.toContain('health_overview');
  });
});

describe('conversationToMarkdown', () => {
  const messages: AssistantMessage[] = [
    { id: 'u1', role: 'user', text: 'Why is the API slow?' },
    reply({
      steps: [
        { index: 0, tool: 'get_app_context', durationMs: 85 },
        {
          index: 1,
          tool: 'run_query',
          input: { sql: 'SELECT count(*) FROM t', table: 't', window: '1h' },
          rowCount: 7,
          truncated: true,
          durationMs: 120,
          thought: 'Counting rows first.',
        },
        { index: 2, tool: 'get_trace', input: { traceId: 'abc123' }, durationMs: 9, error: 'not found' },
      ],
      answer: { sql: null, explanation: REPORT.summary, report: REPORT },
    }),
  ];

  it('has a header with the export time and the model caption', () => {
    const md = conversationToMarkdown(messages, {
      exportedAt: EXPORTED_AT,
      modelCaption: 'openai · gpt-5-mini',
    });
    expect(md.startsWith('# Telemetry assistant conversation\n')).toBe(true);
    expect(md).toContain('Exported at: 2026-10-02T12:34:56.789Z');
    expect(md).toContain('Model: openai · gpt-5-mini');
  });

  it('omits the model line without a caption', () => {
    const md = conversationToMarkdown(messages, { exportedAt: EXPORTED_AT, modelCaption: null });
    expect(md).not.toContain('Model:');
  });

  it('lists question, investigation steps and answer in order', () => {
    const md = conversationToMarkdown(messages, { exportedAt: EXPORTED_AT });
    const question = md.indexOf('## Question');
    const investigation = md.indexOf('## Investigation');
    const answer = md.indexOf('## Answer');
    expect(question).toBeGreaterThan(-1);
    expect(investigation).toBeGreaterThan(question);
    expect(answer).toBeGreaterThan(investigation);
    expect(md).toContain('Why is the API slow?');
  });

  it('describes each step: tool, input, rows, truncation, error, duration, thought and fenced SQL', () => {
    const md = conversationToMarkdown(messages, { exportedAt: EXPORTED_AT });
    expect(md).toContain('1. get_app_context');
    expect(md).toContain('duration: 85ms');
    expect(md).toContain('Thought: Counting rows first.');
    expect(md).toContain('2. run_query');
    expect(md).toContain('table: t');
    expect(md).toContain('window: 1h');
    expect(md).toContain('rows: 7');
    expect(md).toContain('truncated: true');
    expect(md).toContain('   ```sql\n   SELECT count(*) FROM t\n   ```');
    expect(md).toContain('traceId: abc123');
    expect(md).toContain('error: not found');
  });

  it('skips the Investigation section when there are no steps, and the Answer when still streaming', () => {
    const md = conversationToMarkdown(
      [{ id: 'u1', role: 'user', text: 'q' }, reply({ status: 'streaming' })],
      { exportedAt: EXPORTED_AT },
    );
    expect(md).not.toContain('## Investigation');
    expect(md).not.toContain('## Answer');
  });

  it('renders error and stopped turns under Answer', () => {
    const md = conversationToMarkdown(
      [
        { id: 'u1', role: 'user', text: 'q1' },
        reply({ id: 'a1', status: 'error', error: { code: null, message: 'Boom.' } }),
        { id: 'u2', role: 'user', text: 'q2' },
        reply({ id: 'a2', status: 'stopped' }),
      ],
      { exportedAt: EXPORTED_AT },
    );
    expect(md).toContain('Error: Boom.');
    expect(md).toContain('Stopped');
  });

  it('uses a fence longer than any backtick run so content cannot break out', () => {
    const sql = "SELECT '```' AS a, '`````' AS b";
    const md = conversationToMarkdown(
      [{ id: 'u1', role: 'user', text: 'q' }, reply({ answer: { sql, explanation: 'e' } })],
      { exportedAt: EXPORTED_AT },
    );
    expect(md).toContain(`\`\`\`\`\`\`sql\n${sql}\n\`\`\`\`\`\``);
  });
});

describe('assistantExportFilename', () => {
  it('stamps the ISO time with ":" and "." replaced by "-"', () => {
    expect(assistantExportFilename(EXPORTED_AT)).toBe('telemetry-assistant-2026-10-02T12-34-56-789Z.md');
  });
});
