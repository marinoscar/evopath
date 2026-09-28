// =============================================================================
// Our Responses types <-> OpenAI Chat Completions (issue #448, epic #421)
// =============================================================================
//
// The graceful-degradation path of the OpenAI wire family. Most
// OpenAI-compatible servers (Ollama, vLLM, LM Studio) and every Azure OpenAI
// api-version serve `POST /chat/completions`, while only some serve the
// Responses API. Pure functions, no I/O — `toChatCompletionsRequest` builds
// the body, `fromChatCompletion` reads the answer, and the stream mapper
// (`openai-chat-completions-stream.mapper.ts`) ends by building a synthetic
// `ChatCompletion` and handing it to `fromChatCompletion`, so a streamed and
// a non-streamed call cannot disagree about what a response means.
//
// MAPPING
//   instructions               -> a leading `system` message
//   message user/system/developer -> `user` / `system` (developer is sent as
//                                  system: compatible servers rarely know it)
//   message assistant          -> `assistant` (text only)
//   function_call (replayed)   -> `tool_calls` on the preceding assistant turn
//   function_call_output       -> a `tool` message
//   reasoning (replayed)       -> dropped: Chat Completions has nowhere to put it
//   image part                 -> `image_url` (URL, presigned URL or data: URL)
//   file part                  -> `file` with `file_data` (inline data: URL) or
//                                 `file_id`; a remote file URL is refused
//   function tools             -> `tools[].function` (JSON Schema from Zod)
//   structuredOutput           -> `response_format: { type: 'json_schema' }`,
//                                 then `parseStructured` on the text
//   maxOutputTokens            -> `max_tokens` or `max_completion_tokens`, as
//                                 the adapter declares (`tokenParameter`)
//
// REFUSED (AI_CAPABILITY_UNSUPPORTED):
//   - a reasoning EFFORT: Chat Completions has no reasoning summaries, and the
//     compatible servers this path exists for have no effort knob (a summary
//     request alone is a harmless no-op, as for a non-reasoning OpenAI model);
//   - `previousResponseId`: the API is stateless — send the history instead;
//   - any hosted tool (#442): Chat Completions runs function tools only;
//   - a remote file URL: only inline bytes or an uploaded file id are accepted.
//
// `metadata` is not forwarded: OpenAI only accepts it on stored completions,
// and compatible servers reject unknown fields inconsistently.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsBase,
  ChatCompletionFunctionTool,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions/completions';

import { AiError } from '../../core/ai-error';
import { parseStructured, toJsonSchema } from '../../core/structured-output';
import type {
  AiContentPart,
  AiFinishReason,
  AiInputItem,
  AiOutputItem,
  AiResponse,
  AiResponseRequest,
  AiTool,
  AiToolChoice,
  AiUsage,
} from '../../core/types/responses.types';
import { OPENAI_FAMILY, type OpenAiFamily } from './openai-errors';
import type { OpenAiStorageDeliveries } from './openai-responses.mapper';

/** The request body minus `stream`/`stream_options`, which the engine sets. */
export type ChatCompletionsRequestBody = Omit<ChatCompletionCreateParamsBase, 'stream' | 'stream_options'>;

/**
 * Which body field carries the output-token limit. `max_completion_tokens` is
 * OpenAI's (and Azure's) current name and the only one reasoning models
 * accept; `max_tokens` is the one every OpenAI-compatible server understands.
 */
export type ChatCompletionsTokenParameter = 'max_tokens' | 'max_completion_tokens';

export interface ToChatCompletionsOptions {
  family?: OpenAiFamily;
  storage?: OpenAiStorageDeliveries;
  tokenParameter?: ChatCompletionsTokenParameter;
}

function unsupported(family: OpenAiFamily, message: string, details: Record<string, unknown>): AiError {
  return new AiError('AI_CAPABILITY_UNSUPPORTED', message, { details: { provider: family.providerId, ...details } });
}

function invalid(family: OpenAiFamily, message: string, details: Record<string, unknown> = {}): AiError {
  return new AiError('AI_INVALID_REQUEST', message, { details: { provider: family.providerId, ...details } });
}

// ---- request ----------------------------------------------------------------

function toImagePart(url: string, detail: 'low' | 'high' | 'auto' | undefined): ChatCompletionContentPart {
  return { type: 'image_url', image_url: { url, detail: detail ?? 'auto' } };
}

function toFilePart(
  family: OpenAiFamily,
  source: { url?: string; fileId?: string },
  filename: string | undefined,
): ChatCompletionContentPart {
  if (source.fileId) {
    return { type: 'file', file: { file_id: source.fileId } };
  }

  if (source.url?.startsWith('data:')) {
    return { type: 'file', file: { file_data: source.url, filename: filename ?? 'file' } };
  }

  throw unsupported(family, 'Chat Completions accepts file inputs only as inline data or an uploaded file id.', {
    part: 'file',
  });
}

