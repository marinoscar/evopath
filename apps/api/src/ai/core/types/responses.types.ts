// =============================================================================
// Text/reasoning/tool request and response types (issue #424, epic #419)
// =============================================================================
//
// Shaped after the OpenAI Responses API because it is the most expressive of
// the current provider APIs (typed input items, typed output items, hosted
// tools, reasoning summaries, response chaining) — but PROVIDER-NEUTRAL: no
// SDK type appears here, and every provider maps onto these shapes inside its
// own adapter. A field one provider cannot honour is the adapter's problem to
// reject with `AI_CAPABILITY_UNSUPPORTED`, never a reason to widen this file
// with provider-specific members. `providerOptions` is the one escape hatch.
//
// Tool parameters and structured-output schemas are ZOD schemas, not JSON
// Schema: the caller's validation and the provider's schema are then the same
// object and cannot disagree. Adapters convert with `toJsonSchema()`.
// =============================================================================

import type { z } from 'zod';

import type { AiErrorCode } from '../ai-error';
import type { AiReasoningEffort } from '../capabilities';
import type { AiBinaryPayload } from './media.types';

export type AiMessageRole = 'user' | 'assistant' | 'system' | 'developer';

/**
 * One part of a message. Media parts point at bytes (exactly one of a URL or
 * a storage object id) rather than embedding them: resolving a storage
 * object into something a provider can read is the runtime's job (#441 —
 * see `file-inputs.types.ts`), so it happens once per call, under the
 * caller's own authorization, and the request itself keeps only the id.
 */
export type AiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url?: string; storageObjectId?: string; detail?: 'low' | 'high' | 'auto' }
  | { type: 'file'; storageObjectId?: string; url?: string; filename?: string };

// ---- provider continuation state (#446) ---------------------------------------
//
// A STATELESS provider (Anthropic's Messages API) cannot resume a response by
// id, so a multi-round conversation — the tool loop — resends the whole
// history, including the model's own earlier turns. Some of what the model
// produced must then be echoed back byte-for-byte even though it is not
// something a caller may see: Anthropic signs every `thinking` block and
// requires the signed block (or the encrypted `redacted_thinking` block) back
// on the next request of a tool-use turn.
//
// That opaque material rides on the `reasoning` item under a SYMBOL key, so
// it is invisible by construction to everything that serialises a response:
// `JSON.stringify` (every HTTP body, SSE frame, log line and `ai_runs.output`
// row) skips symbol keys, and so do DTO mappers that name their fields. It
// survives only an in-process object copy (`{ ...item }`), which is exactly
// the tool loop's hop from one round's output to the next round's input.
// An adapter reads only state whose `provider` is its own id.

/** The symbol key provider continuation state travels under (see above). */
export const AI_PROVIDER_STATE: unique symbol = Symbol('ai.providerState');

/**
 * Opaque, provider-owned continuation state. ⚠ Never exposed: it may hold a
 * signature or encrypted reasoning, which a caller must not see.
 */
export interface AiProviderState {
  /** The adapter id that produced it — only that adapter reads it. */
  provider: string;
  data: unknown;
}

/** A reasoning summary, plus the provider's opaque state for replaying it. */
export interface AiReasoningItem {
  type: 'reasoning';
  summary: string[];
  [AI_PROVIDER_STATE]?: AiProviderState;
}

/**
 * A request's input. Beyond messages and tool outputs, an input may REPLAY
 * the model's own earlier `function_call` and `reasoning` items (#446) — how
 * a caller, or the tool loop, carries a conversation to a provider that
 * cannot chain with `previousResponseId` (see
 * `AiProviderAdapter.supportsPreviousResponseId`). A provider that chains may
 * ignore replayed reasoning it cannot use.
 */
export type AiInputItem =
  | { type: 'message'; role: AiMessageRole; content: AiContentPart[] }
  | { type: 'function_call'; callId: string; name: string; arguments: string }
  | { type: 'function_call_output'; callId: string; output: string }
  | AiReasoningItem;

/**
 * A function the model may call. `parameters` is a Zod schema; it is both
 * what the provider is told (via `toJsonSchema`) and what the model's
 * arguments are validated against before `execute` runs (see `tools.ts`).
 */
