import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// POST /api/admin/telemetry/assistant/stream — wire shapes (issue #536, epic #528)
// =============================================================================
//
// The request body is validated by the global `ZodValidationPipe`. The
// response is a `text/event-stream`; the frame payloads below are the
// binding web ↔ API contract (see the controller's OpenAPI description).
// =============================================================================

export const TELEMETRY_ASSISTANT_QUESTION_MAX = 4_000;
export const TELEMETRY_ASSISTANT_HISTORY_MAX_TURNS = 20;
export const TELEMETRY_ASSISTANT_HISTORY_CONTENT_MAX = 8_000;

export const telemetryAssistantTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(TELEMETRY_ASSISTANT_HISTORY_CONTENT_MAX),
});

export const telemetryAssistantRequestSchema = z.object({
  /** The new question, in natural language. */
  question: z.string().trim().min(1).max(TELEMETRY_ASSISTANT_QUESTION_MAX),
  /** Earlier turns of this conversation, oldest first. */
  history: z.array(telemetryAssistantTurnSchema).max(TELEMETRY_ASSISTANT_HISTORY_MAX_TURNS).optional(),
});

export class TelemetryAssistantRequestDto extends createZodDto(telemetryAssistantRequestSchema) {}
export type TelemetryAssistantRequest = z.infer<typeof telemetryAssistantRequestSchema>;
export type TelemetryAssistantTurn = z.infer<typeof telemetryAssistantTurnSchema>;

export const TELEMETRY_ASSISTANT_TOOLS = [
  'list_tables',
  'describe_table',
  'run_query',
  'get_app_context',
  'health_overview',
  'get_trace',
] as const;
export type TelemetryAssistantToolName = (typeof TELEMETRY_ASSISTANT_TOOLS)[number];

/** `event: step` — one tool call the assistant made. */
export interface TelemetryAssistantStepEvent {
  /** 0-based, across the whole turn. */
  index: number;
  tool: TelemetryAssistantToolName;
  input?: { table?: string; sql?: string; window?: string; traceId?: string };
  /** `run_query` / `get_trace` only: rows the call returned (up to the row cap). */
  rowCount?: number;
  /** `run_query` / `get_trace` only: more rows matched than the row cap allowed. */
  truncated?: boolean;
  durationMs: number;
  /** Why the call failed; the model was told the same and may retry. */
  error?: string;
  /** The model's interim reasoning for the round this call belongs to; only on the FIRST call of a round. Bounded to 1000 chars. */
  thought?: string;
}

export const TELEMETRY_ASSISTANT_REPORT_STATUSES = ['issue_found', 'no_issue_found', 'inconclusive', 'no_data'] as const;
export type TelemetryAssistantReportStatus = (typeof TELEMETRY_ASSISTANT_REPORT_STATUSES)[number];

export const TELEMETRY_ASSISTANT_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type TelemetryAssistantSeverity = (typeof TELEMETRY_ASSISTANT_SEVERITIES)[number];

export const TELEMETRY_ASSISTANT_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type TelemetryAssistantConfidence = (typeof TELEMETRY_ASSISTANT_CONFIDENCES)[number];

export interface TelemetryAssistantFinding {
  title: string;
  severity: TelemetryAssistantSeverity;
  evidence: string;
  /** Index into `report.queries` of the query that shows this finding. */
  queryIndex?: number;
}

export interface TelemetryAssistantQuery {
  title: string;
  sql: string;
}

/** The investigation's structured result. */
export interface TelemetryAssistantReport {
  status: TelemetryAssistantReportStatus;
  summary: string;
  findings: TelemetryAssistantFinding[];
  rootCause: string | null;
  confidence: TelemetryAssistantConfidence;
  recommendations: string[];
  /** Supporting queries the user can re-run (at most 5); the first is the most useful. */
  queries: TelemetryAssistantQuery[];
}

/** `event: answer` — the final answer. */
export interface TelemetryAssistantAnswerEvent {
  /** Back-compat: queries[0].sql, or null. */
  sql: string | null;
  /** Back-compat: the report summary (or the raw text when the model did not return a report). */
  explanation: string;
  report: TelemetryAssistantReport | null;
}

/** `event: error` — the turn failed after the stream opened. */
export interface TelemetryAssistantErrorEvent {
  code: string;
  message: string;
}

export interface TelemetryAssistantEventMap {
  step: TelemetryAssistantStepEvent;
  answer: TelemetryAssistantAnswerEvent;
  error: TelemetryAssistantErrorEvent;
  done: Record<string, never>;
}

export type TelemetryAssistantEventName = keyof TelemetryAssistantEventMap;

export type TelemetryAssistantEmit = <E extends TelemetryAssistantEventName>(
  event: E,
  data: TelemetryAssistantEventMap[E],
) => void;