function toContentPart(
  part: AiContentPart,
  family: OpenAiFamily,
  storage: OpenAiStorageDeliveries | undefined,
): ChatCompletionContentPart {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }

  if (part.url) {
    return part.type === 'image' ? toImagePart(part.url, part.detail) : toFilePart(family, { url: part.url }, part.filename);
  }

  if (!part.storageObjectId) {
    throw invalid(family, `An ${part.type} part needs a url or a storageObjectId.`, { part: part.type });
  }

  const delivered = storage?.get(part.storageObjectId);

  if (!delivered || (!delivered.url && !delivered.fileId)) {
    throw invalid(family, 'A storage-object input was not resolved by the runtime.', { part: part.type });
  }

  // By the stored object's modality, not the part's type (#441).
  if (delivered.modality === 'image') {
    if (!delivered.url) {
      throw unsupported(family, 'Chat Completions accepts images only by URL.', { part: part.type });
    }

    return toImagePart(delivered.url, part.type === 'image' ? part.detail : undefined);
  }

  return toFilePart(family, delivered, (part.type === 'file' ? part.filename : undefined) ?? delivered.filename);
}

function textOnly(family: OpenAiFamily, content: AiContentPart[], role: string): string {
  if (content.some((part) => part.type !== 'text')) {
    throw invalid(family, `A ${role} message may contain only text parts.`, { role });
  }

  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function toMessages(
  req: AiResponseRequest,
  family: OpenAiFamily,
  storage: OpenAiStorageDeliveries | undefined,
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];

  if (req.instructions !== undefined) {
    messages.push({ role: 'system', content: req.instructions });
  }

  if (typeof req.input === 'string') {
    messages.push({ role: 'user', content: req.input });

    return messages;
  }

  for (const item of req.input) {
    appendItem(messages, item, family, storage);
  }

  return messages;
}

function appendItem(
  messages: ChatCompletionMessageParam[],
  item: AiInputItem,
  family: OpenAiFamily,
  storage: OpenAiStorageDeliveries | undefined,
): void {
  switch (item.type) {
    case 'reasoning':
      // Chat Completions has no reasoning items to replay.
      return;

    case 'function_call_output':
      messages.push({ role: 'tool', tool_call_id: item.callId, content: item.output });
      return;

    case 'function_call': {
      // A replayed call belongs to the assistant turn that made it: the one
      // just before it when that turn is an assistant message, else a new one.
      const call: ChatCompletionMessageFunctionToolCall = {
        id: item.callId,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      };
      const last = messages[messages.length - 1];

      if (last?.role === 'assistant') {
        last.tool_calls = [...(last.tool_calls ?? []), call];
      } else {
        const assistant: ChatCompletionAssistantMessageParam = { role: 'assistant', content: null, tool_calls: [call] };

        messages.push(assistant);
      }
      return;
    }

    case 'message':
      break;
  }

  switch (item.role) {
    case 'assistant':
      messages.push({ role: 'assistant', content: textOnly(family, item.content, 'assistant') });
      return;

    case 'system':
    case 'developer':
      messages.push({ role: 'system', content: textOnly(family, item.content, item.role) });
      return;

    case 'user': {
      // Text-only turns travel as a plain string — the one shape every
      // compatible server accepts.
      const plain = item.content.every((part) => part.type === 'text');

      messages.push({
        role: 'user',
        content: plain
          ? item.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
          : item.content.map((part) => toContentPart(part, family, storage)),
      });
      return;
    }
  }
}

function toTool(tool: AiTool, family: OpenAiFamily): ChatCompletionFunctionTool {
  if (tool.type !== 'function') {
    throw unsupported(family, `Hosted tool "${tool.type}" is not supported over Chat Completions.`, {
      tool: tool.type,
      capability: 'hosted_tools',
    });
  }

  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toJsonSchema(tool.parameters),
      strict: tool.strict ?? true,
    },
  };
}

function toToolChoice(choice: AiToolChoice): ChatCompletionToolChoiceOption {
  return typeof choice === 'string' ? choice : { type: 'function', function: { name: choice.name } };
}

/**
 * Builds the Chat Completions body for `req`. `providerOptions[<provider id>]`
 * is shallow-merged LAST — the escape hatch for server-specific fields
 * (`top_p`, `seed`, Ollama's `keep_alive`, ...) — except `stream` and
 * `stream_options`, which belong to the engine.
 *
 * Throws `AiError` (never an SDK error): see the file header.
 */
