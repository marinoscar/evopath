// =============================================================================
// Our Responses types <-> Anthropic Messages API (issue #446, epic #421)
// =============================================================================
//
// Pure functions, no I/O: `toAnthropicRequest` builds the SDK request body
// from an `AiResponseRequest`, `fromAnthropicMessage` turns a `Message` back
// into an `AiResponse`. The stream mapper shares `finishAnthropicResponse`,
// so a streamed and a non-streamed call cannot disagree about what a
// response means. This is the file that proves the neutral contract fits a
// second, differently shaped API unchanged.
//
// REQUEST MAPPING
//
//   instructions (+ system/developer messages)  -> `system`
//   message (user)          -> user turn: `text`, `image` (URL, or base64 from
//                              a `data:` URL), `document` (PDF by URL or
//                              base64; plain text inline)
//   message (assistant)     -> assistant turn, text only
//   function_call           -> assistant `tool_use` (the arguments parsed)
//   function_call_output    -> user `tool_result`
//   reasoning               -> the signed `thinking` / `redacted_thinking`
//                              blocks it carries as provider state
//                              (`AI_PROVIDER_STATE`), replayed verbatim; a
//                              reasoning item without Anthropic state is
//                              dropped (it has nothing Anthropic could verify)
//   function tools          -> `tools` with `input_schema`
//   toolChoice              -> auto | none | any ('required') | tool (named)
//   reasoning.effort        -> 'adaptive' families: `thinking: adaptive` +
//                              `output_config.effort`; 'budget' families:
//                              `thinking: enabled` + `budget_tokens`
//                              (`ANTHROPIC_THINKING_BUDGETS`)
//   structuredOutput        -> `output_config.format` (native), or a forced
//                              single tool whose `input_schema` is the schema
//                              ('tool' families); either way validated with
//                              `parseStructured`
//   maxOutputTokens         -> `max_tokens` (REQUIRED by the API — defaulted,
//                              see `resolveMaxTokens`)
//
// Consecutive items of the same role merge into one turn, so a replayed
// round (thinking, text, tool_use) is ONE assistant message and its tool
// outputs ONE user message — the shape Anthropic requires.
//
// THINKING IS NEVER EXPOSED RAW. A `thinking` block's text becomes the
// reasoning item's `summary` (Claude 4+ returns a summary there, never the
// raw chain of thought; `display: 'summarized'` is requested whenever the
// caller asks for reasoning on an adaptive model). Its `signature`, and every
// `redacted_thinking` block's encrypted `data`, travel only as symbol-keyed
// provider state — needed to replay a tool-use turn, invisible to JSON.
//
// REFUSED (AI_CAPABILITY_UNSUPPORTED): `previousResponseId` (Anthropic stores
// nothing — the facade refuses it first; this is defence in depth), hosted
// tools, a reasoning effort on a family without extended thinking,
// `temperature` on a family that rejects sampling parameters or together with
// extended thinking, and — on the forced-tool structured-output path only —
// extended thinking or other tools alongside a schema.
//
// NOT MAPPED: `metadata` (Anthropic's only metadata field is an end-user id,
// which is not what this contract's free-form map means) — dropped.
// `providerOptions.anthropic` is shallow-merged LAST as the escape hatch,
// except `stream`, which belongs to the port.
// =============================================================================

import type {
  ContentBlock,
  ContentBlockParam,
  ImageBlockParam,
  DocumentBlockParam,
  Message,
  MessageCreateParamsBase,
  MessageParam,
  RedactedThinkingBlockParam,
  StopReason,
  TextBlockParam,
  ThinkingBlockParam,
  Tool,
  ToolChoice,
  Usage,
} from '@anthropic-ai/sdk/resources/messages/messages';

import { AiError } from '../../core/ai-error';
import type { AiStorageInputModality } from '../../core/types/file-inputs.types';
import { parseStructured, toJsonSchema } from '../../core/structured-output';
import {
  AI_PROVIDER_STATE,
  type AiContentPart,
  type AiFinishReason,
  type AiInputItem,
  type AiOutputItem,
  type AiProviderState,
  type AiReasoningItem,
  type AiResponse,
  type AiResponseRequest,
  type AiTool,
  type AiToolChoice,
  type AiUsage,
} from '../../core/types/responses.types';
import { ANTHROPIC_PROVIDER_ID } from './anthropic-errors';
import {
  ANTHROPIC_ADAPTIVE_EFFORTS,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_THINKING_BUDGETS,
  ANTHROPIC_UNCLASSIFIED_MAX_OUTPUT_TOKENS,
  type AnthropicModelProfile,
} from './anthropic-model-catalog';

