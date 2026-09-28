// =============================================================================
// The function-calling agent loop (issue #432, epic #419)
// =============================================================================
//
// `AiUserClient.runTools()` is this function bound to the facade's gated
// `respond`, so every round-trip passes every gate and records its own usage
// row. The loop:
//
//   1. call the model with the tools;
//   2. no `function_call` in the output -> done (`completed`);
//   3. otherwise, for each call: validate the arguments with the tool's own
//      Zod schema, run it (per-tool timeout, the caller's signal), and turn
//      the outcome into a `function_call_output` string. NOTHING THROWS
//      HERE: invalid arguments, an unknown tool, a tool that throws or times
//      out are all fed back to the model as text, so it can correct itself;
//   4. send the outputs back so the provider sees the calls it made, one of
//      two ways, decided per round by the provider that answered (#446):
//        - CHAINED (the default): only the new `function_call_output`s, with
//          `previousResponseId` naming the response that asked for them —
//          the provider already holds everything before it;
//        - FULL HISTORY, for a provider declaring
//          `supportsPreviousResponseId: false` (Anthropic, which stores
//          nothing): the original input, then every round's model output
//          replayed as input (`message` as an assistant message,
//          `function_call` and `reasoning` as themselves — the latter with
//          its opaque provider state, see `AI_PROVIDER_STATE`), then its
//          tool outputs. Hosted-tool items are not replayed: the provider ran
//          them, and a stateless provider has none of ours to run;
//   5. stop after `maxSteps` round-trips (`steps_exhausted`), leaving the
//      last round's calls unexecuted: there is no round-trip left to hand
//      their results to.
//
// Tool arguments are UNTRUSTED model output. `execute` only ever sees values
// its schema accepted, plus the `userId` it must scope every access to.
// =============================================================================

import { AiError } from '../core/ai-error';
import type { AiDefinedTool } from '../core/tools';
import { asInputItems, replayOutput } from '../core/conversation';
import type { AiInputItem, AiOutputItem, AiResponse } from '../core/types/responses.types';
import {
  AI_TOOL_DEFAULT_TIMEOUT_MS,
  AI_TOOL_LOOP_DEFAULT_MAX_STEPS,
  AI_TOOL_LOOP_MAX_STEPS,
  type AiCallOptions,
  type AiRequest,
  type AiToolCallRecord,
  type AiToolLoopRequest,
  type AiToolLoopResult,
  type AiToolStep,
} from './ai-runtime.types';

/** One gated provider round-trip — `AiUserClient.respond`. */
export type AiRespondFn = (req: AiRequest, opts: AiCallOptions) => Promise<AiResponse>;

export interface AiToolLoopContext {
  userId: string;
  signal?: AbortSignal;
  /**
   * Whether the provider that produced a response can be chained onto with
   * `previousResponseId` — `AiProviderRegistry.supportsPreviousResponseId`.
   * Absent: every provider chains (the pre-#446 behaviour).
   */
  supportsPreviousResponseId?: (provider: string) => boolean;
}

type FunctionCall = Extract<AiOutputItem, { type: 'function_call' }>;

/** A tool's result is fed back as this much text at most. */
export const AI_TOOL_OUTPUT_MAX_CHARS = 32_000;

