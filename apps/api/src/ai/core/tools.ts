// =============================================================================
// Function tool helper (issue #424, epic #419)
// =============================================================================
//
// `defineTool()` binds a function tool's description (what the provider is
// told) to its implementation (what runs when the model calls it) and to ONE
// Zod schema used for both the provider-facing JSON Schema and the validation
// of the model's arguments. The #432 agent loop consumes the result.
//
// Arguments from a model are untrusted input — they are validated before
// `execute` ever sees them, and a validation failure is returned as a string
// the loop can feed back to the model rather than thrown.
// =============================================================================

import type { z } from 'zod';

import { toJsonSchema } from './structured-output';
import type { AiFunctionTool, AiTool } from './types/responses.types';

/** Names providers accept for a function tool (the strictest common subset). */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** What a tool's `execute` is called with besides its arguments. */
export interface AiToolExecutionContext {
  /** The user on whose behalf the model is acting — scope every data access to it. */
  userId: string;
  signal?: AbortSignal;
  requestId?: string;
}

export interface AiToolDefinition<P extends z.ZodTypeAny, R> {
  name: string;
  description: string;
  parameters: P;
  /** Ask the provider to enforce the schema exactly. Defaults to true. */
  strict?: boolean;
  execute(args: z.output<P>, ctx: AiToolExecutionContext): Promise<R> | R;
}

export type AiToolArgumentsResult<P extends z.ZodTypeAny> =
  | { success: true; data: z.output<P> }
  | { success: false; error: string };

export interface AiDefinedTool<P extends z.ZodTypeAny = z.ZodTypeAny, R = unknown> {
  /** Goes into `AiResponseRequest.tools`. */
  tool: AiFunctionTool<P>;
  /** Runs the implementation. Always async, whatever the definition returned. */
  execute(args: z.output<P>, ctx: AiToolExecutionContext): Promise<R>;
  /**
   * Parses and validates a model's raw `arguments` string. Never throws: a
   * failure is a message suitable for a `function_call_output`.
   */
  parseArguments(raw: string): AiToolArgumentsResult<P>;
}

/**
 * Defines a function tool.
 *
 * Throws (a plain `TypeError` — this is a programming error, found at
 * definition time rather than on the first model call) when the name is not
 * provider-safe or `parameters` does not describe a JSON object.
 */
export function defineTool<P extends z.ZodTypeAny, R>(
  def: AiToolDefinition<P, R>,
): AiDefinedTool<P, R> {
  if (!TOOL_NAME.test(def.name)) {
    throw new TypeError(
      `Invalid AI tool name "${def.name}": use 1-64 characters from [a-zA-Z0-9_-].`,
    );
  }

  const jsonSchema = toJsonSchema(def.parameters);

  if (jsonSchema.type !== 'object') {
    throw new TypeError(`AI tool "${def.name}" parameters must be an object schema.`);
  }

  const tool: AiFunctionTool<P> = {
    type: 'function',
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    strict: def.strict ?? true,
  };

  return {
    tool,
    execute: async (args, ctx) => def.execute(args, ctx),
    parseArguments: (raw) => {
      let value: unknown;

      try {
        // Some providers send an empty string for a no-argument call.
        value = JSON.parse(raw.trim() === '' ? '{}' : raw);
      } catch {
        return { success: false, error: `Arguments for "${def.name}" are not valid JSON.` };
      }

      const result = def.parameters.safeParse(value);

      if (!result.success) {
        const problems = result.error.issues
          .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
          .join('; ');

        return { success: false, error: `Invalid arguments for "${def.name}": ${problems}` };
      }

      return { success: true, data: result.data as z.output<P> };
    },
  };
}

/** Narrows a request tool to a function tool (as opposed to a hosted one). */
export function isFunctionTool(tool: AiTool): tool is AiFunctionTool {
  return tool.type === 'function';
}
