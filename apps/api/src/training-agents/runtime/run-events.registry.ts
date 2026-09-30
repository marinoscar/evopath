import { z } from 'zod';

import { TRAINING_AGENT_ROLES } from '../../common/schemas/settings.schema';

// =============================================================================
// Training run events: the vocabulary and the payload schema of each type
// =============================================================================
//
// Every event a run appends to `training_run_events` has a TYPE registered
// here with a Zod schema for its `data`. `RunEventsService.append` refuses a
// type nobody registered and data its schema rejects. Every schema is
// `.strict()`, so a field nobody declared (a prompt, a model's words, a note
// the user typed) cannot ride along.
//
// THE RULE FOR EVERY SCHEMA: identifiers, enums, counts, durations and codes.
// Never prompt text, instructions, model output, provider messages, free text
// the user typed, or key material. Events are replayed to the browser.
//
// OWNERSHIP. This file registers the lifecycle events the runtime kit emits.
// A story that emits its own type (`research.brief`, `critic.round`,
// `adaptation.applied`, ...) calls `registerRunEventType` from its own module
// file, at import time, next to the node that emits it:
//
//   registerRunEventType('critic.round', z.object({ round: z.number().int(), approve: z.boolean() }).strict());
//
// and adds the type name to `RunEventType` below if it wants the compiler to
// check `ctx.emit('critic.round', ...)` call sites.
// =============================================================================

/** The lifecycle types this runtime emits. */
export const LIFECYCLE_EVENT_TYPES = [
  'run.queued',
  'run.started',
  'run.resumed',
  'stage.started',
  'stage.completed',
  'agent.usage',
  'run.deferred',
  'run.interrupted',
  'run.awaiting_approval',
  'run.completed',
  'run.failed',
  'run.cancelled',
] as const;

export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

/**
 * The event types the epic's vocabulary names, emitted by the agent stories.
 * Listed so `ctx.emit` call sites type-check before those stories register
 * their schemas; an emit of a type with no registered schema is dropped.
 */
export const AGENT_EVENT_TYPES = [
  'agent.call',
  'research.query',
  'research.source',
  'research.brief',
  'plan.draft',
  'guardrail.report',
  'critic.round',
  'plan.finalized',
  'adaptation.proposed',
  'adaptation.applied',
  'evaluation.signals',
  'evaluation.safety',
] as const;

export type RunEventType = LifecycleEventType | (typeof AGENT_EVENT_TYPES)[number];

/** Statuses a run can end a job in (the `end` frame's and `run.completed`'s vocabulary). */
const STATUS = z.enum([
  'queued',
  'running',
  'awaiting_approval',
  'interrupted',
  'succeeded',
  'failed',
  'cancelled',
  'blocked_safety',
]);

const NODE = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const CODE = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const COUNT = z.number().int().min(0);

const tokenTotals = z
  .object({
    calls: COUNT,
    inputTokens: COUNT,
    outputTokens: COUNT,
    reasoningTokens: COUNT,
  })
  .strict();

const LIFECYCLE_SCHEMAS: Record<LifecycleEventType, z.ZodType> = {
  'run.queued': z.object({ kind: z.enum(['create', 'revise', 'evaluate']), trigger: z.string().max(32) }).strict(),
  'run.started': z.object({ kind: z.enum(['create', 'revise', 'evaluate']) }).strict(),
  'run.resumed': z
    .object({ resumeCount: COUNT, decision: z.enum(['approve', 'reject']).optional() })
    .strict(),
  'stage.started': z.object({ node: NODE, round: COUNT.optional() }).strict(),
  'stage.completed': z.object({ node: NODE, round: COUNT.optional(), durationMs: COUNT }).strict(),
  'agent.usage': z
    .object({
      role: z.enum(TRAINING_AGENT_ROLES),
      node: NODE,
      provider: z.string().max(64),
      model: z.string().max(200),
      round: COUNT.optional(),
      step: COUNT.optional(),
      inputTokens: COUNT,
      outputTokens: COUNT,
      reasoningTokens: COUNT,
      latencyMs: COUNT,
    })
    .strict(),
  'run.deferred': z.object({ retryAfterMs: COUNT.nullable() }).strict(),
  'run.interrupted': z.object({ reason: z.enum(['deadline', 'shutdown', 'lost']) }).strict(),
  'run.awaiting_approval': z.object({ kind: z.string().max(64), expiresAt: z.string().datetime() }).strict(),
  'run.completed': z.object({ status: STATUS, tokens: tokenTotals }).strict(),
  'run.failed': z.object({ code: CODE }).strict(),
  'run.cancelled': z.object({}).strict(),
};

const registry = new Map<string, z.ZodType>(Object.entries(LIFECYCLE_SCHEMAS));

/**
 * Registers the payload schema of an event type. Call it once, at module load,
 * from the story that emits the type. Re-registering a type with a different
 * schema is a programming error and throws.
 */
export function registerRunEventType(type: string, schema: z.ZodType): void {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(type)) {
    throw new Error(`Run event type "${type}" must be dotted lower case (e.g. "critic.round")`);
  }

  const existing = registry.get(type);
  if (existing && existing !== schema) {
    throw new Error(`Run event type "${type}" is already registered`);
  }

  registry.set(type, schema);
}

/** The schema of `type`, or `undefined` when no story registered it. */
export function runEventSchema(type: string): z.ZodType | undefined {
  return registry.get(type);
}

/** Every registered type (lifecycle ones included). */
export function registeredRunEventTypes(): string[] {
  return [...registry.keys()];
}

export class RunEventDataInvalidError extends Error {
  constructor(
    readonly type: string,
    reason: string,
  ) {
    super(`Run event "${type}" refused: ${reason}`);
    this.name = 'RunEventDataInvalidError';
  }
}

/**
 * Validates `data` against `type`'s schema and returns the parsed value.
 * The error names the type and the failing paths, never the values.
 */
export function parseRunEventData(type: string, data: unknown): Record<string, unknown> {
  const schema = registry.get(type);

  if (!schema) {
    throw new RunEventDataInvalidError(type, 'no schema is registered for this type');
  }

  const parsed = schema.safeParse(data ?? {});

  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw new RunEventDataInvalidError(type, `invalid data at ${[...new Set(paths)].join(', ')}`);
  }

  return parsed.data as Record<string, unknown>;
}

/** Run statuses after which the stream ends (the job has nothing more to say). */
export const STREAM_END_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'blocked_safety',
  'awaiting_approval',
]);
