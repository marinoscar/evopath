// =============================================================================
// A background run's request, as stored in `ai_runs.request`
// (issue #432, epic #419)
// =============================================================================
//
// A queued run crosses a process boundary (the row is re-read by whichever
// worker claims the job), so its request must be plain JSON. Two members of
// `AiResponseRequest` are not:
//
//   - `structuredOutput.schema` is a Zod schema. It is stored as the JSON
//     Schema the provider would have been sent (`toJsonSchema`) and rebuilt
//     with `z.fromJSONSchema` when the run executes — so validation of the
//     run's output is exactly as strict as the provider's own contract.
//   - FUNCTION tools carry an in-process `execute`; they cannot survive the
//     hop at all and are refused by `startRun`. Hosted tools are plain data
//     and pass through — EXCEPT an MCP tool's `headers` (#442), which are
//     secret material for the remote server: a run carrying them is refused
//     too, and the stored MCP shape (`aiStoredHostedToolSchema`) has no
//     `headers` member, so the column cannot hold one.
//
// ⚠ NEVER KEY MATERIAL. The key is resolved again, at execution time, by
// the worker (docs/specs/ai-platform.md §2.2/§2.20): nothing in this shape can
// hold one, and `toStoredRunRequest` copies named fields only.
// =============================================================================

import type { Prisma } from '@prisma/client';
import { z } from 'zod';

import { AiError } from '../core/ai-error';
import { AI_REASONING_EFFORTS } from '../core/capabilities';
import { aiStoredHostedToolSchema } from '../core/hosted-tools';
import { toJsonSchema } from '../core/structured-output';
import type { AiHostedTool, AiMcpTool, AiResponseRequest } from '../core/types/responses.types';
import type { AiRequest } from './ai-runtime.types';

const contentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image'),
    url: z.string().optional(),
    storageObjectId: z.string().optional(),
    detail: z.enum(['low', 'high', 'auto']).optional(),
  }),
  z.object({
    type: z.literal('file'),
    url: z.string().optional(),
    storageObjectId: z.string().optional(),
    filename: z.string().optional(),
  }),
]);

const inputItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    role: z.enum(['user', 'assistant', 'system', 'developer']),
    content: z.array(contentPartSchema),
  }),
  z.object({ type: z.literal('function_call'), callId: z.string(), name: z.string(), arguments: z.string() }),
  z.object({ type: z.literal('function_call_output'), callId: z.string(), output: z.string() }),
]);

/** The stored shape. Validated on the way back in: a JSONB column is a trust boundary. */
export const storedAiRunRequestSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  instructions: z.string().optional(),
  input: z.union([z.string(), z.array(inputItemSchema)]),
  tools: z.array(aiStoredHostedToolSchema).optional(),
  toolChoice: z
    .union([
      z.enum(['auto', 'none', 'required']),
      z.object({ type: z.literal('function'), name: z.string() }),
    ])
    .optional(),
  structuredOutput: z
    .object({
      name: z.string(),
      jsonSchema: z.record(z.string(), z.unknown()),
      strict: z.boolean().optional(),
    })
    .optional(),
  reasoning: z
    .object({
      effort: z.enum(AI_REASONING_EFFORTS).optional(),
      summary: z.enum(['auto', 'concise', 'detailed']).optional(),
    })
    .optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  previousResponseId: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

export type StoredAiRunRequest = z.infer<typeof storedAiRunRequestSchema>;

/**
 * The JSON-safe form of an already-gated request.
 *
 * @throws AiError('AI_INVALID_REQUEST') for a function tool, or an MCP tool
 *   that carries `headers` (they would have to be stored to be re-sent).
 */
export function toStoredRunRequest(provider: string, req: AiResponseRequest): StoredAiRunRequest {
  const hosted: AiHostedTool[] = [];

  for (const tool of req.tools ?? []) {
    if (tool.type === 'function') {
      throw new AiError(
        'AI_INVALID_REQUEST',
        'Function tools cannot run in a background run; use runTools() in process.',
        { details: { tool: tool.name } },
      );
    }

    if (tool.type === 'mcp' && Object.keys(tool.headers ?? {}).length > 0) {
      throw new AiError(
        'AI_INVALID_REQUEST',
        'An MCP tool with headers cannot run in a background run: its headers would have to be stored.',
        { details: { tool: 'mcp', serverLabel: tool.serverLabel } },
      );
    }

    hosted.push(tool.type === 'mcp' ? withoutHeaders(tool) : tool);
  }

  const stored: StoredAiRunRequest = {
    provider,
    model: req.model,
    // A replayed `reasoning` item is dropped (#446): what makes it worth
    // replaying is its opaque, symbol-keyed provider state, which is
    // in-process only by design and never written to a column.
    input: typeof req.input === 'string' ? req.input : req.input.filter((item) => item.type !== 'reasoning'),
  };

  if (req.instructions !== undefined) stored.instructions = req.instructions;
  if (hosted.length > 0) stored.tools = hosted;
  if (req.toolChoice !== undefined) stored.toolChoice = req.toolChoice;
  if (req.structuredOutput) {
    stored.structuredOutput = {
      name: req.structuredOutput.name,
      jsonSchema: toJsonSchema(req.structuredOutput.schema),
      ...(req.structuredOutput.strict !== undefined ? { strict: req.structuredOutput.strict } : {}),
    };
  }
  if (req.reasoning !== undefined) stored.reasoning = req.reasoning;
  if (req.maxOutputTokens !== undefined) stored.maxOutputTokens = req.maxOutputTokens;
  if (req.temperature !== undefined) stored.temperature = req.temperature;
  if (req.previousResponseId !== undefined) stored.previousResponseId = req.previousResponseId;
  if (req.metadata !== undefined) stored.metadata = req.metadata;
  if (req.providerOptions !== undefined) stored.providerOptions = req.providerOptions;

  // One more parse: what goes into the column is exactly what comes back out.
  return storedAiRunRequestSchema.parse(stored);
}

/** An MCP tool minus `headers` — named fields only, so nothing else rides along either. */
function withoutHeaders(tool: AiMcpTool): AiMcpTool {
  const { headers: _headers, ...rest } = tool;

  return rest;
}

/** The stored request as a runtime request again (Zod schema rebuilt). */
export function fromStoredRunRequest(value: unknown): AiRequest {
  const parsed = storedAiRunRequestSchema.safeParse(value);

  if (!parsed.success) {
    throw new AiError('AI_INVALID_REQUEST', 'The stored background run request is invalid.');
  }

  const { structuredOutput, tools, ...rest } = parsed.data;
  const request: AiRequest = { ...rest };

  if (tools) request.tools = tools;

  if (structuredOutput) {
    let schema: z.ZodTypeAny;

    try {
      schema = z.fromJSONSchema(structuredOutput.jsonSchema as Parameters<typeof z.fromJSONSchema>[0]);
    } catch (err) {
      throw new AiError('AI_INVALID_REQUEST', 'The stored structured-output schema is invalid.', {
        cause: err,
      });
    }

    request.structuredOutput = {
      name: structuredOutput.name,
      schema,
      ...(structuredOutput.strict !== undefined ? { strict: structuredOutput.strict } : {}),
    };
  }

  return request;
}

/** For Prisma's `Json` column. */
export function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