/** The request body minus `stream`, which the port sets. */
export type AnthropicRequestBody = Omit<MessageCreateParamsBase, 'stream'>;

/** The signed / encrypted thinking blocks a reasoning item replays. */
export type AnthropicThinkingBlock = ThinkingBlockParam | RedactedThinkingBlockParam;

/** What `AI_PROVIDER_STATE.data` holds for an Anthropic reasoning item. */
export interface AnthropicReasoningState {
  blocks: AnthropicThinkingBlock[];
}

/**
 * How one storage-object input reached Anthropic (#441): a presigned URL
 * Anthropic fetches (images), or the bytes inline (documents). ⚠ `url` may be
 * presigned — it goes into the request body and nowhere else.
 */
export interface AnthropicStorageDelivery {
  modality: AiStorageInputModality;
  mimeType: string;
  filename: string;
  url?: string;
  data?: Uint8Array;
}

/** Deliveries keyed by storage object id. */
export type AnthropicStorageDeliveries = ReadonlyMap<string, AnthropicStorageDelivery>;

/**
 * What the request mapper decided that the response mapper must know: the
 * name of the forced structured-output tool, when that path was taken.
 */
export interface AnthropicRequestPlan {
  body: AnthropicRequestBody;
  structuredToolName?: string;
}

/** Image types the Messages API accepts inline. */
const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

function unsupported(message: string, details: Record<string, unknown> = {}): AiError {
  return new AiError('AI_CAPABILITY_UNSUPPORTED', message, {
    details: { provider: ANTHROPIC_PROVIDER_ID, ...details },
  });
}

function invalid(message: string, details: Record<string, unknown> = {}): AiError {
  return new AiError('AI_INVALID_REQUEST', message, {
    details: { provider: ANTHROPIC_PROVIDER_ID, ...details },
  });
}

// ---- request: content ---------------------------------------------------------

interface ParsedDataUrl {
  mediaType: string;
  base64: string;
}

/** `data:<type>;base64,<payload>` -> its parts, or `null` for anything else. */
function parseDataUrl(url: string): ParsedDataUrl | null {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(url);

  return match ? { mediaType: match[1].trim().toLowerCase(), base64: match[2] } : null;
}

function isImageMediaType(value: string): value is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

function imageFromUrl(url: string): ImageBlockParam {
  const data = parseDataUrl(url);

  if (!data) return { type: 'image', source: { type: 'url', url } };

  if (!isImageMediaType(data.mediaType)) {
    throw unsupported(`Anthropic does not accept "${data.mediaType}" images.`, { mediaType: data.mediaType });
  }

  return { type: 'image', source: { type: 'base64', media_type: data.mediaType, data: data.base64 } };
}

/** A document block from bytes: a PDF as base64, plain text inline. */
function documentFromBytes(mediaType: string, base64: string, title: string | undefined): DocumentBlockParam {
  const withTitle = title ? { title } : {};

  if (mediaType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 }, ...withTitle };
  }

  if (mediaType === 'text/plain') {
    return {
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: Buffer.from(base64, 'base64').toString('utf8') },
      ...withTitle,
    };
  }

  throw unsupported(`Anthropic accepts PDF and plain-text documents, not "${mediaType}".`, { mediaType });
}

function documentFromUrl(url: string, filename: string | undefined): DocumentBlockParam {
  const data = parseDataUrl(url);

  // A remote document by URL: Anthropic fetches PDFs only.
  return data
    ? documentFromBytes(data.mediaType, data.base64, filename)
    : { type: 'document', source: { type: 'url', url }, ...(filename ? { title: filename } : {}) };
}

/** A storage-object part, from what the adapter delivered for it — by the object's MODALITY. */
function storagePart(
  part: Extract<AiContentPart, { type: 'image' | 'file' }> & { storageObjectId: string },
  storage: AnthropicStorageDeliveries | undefined,
): ContentBlockParam {
  const delivered = storage?.get(part.storageObjectId);

  if (!delivered || (!delivered.url && !delivered.data)) {
    throw invalid('A storage-object input was not resolved by the runtime.', { part: part.type });
  }

  const filename = (part.type === 'file' ? part.filename : undefined) ?? delivered.filename;

  if (delivered.modality === 'image') {
    if (delivered.url) return imageFromUrl(delivered.url);

    if (!isImageMediaType(delivered.mimeType)) {
      throw unsupported(`Anthropic does not accept "${delivered.mimeType}" images.`, { mediaType: delivered.mimeType });
    }

    return {
      type: 'image',
      source: { type: 'base64', media_type: delivered.mimeType, data: Buffer.from(delivered.data!).toString('base64') },
    };
  }

  return delivered.data
    ? documentFromBytes(delivered.mimeType, Buffer.from(delivered.data).toString('base64'), filename)
    : documentFromUrl(delivered.url!, filename);
}

