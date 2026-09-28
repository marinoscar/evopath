import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AI_REASONING_EFFORTS } from '../../core/capabilities';
import { aiHostedToolSchema } from '../../core/hosted-tools';

// =============================================================================
// POST /api/ai/responses, /api/ai/responses/stream, /api/ai/runs — request
// (issue #433, epic #419)
// =============================================================================
//
// The HTTP shape of the facade's `AiRequest`. Two deliberate differences:
//
//   * `structuredOutput` carries a JSON SCHEMA (`jsonSchema`), not Zod — an
//     HTTP client cannot send Zod. `json-schema-structured-output.ts` turns it
//     into the facade's Zod spec.
//   * `tools` holds HOSTED tools only (#442) — web_search, file_search,
//     code_interpreter, image_generation, mcp — validated by the core's own
//     `aiHostedToolSchema`. Function tools execute server-side code, which is
//     what the in-process `runTools` is for: a `{ "type": "function" }` entry
//     matches no variant and is a 400. The object is `.strict()`, so any other
//     unknown key (a `stream` flag, say) is a 400 too rather than silently
//     ignored.
//
// Media parts name their bytes by exactly ONE of `url` (a public http(s)
// URL) or `storageObjectId` (#441: one of the caller's own `ready` storage
// objects — uploaded through `/api/storage/objects` — which the facade
// authorises and delivers to the provider without making it public). A
// part carrying both, or neither, is a 400.
//
// ⚠ No field here can carry a key: the facade resolves the key per call.
// =============================================================================

const url = z.url({ protocol: /^https?$/ }).max(8192);

/** One of the caller's storage objects (`GET /api/storage/objects`). */
const storageObjectId = z.uuid();

const oneSource = (part: { url?: string; storageObjectId?: string }) =>
  (part.url === undefined) !== (part.storageObjectId === undefined);
const oneSourceMessage = { message: 'Give exactly one of url or storageObjectId' };

const contentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z
    .object({
      type: z.literal('image'),
      url: url.optional(),
      storageObjectId: storageObjectId.optional(),
      detail: z.enum(['low', 'high', 'auto']).optional(),
    })
    .strict()
    .refine(oneSource, oneSourceMessage),
  z
    .object({
      type: z.literal('file'),
      url: url.optional(),
      storageObjectId: storageObjectId.optional(),
      filename: z.string().max(255).optional(),
    })
    .strict()
    .refine(oneSource, oneSourceMessage),
]);

const inputItemSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('message'),
      role: z.enum(['user', 'assistant', 'system', 'developer']),
      content: z.array(contentPartSchema).min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('function_call_output'),
      callId: z.string().min(1),
      output: z.string(),
    })
    .strict(),
]);

/** Identifier a provider accepts for a schema name. */
export const AI_SCHEMA_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export const aiResponseRequestSchema = z
  .object({
    /** Provider id. Omit to use your default model's provider (or the only registered one). */
    provider: z.string().min(1).max(64).optional(),
    /** Model id. Omit to use your `ai.defaultModel` user setting. */
    model: z.string().min(1).max(200).optional(),
    /** System/developer instructions. */
    instructions: z.string().max(100_000).optional(),
    /** A prompt, or a list of typed input items. */
    input: z.union([z.string().min(1), z.array(inputItemSchema).min(1)]),
    /**
     * Provider-hosted tools (web search, file search, code interpreter, image
     * generation, remote MCP). Each type must be switched on by an
     * administrator (`403 AI_TOOL_DISABLED` otherwise — `GET /api/ai/config`
     * lists which are) and the model must support hosted tools. An MCP
     * `serverUrl` must be `https://`; its `headers` are sent to that server
     * and never stored or logged (a background run refuses them).
     */
    tools: z.array(aiHostedToolSchema).max(16).optional(),
    /** Ask for JSON matching `jsonSchema`; the response then carries a validated `parsed`. */
    structuredOutput: z
      .object({
        name: z.string().regex(AI_SCHEMA_NAME, 'Use 1-64 of [a-zA-Z0-9_-]'),
        jsonSchema: z.record(z.string(), z.unknown()),
        strict: z.boolean().optional(),
      })
      .strict()
      .optional(),
    reasoning: z
      .object({
        effort: z.enum(AI_REASONING_EFFORTS).optional(),
        summary: z.enum(['auto', 'concise', 'detailed']).optional(),
      })
      .strict()
      .optional(),
    /** Clamped to the deployment cap and the model's own limit. */
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    /** Chain onto an earlier response instead of resending history. */
    previousResponseId: z.string().min(1).max(200).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    /** Keyed by provider id — the escape hatch for provider features this contract does not model. */
    providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  })
  .strict();

export class AiResponseRequestDto extends createZodDto(aiResponseRequestSchema) {}
export type AiResponseRequestInput = z.output<typeof aiResponseRequestSchema>;