export interface AiFunctionTool<P extends z.ZodTypeAny = z.ZodTypeAny> {
  type: 'function';
  name: string;
  description: string;
  parameters: P;
  strict?: boolean;
}

/**
 * The tools the PROVIDER executes inside one response (issue #442): live web
 * search, file search over provider-side vector stores, sandboxed code
 * execution, image generation and remote MCP servers. Each is gated twice —
 * the model must declare `hosted_tools` AND an administrator must have
 * switched that tool type on (`ai.hostedTools.<type>`, all off by default) —
 * see `AiService.prepare` and `core/hosted-tools.ts`.
 */
export const AI_HOSTED_TOOL_TYPES = [
  'web_search',
  'file_search',
  'code_interpreter',
  'image_generation',
  'mcp',
] as const;

export type AiHostedToolType = (typeof AI_HOSTED_TOOL_TYPES)[number];

export interface AiWebSearchTool {
  type: 'web_search';
  searchContextSize?: 'low' | 'medium' | 'high';
  /** Approximate location to bias results toward (ISO-3166 alpha-2 `country`). */
  userLocation?: { country?: string; city?: string };
}

export interface AiFileSearchTool {
  type: 'file_search';
  /** Provider-side vector store ids to search (at least one). */
  vectorStoreIds: string[];
  maxResults?: number;
}

export interface AiCodeInterpreterTool {
  type: 'code_interpreter';
  /** The sandbox; only a provider-managed `auto` container is modelled. */
  container?: { type: 'auto' };
}

export interface AiImageGenerationTool {
  type: 'image_generation';
  /** Provider-validated, e.g. `1024x1024` or `auto`. */
  size?: string;
  /** Provider-validated, e.g. `low` / `medium` / `high` / `auto`. */
  quality?: string;
}

export interface AiMcpTool {
  type: 'mcp';
  /** A short label the model and the output items name the server by. */
  serverLabel: string;
  /** MUST be `https://`; the host must pass `ai.hostedTools.mcpAllowedHosts` when that list is set. */
  serverUrl: string;
  /** Restrict the model to these of the server's tools. */
  allowedTools?: string[];
  requireApproval?: 'never' | 'always';
  /**
   * Sent to the MCP server with each request (typically `Authorization`).
   *
   * ⚠ SECRET MATERIAL. Header values are never logged, never put on a span or
   * a usage row, never stored in `ai_runs.request` (a background run carrying
   * them is refused), never part of an `AiError`, and scrubbed from the
   * response should the server echo one back (`AiService`).
   */
  headers?: Record<string, string>;
}

export type AiHostedTool =
  | AiWebSearchTool
  | AiFileSearchTool
  | AiCodeInterpreterTool
  | AiImageGenerationTool
  | AiMcpTool;

export type AiTool = AiFunctionTool | AiHostedTool;

export type AiToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; name: string };

export interface AiStructuredOutputSpec<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** A short identifier for the schema (`[a-zA-Z0-9_-]`); some providers require one. */
  name: string;
  schema: S;
  strict?: boolean;
}

export interface AiResponseRequest<S extends z.ZodTypeAny = z.ZodTypeAny> {
  model: string;
  instructions?: string;
  input: string | AiInputItem[];
  tools?: AiTool[];
  toolChoice?: AiToolChoice;
  structuredOutput?: AiStructuredOutputSpec<S>;
  reasoning?: { effort?: AiReasoningEffort; summary?: 'auto' | 'concise' | 'detailed' };
  maxOutputTokens?: number;
  temperature?: number;
  /**
   * Chain onto an earlier response instead of resending history. Only for a
   * provider that stores responses — one declaring
   * `supportsPreviousResponseId: false` (Anthropic) refuses it with
   * `AI_CAPABILITY_UNSUPPORTED`; send the full history as `input` instead.
   */
  previousResponseId?: string;
  metadata?: Record<string, string>;
  /**
   * Keyed by provider id (`{ openai: { ... } }`). The escape hatch for a
   * provider feature this contract does not model; an adapter reads only its
   * own key and ignores the rest, so one request stays portable.
   */
  providerOptions?: Record<string, Record<string, unknown>>;
}

/** A web-search citation on a message: `text.slice(startIndex, endIndex)` is what it supports. */
export interface AiUrlCitation {
  url: string;
  title: string;
  startIndex: number;
  endIndex: number;
}