function toUserBlock(part: AiContentPart, storage: AnthropicStorageDeliveries | undefined): ContentBlockParam {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };

    case 'image':
      if (part.url) return imageFromUrl(part.url);
      if (part.storageObjectId) return storagePart({ ...part, storageObjectId: part.storageObjectId }, storage);
      throw invalid('An image part needs a url or a storageObjectId.', { part: 'image' });

    case 'file':
      if (part.url) return documentFromUrl(part.url, part.filename);
      if (part.storageObjectId) return storagePart({ ...part, storageObjectId: part.storageObjectId }, storage);
      throw invalid('A file part needs a url or a storageObjectId.', { part: 'file' });
  }
}

/** Every storage object id `req` names, in order, each once. */
export function anthropicStorageObjectIds(req: AiResponseRequest): string[] {
  if (!Array.isArray(req.input)) return [];

  const ids = new Set<string>();

  for (const item of req.input) {
    if (item.type !== 'message') continue;

    for (const part of item.content) {
      if (part.type !== 'text' && !part.url && part.storageObjectId) ids.add(part.storageObjectId);
    }
  }

  return [...ids];
}

/** The thinking blocks an Anthropic reasoning item carries, or `[]`. */
export function anthropicReasoningBlocks(item: AiReasoningItem): AnthropicThinkingBlock[] {
  const state = item[AI_PROVIDER_STATE];

  if (!state || state.provider !== ANTHROPIC_PROVIDER_ID) return [];

  const blocks = (state.data as Partial<AnthropicReasoningState> | undefined)?.blocks;

  return Array.isArray(blocks) ? blocks.map((block) => ({ ...block })) : [];
}

function parseArguments(item: Extract<AiInputItem, { type: 'function_call' }>): unknown {
  try {
    return JSON.parse(item.arguments || '{}');
  } catch {
    throw invalid('A replayed function call carries arguments that are not JSON.', { callId: item.callId });
  }
}

interface Conversation {
  system: string[];
  messages: MessageParam[];
}

/** Appends blocks to the conversation, merging into the previous turn when the role matches. */
function push(conv: Conversation, role: 'user' | 'assistant', blocks: ContentBlockParam[]): void {
  if (blocks.length === 0) return;

  const last = conv.messages[conv.messages.length - 1];

  if (last && last.role === role && Array.isArray(last.content)) {
    last.content.push(...blocks);
  } else {
    conv.messages.push({ role, content: [...blocks] });
  }
}

function toConversation(req: AiResponseRequest, storage: AnthropicStorageDeliveries | undefined): Conversation {
  const conv: Conversation = { system: req.instructions ? [req.instructions] : [], messages: [] };

  if (typeof req.input === 'string') {
    push(conv, 'user', [{ type: 'text', text: req.input }]);

    return conv;
  }

  for (const item of req.input) {
    switch (item.type) {
      case 'message':
        if (item.role === 'system' || item.role === 'developer') {
          if (item.content.some((part) => part.type !== 'text')) {
            throw invalid('A system message may contain only text parts.', { role: item.role });
          }
          conv.system.push(item.content.map((part) => (part.type === 'text' ? part.text : '')).join(''));
        } else if (item.role === 'assistant') {
          if (item.content.some((part) => part.type !== 'text')) {
            throw invalid('An assistant message may contain only text parts.', { role: 'assistant' });
          }
          push(
            conv,
            'assistant',
            item.content
              .map((part) => (part.type === 'text' ? part.text : ''))
              .filter((text) => text.length > 0)
              .map((text): TextBlockParam => ({ type: 'text', text })),
          );
        } else {
          push(conv, 'user', item.content.map((part) => toUserBlock(part, storage)));
        }
        break;

      case 'function_call':
        push(conv, 'assistant', [{ type: 'tool_use', id: item.callId, name: item.name, input: parseArguments(item) }]);
        break;

      case 'function_call_output':
        push(conv, 'user', [{ type: 'tool_result', tool_use_id: item.callId, content: item.output }]);
        break;

      case 'reasoning':
        push(conv, 'assistant', anthropicReasoningBlocks(item));
        break;
    }
  }

  return conv;
}

