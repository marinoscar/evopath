// =============================================================================
// JSON Schema -> structured-output spec, for HTTP callers (issue #433)
// =============================================================================
//
// The runtime facade takes a ZOD schema for structured output (so the
// provider's schema and the caller's validation are one object). An HTTP
// client cannot send Zod; it sends a JSON Schema document. This shim turns
// that document into a Zod schema with zod v4's native `z.fromJSONSchema` —
// the same conversion `ai-run-request.ts` already uses to rebuild a stored
// background run — so no JSON-Schema validator dependency (ajv) is added, and
// the three paths (in-process, HTTP, background run) validate a model's output
// with the same library.
//
// The facade then converts it BACK to JSON Schema (`toJsonSchema`) for the
// provider and validates the model's output against the Zod form
// (`parseStructured`). A schema the round trip cannot express is the caller's
// error: `AI_INVALID_REQUEST` (400), never a 500.
// =============================================================================

import { z } from 'zod';

import { AiError } from '../core/ai-error';
import type { AiStructuredOutputSpec } from '../core/types/responses.types';
import { toJsonSchema } from '../core/structured-output';

/** What an HTTP client sends as `structuredOutput`. */
export interface JsonSchemaStructuredOutput {
  name: string;
  jsonSchema: Record<string, unknown>;
  strict?: boolean;
}

/**
 * Upper bound on a submitted schema, serialised. A response schema is a few
 * hundred bytes to a few KB; this only stops a pathological document from
 * being walked at all (the request body is separately capped at 1 MB).
 */
export const AI_JSON_SCHEMA_MAX_BYTES = 64 * 1024;

/**
 * Converts an HTTP `structuredOutput` into the facade's Zod-based spec.
 *
 * @throws AiError('AI_INVALID_REQUEST') when the document is too large, is not
 *   a JSON Schema zod can read, or cannot be expressed back as JSON Schema.
 */
export function fromJsonSchemaStructuredOutput(spec: JsonSchemaStructuredOutput): AiStructuredOutputSpec {
  const size = Buffer.byteLength(JSON.stringify(spec.jsonSchema), 'utf8');

  if (size > AI_JSON_SCHEMA_MAX_BYTES) {
    throw new AiError('AI_INVALID_REQUEST', 'structuredOutput.jsonSchema is too large.', {
      details: { field: 'structuredOutput.jsonSchema', maxBytes: AI_JSON_SCHEMA_MAX_BYTES },
    });
  }

  let schema: z.ZodTypeAny;

  try {
    schema = z.fromJSONSchema(spec.jsonSchema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (err) {
    throw new AiError('AI_INVALID_REQUEST', 'structuredOutput.jsonSchema is not a valid JSON Schema.', {
      cause: err,
      details: { field: 'structuredOutput.jsonSchema', detail: detailOf(err) },
    });
  }

  // Prove the round trip now, so an unrepresentable schema is a 400 before
  // any gate or provider is consulted rather than a failure mid-pipeline.
  // (`toJsonSchema` itself throws `AI_INVALID_REQUEST`.)
  toJsonSchema(schema);

  return {
    name: spec.name,
    schema,
    ...(spec.strict !== undefined ? { strict: spec.strict } : {}),
  };
}

function detailOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}