export function toChatCompletionsRequest(
  req: AiResponseRequest,
  opts: ToChatCompletionsOptions = {},
): ChatCompletionsRequestBody {
  const family = opts.family ?? OPENAI_FAMILY;

  if (req.previousResponseId !== undefined) {
    throw unsupported(family, 'Chat Completions stores no responses; send the conversation as input instead.', {
      capability: 'previous_response_id',
    });
  }

  if (req.reasoning?.effort !== undefined) {
    throw unsupported(family, `Model "${req.model}" does not support reasoning effort over Chat Completions.`, {
      model: req.model,
      capability: 'reasoning',
    });
  }

  const body: ChatCompletionsRequestBody = {
    model: req.model,
    messages: toMessages(req, family, opts.storage),
  };

  if (req.tools && req.tools.length > 0) body.tools = req.tools.map((tool) => toTool(tool, family));
  if (req.toolChoice !== undefined) body.tool_choice = toToolChoice(req.toolChoice);

  if (req.structuredOutput) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: req.structuredOutput.name,
        schema: toJsonSchema(req.structuredOutput.schema),
        strict: req.structuredOutput.strict ?? true,
      },
    };
  }

  if (req.maxOutputTokens !== undefined) {
    body[opts.tokenParameter ?? 'max_completion_tokens'] = req.maxOutputTokens;
  }

  if (req.temperature !== undefined) body.temperature = req.temperature;

  const {
    stream: _stream,
    stream_options: _streamOptions,
    ...escapeHatch
  } = (req.providerOptions?.[family.providerId] ?? {}) as Record<string, unknown>;

  return { ...body, ...(escapeHatch as Partial<ChatCompletionsRequestBody>) };
}

// ---- response ---------------------------------------------------------------

function finishReasonOf(raw: string | null | undefined, output: AiOutputItem[], refused: boolean): AiFinishReason {
  if (refused || raw === 'content_filter') return 'content_filter';
  if (output.some((item) => item.type === 'function_call')) return 'tool_calls';
  if (raw === 'length') return 'length';

  return 'stop';
}

function usageOf(usage: ChatCompletion['usage']): AiUsage {
  if (!usage) return {};

  const out: AiUsage = { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  const cached = usage.prompt_tokens_details?.cached_tokens;

  if (typeof reasoning === 'number') out.reasoningTokens = reasoning;
  if (typeof cached === 'number') out.cachedInputTokens = cached;

  return out;
}

export interface FromChatCompletionOptions {
  /** The originating request; its `structuredOutput` drives `parsed`. */
  request: AiResponseRequest;
  providerRequestId?: string | null;
  family?: OpenAiFamily;
}

/**
 * Maps a finished `ChatCompletion` to an `AiResponse`. Only the first choice
 * is read (the request never asks for more). A completion with no choice at
 * all is a provider fault. When structured output was requested and the turn
 * finished (no pending tool call), the text is validated with
 * `parseStructured` — invalid JSON or a schema mismatch throws
 * `AI_STRUCTURED_OUTPUT_INVALID`.
 */
export function fromChatCompletion(completion: ChatCompletion, opts: FromChatCompletionOptions): AiResponse {
  const family = opts.family ?? OPENAI_FAMILY;
  const providerRequestId = opts.providerRequestId ?? undefined;
  const choice = completion.choices?.[0];

  if (!choice) {
    throw new AiError('AI_PROVIDER_UNAVAILABLE', `${family.label} returned a completion with no choices.`, {
      details: { provider: family.providerId, ...(providerRequestId ? { providerRequestId } : {}) },
    });
  }

  const output: AiOutputItem[] = [];
  const text = typeof choice.message?.content === 'string' ? choice.message.content : '';

  if (text.length > 0) output.push({ type: 'message', text });

  for (const call of choice.message?.tool_calls ?? []) {
    if (call.type !== 'function') continue;

    output.push({
      type: 'function_call',
      callId: call.id,
      name: call.function.name,
      arguments: call.function.arguments ?? '',
    });
  }

  const refused = typeof choice.message?.refusal === 'string' && choice.message.refusal.length > 0;
  const finishReason = finishReasonOf(choice.finish_reason, output, refused);

  const result: AiResponse = {
    // Some compatible servers omit the id; the neutral contract needs one.
    id: completion.id || `chatcmpl-${randomUUID()}`,
    provider: family.providerId,
    model: completion.model || opts.request.model,
    output,
    outputText: text,
    usage: usageOf(completion.usage),
    finishReason,
  };

  if (providerRequestId) result.providerRequestId = providerRequestId;

  if (opts.request.structuredOutput && finishReason !== 'tool_calls') {
    result.parsed = parseStructured(opts.request.structuredOutput.schema, text);
  }

  return result;
}