export interface AiMessageOutputItem {
  type: 'message';
  text: string;
  /** Web sources the text cites (hosted `web_search`), in the provider's order. */
  citations?: AiUrlCitation[];
}

/** `web_search`: what was searched and the sources consulted. */
export interface AiWebSearchCallResult {
  queries: string[];
  sources: Array<{ url: string }>;
}

/** `file_search`: the queries run and the chunks retrieved (when the provider returned them). */
export interface AiFileSearchCallResult {
  queries: string[];
  results: Array<{ fileId?: string; filename?: string; score?: number; text?: string }>;
}

/** `code_interpreter`: the code run and what it printed or drew. */
export interface AiCodeInterpreterCallResult {
  code: string | null;
  containerId: string;
  outputs: Array<{ type: 'logs'; logs: string } | { type: 'image'; url: string }>;
}

/**
 * `image_generation`: the generated image.
 *
 * `image` holds the raw BYTES between the adapter and the facade ONLY — the
 * facade's hosted-output settler (`runtime/ai-hosted-outputs.ts`) always
 * removes it before a response leaves the runtime, so no API response, SSE
 * frame or `ai_runs.output` row ever carries image data inline.
 * `storageObjectId` is the user-owned storage object the image was persisted
 * as, or `null` when it could not be stored — `storageError` then says why.
 */
export interface AiImageGenerationCallResult {
  storageObjectId: string | null;
  /** Set when the image was generated but could not be stored. */
  storageError?: 'AI_STORAGE_UNAVAILABLE';
  mimeType?: string;
  revisedPrompt?: string;
  size?: string;
  quality?: string;
  image?: AiBinaryPayload;
}

/** `mcp`: one of the three things a remote MCP server contributes to a response. */
export type AiMcpCallResult =
  | {
      kind: 'call';
      serverLabel: string;
      name: string;
      arguments: string;
      output: string | null;
      error: string | null;
    }
  | {
      kind: 'list_tools';
      serverLabel: string;
      tools: Array<{ name: string; description?: string }>;
      error: string | null;
    }
  | { kind: 'approval_request'; serverLabel: string; name: string; arguments: string };

/** Result shape per hosted tool type. */
export interface AiHostedToolResults {
  web_search: AiWebSearchCallResult;
  file_search: AiFileSearchCallResult;
  code_interpreter: AiCodeInterpreterCallResult;
  image_generation: AiImageGenerationCallResult;
  mcp: AiMcpCallResult;
}

/** A provider-executed tool call, discriminated by `tool`. */
export type AiHostedToolCallItem = {
  [T in AiHostedToolType]: {
    type: 'hosted_tool_call';
    /** The provider's id for this output item. */
    id?: string;
    tool: T;
    /** Provider status, e.g. `in_progress`, `searching`, `completed`, `failed`. */
    status: string;
    result?: AiHostedToolResults[T];
  };
}[AiHostedToolType];

export type AiOutputItem =
  | AiMessageOutputItem
  | AiReasoningItem
  | { type: 'function_call'; callId: string; name: string; arguments: string }
  | AiHostedToolCallItem;

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export type AiFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';

export interface AiResponse<T = unknown> {
  id: string;
  provider: string;
  model: string;
  output: AiOutputItem[];
  /** Every `message` item's text, concatenated in order. */
  outputText: string;
  /** Present only when the request carried `structuredOutput`, already validated. */
  parsed?: T;
  usage: AiUsage;
  finishReason: AiFinishReason;
  providerRequestId?: string;
}

/**
 * Streaming events. A well-formed stream starts with `response.created`, ends
 * with exactly one of `response.completed` or `error`, and the concatenation
 * of its `output_text.delta` events equals the completed response's
 * `outputText` (the conformance kit asserts all three).
 */
export type AiStreamEvent =
  | { type: 'response.created'; id: string }
  | { type: 'output_text.delta'; delta: string }
  | { type: 'reasoning_summary.delta'; delta: string }
  | { type: 'function_call.arguments.delta'; callId: string; delta: string }
  | { type: 'output_item.done'; item: AiOutputItem }
  | { type: 'response.completed'; response: AiResponse }
  | { type: 'error'; code: AiErrorCode; message: string };
