/**
 * Plain-text (Markdown) export of the telemetry assistant conversation —
 * issue #302. Pure: no DOM, no clipboard. The conversation form is written to
 * be pasted to ANOTHER AI agent, so it carries the investigation (tool steps,
 * SQL) as well as the answer; the reply form is just the answer.
 *
 * Model and tool text is untrusted: every fenced block uses a fence longer
 * than any backtick run inside it, so content cannot close the fence early.
 */
import type {
  TelemetryAssistantAnswer,
  TelemetryAssistantReport,
  TelemetryAssistantStep,
} from '../../services/telemetry';
import type { AssistantMessage, AssistantReplyMessage } from '../../hooks/useTelemetryAssistant';

export interface ConversationExportOptions {
  exportedAt: Date;
  modelCaption?: string | null;
}

/** `telemetry-assistant-<ISO stamp, ":" and "." as "-">.md` */
export function assistantExportFilename(now: Date = new Date()): string {
  return `telemetry-assistant-${now.toISOString().replace(/[:.]/g, '-')}.md`;
}

function fenced(content: string, lang = ''): string {
  const longest = (content.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${content}\n${fence}`;
}

function reportMarkdown(report: TelemetryAssistantReport): string[] {
  const out: string[] = [`Status: ${report.status} (confidence: ${report.confidence})`, '', report.summary];
  if (report.findings.length) {
    out.push('', '### Findings');
    for (const finding of report.findings) {
      out.push('', `- [${finding.severity}] ${finding.title}`, `  Evidence: ${finding.evidence}`);
    }
  }
  if (report.rootCause) out.push('', '### Root cause', '', report.rootCause);
  if (report.recommendations.length) {
    out.push('', '### Recommendations', '');
    report.recommendations.forEach((item, i) => out.push(`${i + 1}. ${item}`));
  }
  if (report.queries.length) {
    out.push('', '### Supporting queries');
    for (const query of report.queries) out.push('', `**${query.title}**`, '', fenced(query.sql, 'sql'));
  }
  return out;
}

function answerMarkdown(answer: TelemetryAssistantAnswer): string[] {
  if (answer.report) return reportMarkdown(answer.report);
  const out = [answer.explanation];
  if (answer.sql) out.push('', fenced(answer.sql, 'sql'));
  return out;
}

/** The body of a reply's `## Answer` (answer, error or "Stopped"), or `null` when there is none. */
function replyBody(reply: AssistantReplyMessage): string[] | null {
  const out: string[] = [];
  if (reply.answer) out.push(...answerMarkdown(reply.answer));
  if (reply.error) {
    if (out.length) out.push('');
    out.push(`Error${reply.error.code ? ` (${reply.error.code})` : ''}: ${reply.error.message}`);
  }
  if (reply.status === 'stopped') {
    if (out.length) out.push('');
    out.push('Stopped');
  }
  return out.length ? out : null;
}

/** Just the answer of one reply (no steps), for the per-reply Copy. */
export function replyToMarkdown(reply: AssistantReplyMessage): string {
  return (replyBody(reply) ?? []).join('\n');
}

function stepMarkdown(step: TelemetryAssistantStep, position: number): string[] {
  const out: string[] = [];
  if (step.thought) out.push(`Thought: ${step.thought}`, '');
  out.push(`${position}. ${step.tool}`);
  const details: string[] = [];
  const input = step.input;
  if (input?.table) details.push(`table: ${input.table}`);
  if (input?.window) details.push(`window: ${input.window}`);
  if (input?.group) details.push(`group: ${input.group}`);
  if (input?.traceId) details.push(`traceId: ${input.traceId}`);
  if (step.rowCount !== undefined) details.push(`rows: ${step.rowCount}`);
  if (step.truncated) details.push('truncated: true');
  details.push(`duration: ${step.durationMs}ms`);
  if (step.error) details.push(`error: ${step.error}`);
  for (const detail of details) out.push(`   - ${detail}`);
  if (input?.sql) out.push('', fenced(input.sql, 'sql').replace(/^/gm, '   '));
  return out;
}

/** The whole conversation, written for another AI agent to read. */
export function conversationToMarkdown(
  messages: AssistantMessage[],
  { exportedAt, modelCaption }: ConversationExportOptions,
): string {
  const out: string[] = [
    '# Telemetry assistant conversation',
    '',
    `Exported at: ${exportedAt.toISOString()}`,
  ];
  if (modelCaption) out.push(`Model: ${modelCaption}`);

  for (const message of messages) {
    if (message.role === 'user') {
      out.push('', '## Question', '', message.text);
      continue;
    }
    if (message.steps.length) {
      out.push('', '## Investigation', '');
      message.steps.forEach((step, i) => {
        if (i > 0) out.push('');
        out.push(...stepMarkdown(step, i + 1));
      });
    }
    const body = replyBody(message);
    if (body) out.push('', '## Answer', '', ...body);
  }
  return `${out.join('\n')}\n`;
}