// ---- request: tools, schema, thinking -------------------------------------------

function toTool(tool: AiTool, strict: boolean): Tool {
  if (tool.type !== 'function') {
    throw unsupported(`Hosted tool "${tool.type}" is not supported by Anthropic.`, { tool: tool.type });
  }

  const schema = toJsonSchema(tool.parameters);

  if (schema.type !== 'object') {
    throw invalid(`Tool "${tool.name}" parameters must be an object schema.`, { tool: tool.name });
  }

  return {
    name: tool.name,
    description: tool.description,
    input_schema: schema as Tool['input_schema'],
    // Strict tool use is part of Anthropic's structured-outputs feature, so
    // it is only asked for where the family supports it natively.
    ...(strict && tool.strict === true ? { strict: true } : {}),
  };
}

function toToolChoice(choice: AiToolChoice): ToolChoice {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };

  return { type: 'tool', name: choice.name };
}

/** A tool name Anthropic accepts (`^[a-zA-Z0-9_-]{1,64}$`), from a schema name. */
function structuredToolName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

  return safe.length > 0 ? safe : 'structured_output';
}

type Thinking = Pick<AnthropicRequestBody, 'thinking' | 'output_config'>;

/** How `req.reasoning` is expressed for this family — or refused. */
function toThinking(req: AiResponseRequest, profile: AnthropicModelProfile | null): { thinking: Thinking; budget?: number } {
  const effort = req.reasoning?.effort;
  const wantsSummary = req.reasoning?.summary !== undefined;

  if (effort === undefined && !wantsSummary) return { thinking: {} };

  // An unclassified model is assumed current (adaptive): an administrator
  // enabled it knowing more than this table, and Anthropic's own 400 is then
  // the answer — the same pass-through posture the OpenAI mapper takes.
  const style = profile?.thinking ?? 'adaptive';

  if (style === 'none') {
    if (effort !== undefined) {
      throw unsupported(`Model "${req.model}" does not support reasoning effort.`, {
        model: req.model,
        capability: 'reasoning',
      });
    }

    return { thinking: {} };
  }

  if (style === 'adaptive') {
    return {
      thinking: {
        thinking: { type: 'adaptive', display: 'summarized' },
        ...(effort !== undefined ? { output_config: { effort: ANTHROPIC_ADAPTIVE_EFFORTS[effort] } } : {}),
      },
    };
  }

  // 'budget': thinking is off unless an effort is named; a summary request
  // alone asks for summaries of thinking that is not happening — a no-op.
  if (effort === undefined) return { thinking: {} };

  const budget = ANTHROPIC_THINKING_BUDGETS[effort];

  return { thinking: { thinking: { type: 'enabled', budget_tokens: budget } }, budget };
}

/**
 * `max_tokens`, which the Messages API requires: the caller's
 * `maxOutputTokens` (already clamped by the facade), else
 * `ANTHROPIC_DEFAULT_MAX_TOKENS` capped at the model's own limit. A
 * thinking budget must fit inside it with room for an answer: by default the
 * budget is added on top; with an explicit cap, the budget shrinks to fit,
 * and a cap too small for the minimum budget is refused.
 */
function resolveMaxTokens(
  req: AiResponseRequest,
  profile: AnthropicModelProfile | null,
  budget: number | undefined,
): { maxTokens: number; budget?: number } {
  const modelMax = profile?.capabilities.maxOutputTokens ?? ANTHROPIC_UNCLASSIFIED_MAX_OUTPUT_TOKENS;

  if (req.maxOutputTokens !== undefined) {
    if (budget === undefined) return { maxTokens: req.maxOutputTokens };

    const fitted = Math.min(budget, req.maxOutputTokens - 1024);

    if (fitted < ANTHROPIC_THINKING_BUDGETS.minimal) {
      throw invalid('maxOutputTokens is too small for extended thinking on this model.', {
        model: req.model,
        maxOutputTokens: req.maxOutputTokens,
      });
    }

    return { maxTokens: req.maxOutputTokens, budget: fitted };
  }

  const answer = Math.min(ANTHROPIC_DEFAULT_MAX_TOKENS, modelMax);

  return budget === undefined
    ? { maxTokens: answer }
    : { maxTokens: Math.min(answer + budget, modelMax), budget: Math.min(budget, Math.min(answer + budget, modelMax) - 1024) };
}

