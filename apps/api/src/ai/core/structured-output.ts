// =============================================================================
// Structured output helpers (issue #424, epic #419)
// =============================================================================
//
// A caller hands the AI layer a ZOD schema; a provider wants a JSON SCHEMA,
// and hands back TEXT. These two functions are the whole round trip, and the
// only place either conversion happens, so every adapter describes and
// validates schemas identically.
//
// The repository is on zod v4, which converts natively (`z.toJSONSchema`), so
// no extra dependency is needed.
// =============================================================================

import { z } from 'zod';

import { AiError } from './ai-error';

/** A JSON Schema document, as plain data. */
export type AiJsonSchema = Record<string, unknown>;

/**
 * Converts a Zod schema to the JSON Schema a provider is sent.
 *
 * Uses zod's OUTPUT view — the shape the model must PRODUCE: every
 * non-optional key is `required` and objects are closed
 * (`additionalProperties: false`), which is what strict structured-output
 * and strict function-calling modes require. The `$schema` marker is dropped
 * because it describes the document, not the value, and some providers
 * reject unknown top-level keywords.
 *
 * A schema JSON Schema cannot express (a `Date`, a `transform`, a function) is
 * a programming error in the caller; it surfaces as
 * `AiError('AI_INVALID_REQUEST')` so it follows the same error path as every
 * other AI failure instead of escaping as a raw zod error.
 */
export function toJsonSchema(schema: z.ZodTypeAny): AiJsonSchema {
  let json: AiJsonSchema;

  try {
    json = z.toJSONSchema(schema, { unrepresentable: 'throw' }) as AiJsonSchema;
  } catch (err) {
    throw new AiError(
      'AI_INVALID_REQUEST',
      'The schema cannot be represented as JSON Schema.',
      { cause: err, details: { detail: err instanceof Error ? err.message : String(err) } },
    );
  }

  const { $schema: _ignored, ...rest } = json;

  return rest;
}

/** One validation problem, safe to return to a client (no model output echoed). */
export interface AiStructuredOutputIssue {
  path: Array<string | number>;
  code: string;
  message: string;
}

/**
 * Parses a model's text output and validates it against `schema`.
 *
 * Throws `AiError('AI_STRUCTURED_OUTPUT_INVALID')` (502 — the PROVIDER
 * returned something unusable, not the caller) with the issues in
 * `details.issues`. The raw text is deliberately NOT included: it is model
 * output derived from the user's prompt, and error bodies get logged.
 */
export function parseStructured<S extends z.ZodTypeAny>(schema: S, text: string): z.output<S> {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (err) {
    const issues: AiStructuredOutputIssue[] = [
      {
        path: [],
        code: 'invalid_json',
        message: err instanceof Error ? err.message : 'Output is not valid JSON',
      },
    ];

    throw new AiError(
      'AI_STRUCTURED_OUTPUT_INVALID',
      'The model output is not valid JSON.',
      { cause: err, details: { issues } },
    );
  }

  const result = schema.safeParse(value);

  if (!result.success) {
    const issues: AiStructuredOutputIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.map((segment) => (typeof segment === 'symbol' ? String(segment) : segment)),
      code: issue.code,
      message: issue.message,
    }));

    throw new AiError(
      'AI_STRUCTURED_OUTPUT_INVALID',
      'The model output does not match the requested schema.',
      { cause: result.error, details: { issues } },
    );
  }

  return result.data as z.output<S>;
}
