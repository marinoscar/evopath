/**
 * Preset JSON Schemas for the playground's structured-output demo — issue
 * #434, epic #419.
 *
 * Written for STRICT structured outputs (the request sends `strict: true`):
 * every property is listed in `required`, optional values are nullable
 * instead of omitted, and `additionalProperties` is `false` — the subset of
 * JSON Schema providers accept in strict mode.
 */
export interface AiSchemaPreset {
  id: string;
  label: string;
  /** `structuredOutput.name` — a provider-safe identifier. */
  name: string;
  /** A prompt that exercises the schema, offered as a starting point. */
  examplePrompt: string;
  jsonSchema: Record<string, unknown>;
}

export const AI_SCHEMA_PRESETS: AiSchemaPreset[] = [
  {
    id: 'extract_contact',
    label: 'Extract contact',
    name: 'contact',
    examplePrompt:
      'Extract the contact: "Hi, I\'m Dana Ruiz from Acme Corp — reach me at dana@acme.test or +1 555 0100."',
    jsonSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full name' },
        email: { type: ['string', 'null'] },
        phone: { type: ['string', 'null'] },
        company: { type: ['string', 'null'] },
      },
      required: ['name', 'email', 'phone', 'company'],
      additionalProperties: false,
    },
  },
  {
    id: 'classify_sentiment',
    label: 'Classify sentiment',
    name: 'sentiment',
    examplePrompt: 'Classify the sentiment: "The update fixed my problem, but it took forever to install."',
    jsonSchema: {
      type: 'object',
      properties: {
        sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative', 'mixed'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        rationale: { type: 'string' },
      },
      required: ['sentiment', 'confidence', 'rationale'],
      additionalProperties: false,
    },
  },
];

/** The preset id the schema editor uses for a hand-written schema. */
export const CUSTOM_SCHEMA_ID = 'custom';
export const CUSTOM_SCHEMA_NAME = 'custom_output';

export function formatSchema(schema: unknown): string {
  return JSON.stringify(schema, null, 2);
}

/**
 * Validate the schema editor's text: it must be JSON and a JSON object.
 * Returns the parsed schema, or an error message.
 */
export function parseJsonSchemaText(
  text: string,
): { ok: true; schema: Record<string, unknown> } | { ok: false; error: string } {
  if (text.trim() === '') return { ok: false, error: 'Enter a JSON Schema' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err instanceof Error ? err.message : 'parse error'}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'The schema must be a JSON object' };
  }
  return { ok: true, schema: value as Record<string, unknown> };
}