/**
 * Builds the Anthropic request body for `req`.
 *
 * `profile` is the model's classifier profile (or `null` when unclassified);
 * `storage` is what the adapter delivered for each storage-object part.
 * Throws `AiError` (never an SDK error): see the file header.
 */
export function toAnthropicRequest(
  req: AiResponseRequest,
  profile: AnthropicModelProfile | null,
  storage?: AnthropicStorageDeliveries,
): AnthropicRequestPlan {
  if (req.previousResponseId !== undefined) {
    throw unsupported('Anthropic does not store responses; send the conversation history as input instead.', {
      capability: 'previous_response_id',
    });
  }

  const conv = toConversation(req, storage);

  if (conv.messages.length === 0) {
    throw invalid('The request has no user or assistant content.');
  }

  const nativeSchemas = (profile?.structuredOutput ?? 'native') === 'native';
  const { thinking, budget: requestedBudget } = toThinking(req, profile);
  const thinkingOn = thinking.thinking !== undefined;

  if (req.temperature !== undefined) {
    if (profile && !profile.sampling) {
      throw unsupported(`Model "${req.model}" does not accept a temperature.`, { model: req.model, parameter: 'temperature' });
    }
    if (thinkingOn) {
      throw unsupported('A temperature cannot be combined with extended thinking.', { model: req.model, parameter: 'temperature' });
    }
  }

  const { maxTokens, budget } = resolveMaxTokens(req, profile, requestedBudget);

  const body: AnthropicRequestBody = {
    model: req.model,
    max_tokens: maxTokens,
    messages: conv.messages,
  };

  if (conv.system.length > 0) body.system = conv.system.join('\n\n');

  const tools = (req.tools ?? []).map((tool) => toTool(tool, nativeSchemas));

  if (tools.length > 0) body.tools = tools;
  if (req.toolChoice !== undefined) body.tool_choice = toToolChoice(req.toolChoice);

  if (thinking.thinking) {
    body.thinking =
      thinking.thinking.type === 'enabled' && budget !== undefined
        ? { type: 'enabled', budget_tokens: budget }
        : thinking.thinking;
  }
  if (thinking.output_config) body.output_config = { ...thinking.output_config };

  let structuredTool: string | undefined;

  if (req.structuredOutput) {
    const schema = toJsonSchema(req.structuredOutput.schema);

    if (nativeSchemas) {
      body.output_config = { ...(body.output_config ?? {}), format: { type: 'json_schema', schema } };
    } else {
      // The forced single tool. Anthropic forbids a forced `tool_choice`
      // with extended thinking, and forcing it would make every other tool
      // (and any caller toolChoice) unreachable — so those combinations are
      // refused rather than quietly changed.
      if (thinkingOn) {
        throw unsupported(`Model "${req.model}" cannot combine structured output with extended thinking.`, {
          model: req.model,
          capability: 'structured_output',
        });
      }
      if (tools.length > 0 || req.toolChoice !== undefined) {
        throw unsupported(`Model "${req.model}" cannot combine structured output with other tools.`, {
          model: req.model,
          capability: 'structured_output',
        });
      }
      if (schema.type !== 'object') {
        throw unsupported(`Model "${req.model}" needs an object schema for structured output.`, {
          model: req.model,
          capability: 'structured_output',
        });
      }

      structuredTool = structuredToolName(req.structuredOutput.name);
      body.tools = [
        {
          name: structuredTool,
          description: 'Respond by calling this tool with the complete answer as its input.',
          input_schema: schema as Tool['input_schema'],
        },
      ];
      body.tool_choice = { type: 'tool', name: structuredTool };
    }
  }

  if (req.temperature !== undefined) body.temperature = req.temperature;

  const { stream: _stream, ...escapeHatch } = req.providerOptions?.[ANTHROPIC_PROVIDER_ID] ?? {};

  return {
    body: { ...body, ...(escapeHatch as Partial<AnthropicRequestBody>) },
    ...(structuredTool ? { structuredToolName: structuredTool } : {}),
  };
}

// ---- response -----------------------------------------------------------------