export async function runToolLoop(
  respond: AiRespondFn,
  req: AiToolLoopRequest,
  ctx: AiToolLoopContext,
): Promise<AiToolLoopResult> {
  const { tools, maxSteps: requestedSteps, toolTimeoutMs, onStep, ...base } = req;
  const maxSteps = requestedSteps ?? AI_TOOL_LOOP_DEFAULT_MAX_STEPS;
  const timeoutMs = toolTimeoutMs ?? AI_TOOL_DEFAULT_TIMEOUT_MS;

  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > AI_TOOL_LOOP_MAX_STEPS) {
    throw new AiError(
      'AI_INVALID_REQUEST',
      `maxSteps must be an integer between 1 and ${AI_TOOL_LOOP_MAX_STEPS}.`,
      { details: { maxSteps } },
    );
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AiError('AI_INVALID_REQUEST', 'toolTimeoutMs must be a positive number.', {
      details: { toolTimeoutMs },
    });
  }

  if (tools.length === 0) {
    throw new AiError('AI_INVALID_REQUEST', 'runTools needs at least one tool.');
  }

  const byName = new Map<string, AiDefinedTool>();

  for (const tool of tools) {
    if (byName.has(tool.tool.name)) {
      throw new AiError('AI_INVALID_REQUEST', `Duplicate tool name "${tool.tool.name}".`, {
        details: { tool: tool.tool.name },
      });
    }

    byName.set(tool.tool.name, tool);
  }

  const steps: AiToolStep[] = [];
  const chains = ctx.supportsPreviousResponseId ?? (() => true);
  let next: AiRequest = { ...base, tools: tools.map((tool) => tool.tool) };
  // Everything said so far, as input — only sent for a provider that cannot chain.
  let history: AiInputItem[] = asInputItems(base.input);

  for (let step = 1; ; step += 1) {
    const response = await respond(next, { signal: ctx.signal });
    const calls = response.output.filter((item): item is FunctionCall => item.type === 'function_call');

    if (calls.length === 0) {
      emit(steps, { step, response, calls: [] }, onStep);

      return { final: response, steps, stopReason: 'completed' };
    }

    if (step >= maxSteps) {
      emit(steps, { step, response, calls: [] }, onStep);

      return { final: response, steps, stopReason: 'steps_exhausted' };
    }

    const records: AiToolCallRecord[] = [];

    // Sequential on purpose: a tool may depend on an earlier one's side
    // effect, and a model that asked for N calls gets them in its order.
    for (const call of calls) {
      records.push(await executeCall(byName, call, ctx, timeoutMs));
    }

    emit(steps, { step, response, calls: records }, onStep);

    const outputs: AiInputItem[] = records.map((record) => ({
      type: 'function_call_output',
      callId: record.callId,
      output: record.output,
    }));

    if (chains(response.provider)) {
      next = { ...next, input: outputs, previousResponseId: response.id };
    } else {
      history = [...history, ...replayOutput(response.output), ...outputs];

      const { previousResponseId: _chained, ...rest } = next;

      next = { ...rest, input: history };
    }
  }
}

function emit(steps: AiToolStep[], step: AiToolStep, onStep?: (step: AiToolStep) => void): void {
  steps.push(step);
  onStep?.(step);
}

async function executeCall(
  byName: Map<string, AiDefinedTool>,
  call: FunctionCall,
  ctx: AiToolLoopContext,
  timeoutMs: number,
): Promise<AiToolCallRecord> {
  const started = Date.now();
  const base = { callId: call.callId, name: call.name, arguments: call.arguments };
  const tool = byName.get(call.name);

  if (!tool) {
    return {
      ...base,
      status: 'unknown_tool',
      output: `Error: there is no tool named "${call.name}".`,
      durationMs: Date.now() - started,
    };
  }

  const parsed = tool.parseArguments(call.arguments);

  if (!parsed.success) {
    return {
      ...base,
      status: 'invalid_arguments',
      output: `Error: ${parsed.error}`,
      durationMs: Date.now() - started,
    };
  }

  if (ctx.signal?.aborted) {
    throw new AiError('AI_PROVIDER_UNAVAILABLE', 'The AI request was cancelled.', {
      details: { aborted: true },
    });
  }

  // Each tool gets its own controller: aborted by the timeout, and by the
  // caller's signal, so a slow tool stops with the request that wanted it.
  const controller = new AbortController();
  const onAbort = () => controller.abort(ctx.signal?.reason);
  ctx.signal?.addEventListener('abort', onAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ToolTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      tool.execute(parsed.data, { userId: ctx.userId, signal: controller.signal }),
      timeout,
    ]);

    return { ...base, status: 'ok', output: serialise(result), durationMs: Date.now() - started };
  } catch (err) {
    if (ctx.signal?.aborted) {
      throw new AiError('AI_PROVIDER_UNAVAILABLE', 'The AI request was cancelled.', {
        cause: err,
        details: { aborted: true },
      });
    }

    const timedOut = err instanceof ToolTimeoutError;
    const message = err instanceof Error ? err.message : String(err);

    return {
      ...base,
      status: timedOut ? 'timeout' : 'error',
      output: timedOut
        ? `Error: tool "${call.name}" timed out after ${timeoutMs} ms.`
        : `Error: tool "${call.name}" failed: ${message}`,
      error: message,
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onAbort);
  }
}

class ToolTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Tool timed out after ${timeoutMs} ms`);
    this.name = 'ToolTimeoutError';
  }
}

/** A tool result as the text a `function_call_output` carries. */
function serialise(result: unknown): string {
  let text: string;

  if (typeof result === 'string') {
    text = result;
  } else if (result === undefined) {
    text = 'null';
  } else {
    try {
      text = JSON.stringify(result) ?? 'null';
    } catch {
      text = String(result);
    }
  }

  return text.length > AI_TOOL_OUTPUT_MAX_CHARS
    ? `${text.slice(0, AI_TOOL_OUTPUT_MAX_CHARS)}… (truncated)`
    : text;
}