/** A reasoning item for replayable thinking blocks: summary text out, signature in the symbol state. */
export function anthropicReasoningItem(block: AnthropicThinkingBlock): AiReasoningItem {
  const state: AiProviderState = {
    provider: ANTHROPIC_PROVIDER_ID,
    data: { blocks: [{ ...block }] } satisfies AnthropicReasoningState,
  };
  const summary = block.type === 'thinking' && block.thinking.length > 0 ? [block.thinking] : [];

  return { type: 'reasoning', summary, [AI_PROVIDER_STATE]: state };
}

/**
 * Maps one content block. `null` for a block type this contract does not
 * model (server-tool blocks, which this adapter never requests).
 */
export function fromAnthropicContentBlock(block: ContentBlock, structuredTool?: string): AiOutputItem | null {
  switch (block.type) {
    case 'text':
      return { type: 'message', text: block.text };

    case 'thinking':
      return anthropicReasoningItem({ type: 'thinking', thinking: block.thinking, signature: block.signature });

    case 'redacted_thinking':
      return anthropicReasoningItem({ type: 'redacted_thinking', data: block.data });

    case 'tool_use':
      return block.name === structuredTool
        ? { type: 'message', text: JSON.stringify(block.input ?? {}) }
        : { type: 'function_call', callId: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) };

    default:
      return null;
  }
}

/** Usage, normalised: `inputTokens` includes cached tokens, as OpenAI's does. */
export function anthropicUsage(usage: Partial<Pick<Usage, 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens' | 'output_tokens_details'>> | null | undefined): AiUsage {
  if (!usage) return {};

  const out: AiUsage = {};
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;

  if (typeof usage.input_tokens === 'number') out.inputTokens = usage.input_tokens + cacheRead + cacheWrite;
  if (typeof usage.output_tokens === 'number') out.outputTokens = usage.output_tokens;
  if (usage.cache_read_input_tokens != null) out.cachedInputTokens = usage.cache_read_input_tokens;

  const thinking = usage.output_tokens_details?.thinking_tokens;

  if (typeof thinking === 'number') out.reasoningTokens = thinking;

  return out;
}

function finishReasonOf(stopReason: StopReason | null | undefined, output: AiOutputItem[]): AiFinishReason {
  switch (stopReason) {
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'refusal':
      return 'content_filter';
    case 'tool_use':
      return output.some((item) => item.type === 'function_call') ? 'tool_calls' : 'stop';
    default:
      // end_turn, stop_sequence, pause_turn (server tools only), or none.
      return output.some((item) => item.type === 'function_call') ? 'tool_calls' : 'stop';
  }
}

export interface FromAnthropicOptions {
  /** The originating request; its `structuredOutput` drives `parsed`. */
  request: AiResponseRequest;
  /** The `request-id` Anthropic answered with. */
  providerRequestId?: string | null;
}

export interface AnthropicResponseParts {
  id: string;
  model: string;
  output: AiOutputItem[];
  stopReason: StopReason | null | undefined;
  usage: AiUsage;
}

/**
 * The `AiResponse` for mapped parts — shared by `create` and the stream. When
 * the request asked for structured output and the model finished its turn,
 * the text is validated with `parseStructured` (a mismatch throws
 * `AI_STRUCTURED_OUTPUT_INVALID`).
 */
export function finishAnthropicResponse(parts: AnthropicResponseParts, opts: FromAnthropicOptions): AiResponse {
  const outputText = parts.output.map((item) => (item.type === 'message' ? item.text : '')).join('');
  const finishReason = finishReasonOf(parts.stopReason, parts.output);

  const result: AiResponse = {
    id: parts.id,
    provider: ANTHROPIC_PROVIDER_ID,
    model: parts.model,
    output: parts.output,
    outputText,
    usage: parts.usage,
    finishReason,
  };

  if (opts.providerRequestId) result.providerRequestId = opts.providerRequestId;

  if (opts.request.structuredOutput && finishReason !== 'tool_calls') {
    result.parsed = parseStructured(opts.request.structuredOutput.schema, outputText);
  }

  return result;
}

/** Maps a finished SDK `Message` to an `AiResponse`. */
export function fromAnthropicMessage(
  message: Message,
  opts: FromAnthropicOptions & { structuredToolName?: string },
): AiResponse {
  const output = message.content
    .map((block) => fromAnthropicContentBlock(block, opts.structuredToolName))
    .filter((item): item is AiOutputItem => item !== null);

  return finishAnthropicResponse(
    { id: message.id, model: message.model, output, stopReason: message.stop_reason, usage: anthropicUsage(message.usage) },
    opts,
  );
}
