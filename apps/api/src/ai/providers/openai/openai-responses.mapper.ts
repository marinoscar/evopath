// =============================================================================
// Our Responses types <-> OpenAI Responses API (issue #426, epic #419)
// =============================================================================
//
// Pure functions, no I/O: `toOpenAiRequest` builds the SDK request body from
// an `AiResponseRequest`, `fromOpenAiResponse` turns the SDK's `Response`
// back into an `AiResponse`. The stream mapper reuses both, so a streamed
// and a non-streamed call cannot disagree about what a response means.
//
// STORAGE-OBJECT PARTS (#441). A part naming a `storageObjectId` is mapped
// from `storage` — what the adapter DELIVERED for it (a presigned URL, a
// Files API `file_id`, or an inline `data:` URL) — by the object's MODALITY,
// not the part's type: a stored image is an `input_image` even in a `file`
// part. A storage part with no delivery is AI_INVALID_REQUEST (only the
// runtime resolves storage objects; a direct caller cannot).
//
// REFUSED (AI_CAPABILITY_UNSUPPORTED):
//   - a reasoning `effort` for a model the classifier KNOWS does not reason
//     (or an effort it does not offer). An unclassified model (`null`) is
//     passed through — an administrator may have enabled it knowing more
//     than this table does, and OpenAI's own 400 is then the answer.
//
// HOSTED TOOLS (#442) map one-to-one onto OpenAI's tool entries (`web_search`,
// `file_search`, `code_interpreter`, `image_generation`, `mcp`); their output
// items come back as typed `hosted_tool_call`s, and a message's
// `url_citation` annotations as `citations`. Whether a tool may be used at
// all (model capability, admin switch, MCP host allowlist) is the FACADE's
// gate, not this file's. An MCP tool's `headers` are copied into the body and
// nowhere else — this file never logs or echoes them.
//
// A malformed request (a media part with neither `url` nor
// `storageObjectId`, a non-text part in an assistant message) is
// AI_INVALID_REQUEST instead: nothing a later story adds would make it valid.
// =============================================================================

import type {
  EasyInputMessage,
  FunctionTool,
  ResponseOutputMessage,
  Tool as OpenAiTool,
  Response as OpenAiSdkResponse,
  ResponseCreateParamsBase,
  ResponseInputContent,
  ResponseInputItem,
  ResponseOutputItem,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from 'openai/resources/responses/responses';

import { AiError } from '../../core/ai-error';
import type { AiModelCapabilities } from '../../core/capabilities';
import type { AiStorageInputModality } from '../../core/types/file-inputs.types';
import { parseStructured, toJsonSchema } from '../../core/structured-output';
import type {
  AiContentPart,
  AiFinishReason,
  AiHostedTool,
  AiHostedToolCallItem,
  AiInputItem,
  AiMcpCallResult,
  AiMessageOutputItem,
  AiOutputItem,
  AiResponse,
  AiResponseRequest,
  AiTool,
  AiToolChoice,
  AiUrlCitation,
  AiUsage,
} from '../../core/types/responses.types';
import { mapOpenAiResponseFailure, OPENAI_FAMILY, type OpenAiFamily } from './openai-errors';

/** The request body minus `stream`, which the port sets. */
export type OpenAiRequestBody = Omit<ResponseCreateParamsBase, 'stream'>;

/**
 * How one storage-object input reached OpenAI (#441): a URL OpenAI fetches
 * (presigned, or an inline `data:` URL) or a Files API id. ⚠ `url` may be a
 * presigned URL — it goes into the request body and nowhere else.
 */
export interface OpenAiStorageDelivery {
  modality: AiStorageInputModality;
  filename: string;
  url?: string;
  fileId?: string;
}

/** Deliveries keyed by storage object id. */
export type OpenAiStorageDeliveries = ReadonlyMap<string, OpenAiStorageDelivery>;

/**
 * The provider id stamped on the errors this file raises. Set for the
 * duration of one synchronous `toOpenAiRequest` call (#448) — every helper
 * below is synchronous, so no other call can observe it — rather than
 * threaded through a dozen signatures.
 */
let currentProviderId = OPENAI_FAMILY.providerId;

function unsupported(message: string, details: Record<string, unknown>): AiError {
  return new AiError('AI_CAPABILITY_UNSUPPORTED', message, {
    details: { provider: currentProviderId, ...details },
  });
}

function invalid(message: string, details: Record<string, unknown> = {}): AiError {
  return new AiError('AI_INVALID_REQUEST', message, {
    details: { provider: currentProviderId, ...details },
  });
}

// ---- request ----------------------------------------------------------------

/** `data:` URLs carry inline bytes; OpenAI takes those as `file_data`, not `file_url`. */
function isDataUrl(url: string): boolean {
  return url.startsWith('data:');
}

function toFileContent(url: string, filename: string | undefined): ResponseInputContent {
  return isDataUrl(url)
    ? { type: 'input_file', file_data: url, filename: filename ?? 'file' }
    : { type: 'input_file', file_url: url, ...(filename ? { filename } : {}) };
}

/** A storage-object part, from what the adapter delivered for it. */
function toStorageContentPart(
  part: Extract<AiContentPart, { type: 'image' | 'file' }> & { storageObjectId: string },
  storage: OpenAiStorageDeliveries | undefined,
): ResponseInputContent {
  const delivered = storage?.get(part.storageObjectId);

  if (!delivered || (!delivered.url && !delivered.fileId)) {
    throw invalid('A storage-object input was not resolved by the runtime.', { part: part.type });
  }

  const filename = (part.type === 'file' ? part.filename : undefined) ?? delivered.filename;

  if (delivered.modality === 'image') {
    const detail = (part.type === 'image' ? part.detail : undefined) ?? 'auto';

    return delivered.fileId
      ? { type: 'input_image', file_id: delivered.fileId, detail }
      : { type: 'input_image', image_url: delivered.url as string, detail };
  }

  return delivered.fileId
    ? { type: 'input_file', file_id: delivered.fileId }
    : toFileContent(delivered.url as string, filename);
}

function toContentPart(part: AiContentPart, storage: OpenAiStorageDeliveries | undefined): ResponseInputContent {
  switch (part.type) {
    case 'text':
      return { type: 'input_text', text: part.text };

    case 'image':
      if (part.url) {
        return { type: 'input_image', image_url: part.url, detail: part.detail ?? 'auto' };
      }
      if (part.storageObjectId) {
        return toStorageContentPart({ ...part, storageObjectId: part.storageObjectId }, storage);
      }
      throw invalid('An image part needs a url or a storageObjectId.', { part: 'image' });

    case 'file':
      if (part.url) {
        return toFileContent(part.url, part.filename);
      }
      if (part.storageObjectId) {
        return toStorageContentPart({ ...part, storageObjectId: part.storageObjectId }, storage);
      }
      throw invalid('A file part needs a url or a storageObjectId.', { part: 'file' });
  }
}

/** Every storage object id `req` names, in order, each once. */
export function storageObjectIdsOf(req: AiResponseRequest): string[] {
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

function toInputItem(item: AiInputItem, storage: OpenAiStorageDeliveries | undefined): ResponseInputItem | null {
  if (item.type === 'function_call_output') {
    return { type: 'function_call_output', call_id: item.callId, output: item.output };
  }

  // A replayed call (#446) — the Responses API accepts the model's own
  // `function_call` items as input, so a full-history conversation works here
  // too, not only a chained one.
  if (item.type === 'function_call') {
    return { type: 'function_call', call_id: item.callId, name: item.name, arguments: item.arguments };
  }

  // A replayed reasoning item cannot be sent back: OpenAI needs its own item
  // id (and encrypted content), which the neutral contract does not carry. It
  // is dropped; chaining with `previous_response_id` is how OpenAI keeps its
  // reasoning across turns.
  if (item.type === 'reasoning') {
    return null;
  }

  // The Responses API reads an assistant turn as OUTPUT text, so it cannot
  // carry `input_*` parts; the string form is the one it accepts.
  if (item.role === 'assistant') {
    if (item.content.some((part) => part.type !== 'text')) {
      throw invalid('An assistant message may contain only text parts.', { role: 'assistant' });
    }

    const message: EasyInputMessage = {
      type: 'message',
      role: 'assistant',
      content: item.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    };

    return message;
  }

  const message: EasyInputMessage = {
    type: 'message',
    role: item.role,
    content: item.content.map((part) => toContentPart(part, storage)),
  };

  return message;
}

/** One of our hosted tools as OpenAI's tool entry. */
export function toOpenAiHostedTool(tool: AiHostedTool): OpenAiTool {
  switch (tool.type) {
    case 'web_search':
      return {
        type: 'web_search',
        ...(tool.searchContextSize ? { search_context_size: tool.searchContextSize } : {}),
        ...(tool.userLocation
          ? {
              user_location: {
                type: 'approximate' as const,
                ...(tool.userLocation.country ? { country: tool.userLocation.country.toUpperCase() } : {}),
                ...(tool.userLocation.city ? { city: tool.userLocation.city } : {}),
              },
            }
          : {}),
      };

    case 'file_search':
      return {
        type: 'file_search',
        vector_store_ids: tool.vectorStoreIds,
        ...(tool.maxResults !== undefined ? { max_num_results: tool.maxResults } : {}),
      };

    case 'code_interpreter':
      // OpenAI requires a container; `auto` (a managed one per call) is the only kind modelled.
      return { type: 'code_interpreter', container: { type: 'auto' } };

    case 'image_generation':
      return {
        type: 'image_generation',
        ...(tool.size ? { size: tool.size } : {}),
        ...(tool.quality ? { quality: tool.quality as NonNullable<OpenAiTool.ImageGeneration['quality']> } : {}),
      };

    case 'mcp':
      return {
        type: 'mcp',
        server_label: tool.serverLabel,
        server_url: tool.serverUrl,
        ...(tool.allowedTools ? { allowed_tools: tool.allowedTools } : {}),
        ...(tool.requireApproval ? { require_approval: tool.requireApproval } : {}),
        ...(tool.headers && Object.keys(tool.headers).length > 0 ? { headers: tool.headers } : {}),
      };

    default: {
      const unknown: { type: string } = tool;

      throw unsupported(`Hosted tool "${unknown.type}" is not supported.`, { tool: unknown.type });
    }
  }
}

function toTool(tool: AiTool): FunctionTool | OpenAiTool {
  if (tool.type !== 'function') {
    return toOpenAiHostedTool(tool);
  }

  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: toJsonSchema(tool.parameters),
    strict: tool.strict ?? true,
  };
}

function toToolChoice(choice: AiToolChoice): ToolChoiceOptions | ToolChoiceFunction {
  return typeof choice === 'string' ? choice : { type: 'function', name: choice.name };
}

function toReasoning(
  req: AiResponseRequest,
  caps: AiModelCapabilities | null,
): OpenAiRequestBody['reasoning'] | undefined {
  const reasoning = req.reasoning;

  if (!reasoning || (reasoning.effort === undefined && reasoning.summary === undefined)) {
    return undefined;
  }

  const known = caps !== null;
  const reasons = !known || caps.capabilities.includes('reasoning');

  if (!reasons) {
    // Not a reasoning model: a summary is a harmless no-op, an effort is not.
    if (reasoning.effort !== undefined) {
      throw unsupported(`Model "${req.model}" does not support reasoning effort.`, {
        model: req.model,
        capability: 'reasoning',
      });
    }

    return undefined;
  }

  if (
    reasoning.effort !== undefined &&
    known &&
    caps.reasoningEfforts &&
    !caps.reasoningEfforts.includes(reasoning.effort)
  ) {
    throw unsupported(`Model "${req.model}" does not offer reasoning effort "${reasoning.effort}".`, {
      model: req.model,
      capability: 'reasoning',
      effort: reasoning.effort,
    });
  }

  return {
    ...(reasoning.effort !== undefined ? { effort: reasoning.effort } : {}),
    ...(reasoning.summary !== undefined ? { summary: reasoning.summary } : {}),
  };
}

/**
 * Builds the OpenAI request body for `req`.
 *
 * `caps` is the model's capabilities as classified (or `null` when
 * unclassified); it only gates `reasoning`. `storage` is what the adapter
 * delivered for each storage-object part (#441). `providerOptions.openai` is
 * shallow-merged LAST — the escape hatch for `background`, `store`,
 * `service_tier`, ... — except `stream`, which belongs to the port.
 *
 * Throws `AiError` (never an SDK error): see the file header.
 */
export function toOpenAiRequest(
  req: AiResponseRequest,
  caps: AiModelCapabilities | null,
  storage?: OpenAiStorageDeliveries,
  family: OpenAiFamily = OPENAI_FAMILY,
): OpenAiRequestBody {
  const previous = currentProviderId;

  currentProviderId = family.providerId;

  try {
    return buildOpenAiRequest(req, caps, storage, family);
  } finally {
    currentProviderId = previous;
  }
}

function buildOpenAiRequest(
  req: AiResponseRequest,
  caps: AiModelCapabilities | null,
  storage: OpenAiStorageDeliveries | undefined,
  family: OpenAiFamily,
): OpenAiRequestBody {
  const body: OpenAiRequestBody = {
    model: req.model,
    input:
      typeof req.input === 'string'
        ? req.input
        : req.input
            .map((item) => toInputItem(item, storage))
            .filter((item): item is ResponseInputItem => item !== null),
  };

  if (req.instructions !== undefined) body.instructions = req.instructions;
  if (req.tools && req.tools.length > 0) body.tools = req.tools.map(toTool);
  if (req.toolChoice !== undefined) body.tool_choice = toToolChoice(req.toolChoice);

  if (req.structuredOutput) {
    body.text = {
      format: {
        type: 'json_schema',
        name: req.structuredOutput.name,
        schema: toJsonSchema(req.structuredOutput.schema),
        strict: req.structuredOutput.strict ?? true,
      },
    };
  }

  const reasoning = toReasoning(req, caps);
  if (reasoning) body.reasoning = reasoning;

  if (req.maxOutputTokens !== undefined) body.max_output_tokens = req.maxOutputTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.previousResponseId !== undefined) body.previous_response_id = req.previousResponseId;
  if (req.metadata !== undefined) body.metadata = req.metadata;

  const { stream: _stream, ...escapeHatch } = req.providerOptions?.[family.providerId] ?? {};

  return { ...body, ...(escapeHatch as Partial<OpenAiRequestBody>) };
}

// ---- response ---------------------------------------------------------------

/** A message item: its text parts concatenated, and their url citations re-based onto that text. */
function fromOpenAiMessage(item: ResponseOutputMessage): AiMessageOutputItem {
  let text = '';
  const citations: AiUrlCitation[] = [];

  for (const part of item.content) {
    if (part.type !== 'output_text') continue;

    const offset = text.length;

    for (const annotation of part.annotations ?? []) {
      if (annotation.type !== 'url_citation') continue;

      citations.push({
        url: annotation.url,
        title: annotation.title,
        startIndex: annotation.start_index + offset,
        endIndex: annotation.end_index + offset,
      });
    }

    text += part.text;
  }

  return citations.length > 0 ? { type: 'message', text, citations } : { type: 'message', text };
}

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

/** An MCP error, as one line: its kind and code — a server's own message may echo request detail. */
function mcpError(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === 'string') return error;

  const { type, code } = error as { type?: unknown; code?: unknown };

  return [typeof type === 'string' ? type : 'mcp_error', typeof code === 'number' ? String(code) : '']
    .filter(Boolean)
    .join(' ');
}

function withId(item: AiHostedToolCallItem, id: unknown): AiHostedToolCallItem {
  return typeof id === 'string' && id ? { ...item, id } : item;
}

/**
 * Maps one SDK output item. `null` for an item type this contract does not
 * model (it is dropped, never guessed at).
 *
 * An `image_generation_call`'s base64 `result` is decoded into BYTES here
 * (`result.image`); the facade's hosted-output seam removes them before the
 * response leaves the runtime (see `AiImageGenerationCallResult`).
 */
export function fromOpenAiOutputItem(item: ResponseOutputItem): AiOutputItem | null {
  switch (item.type) {
    case 'message':
      return fromOpenAiMessage(item);

    case 'reasoning':
      return { type: 'reasoning', summary: item.summary.map((part) => part.text) };

    case 'function_call':
      return {
        type: 'function_call',
        callId: item.call_id,
        name: item.name,
        arguments: item.arguments,
      };

    case 'web_search_call': {
      const action = item.action as { type?: string; query?: string; queries?: string[]; sources?: Array<{ url: string }> } | undefined;
      const queries = action?.queries ?? (action?.query ? [action.query] : []);

      return withId(
        {
          type: 'hosted_tool_call',
          tool: 'web_search',
          status: item.status,
          result: { queries, sources: (action?.sources ?? []).map((source) => ({ url: source.url })) },
        },
        item.id,
      );
    }

    case 'file_search_call':
      return withId(
        {
          type: 'hosted_tool_call',
          tool: 'file_search',
          status: item.status,
          result: {
            queries: item.queries ?? [],
            results: (item.results ?? []).map((hit) => ({
              ...(hit.file_id ? { fileId: hit.file_id } : {}),
              ...(hit.filename ? { filename: hit.filename } : {}),
              ...(typeof hit.score === 'number' ? { score: hit.score } : {}),
              ...(hit.text ? { text: hit.text } : {}),
            })),
          },
        },
        item.id,
      );

    case 'code_interpreter_call':
      return withId(
        {
          type: 'hosted_tool_call',
          tool: 'code_interpreter',
          status: item.status,
          result: {
            code: item.code ?? null,
            containerId: item.container_id,
            outputs: (item.outputs ?? []).map((output) =>
              output.type === 'logs'
                ? { type: 'logs' as const, logs: output.logs }
                : { type: 'image' as const, url: output.url },
            ),
          },
        },
        item.id,
      );

    case 'image_generation_call': {
      const format = item.output_format ?? 'png';
      const mimeType = IMAGE_MIME[format] ?? 'image/png';

      return withId(
        {
          type: 'hosted_tool_call',
          tool: 'image_generation',
          status: item.status,
          result: {
            storageObjectId: null,
            mimeType,
            ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
            ...(item.size ? { size: item.size } : {}),
            ...(item.quality ? { quality: item.quality } : {}),
            ...(item.result
              ? { image: { data: new Uint8Array(Buffer.from(item.result, 'base64')), mimeType } }
              : {}),
          },
        },
        item.id,
      );
    }

    case 'mcp_call':
    case 'mcp_list_tools':
    case 'mcp_approval_request': {
      let result: AiMcpCallResult;

      if (item.type === 'mcp_call') {
        result = {
          kind: 'call',
          serverLabel: item.server_label,
          name: item.name,
          arguments: item.arguments,
          output: item.output ?? null,
          error: mcpError(item.error),
        };
      } else if (item.type === 'mcp_list_tools') {
        result = {
          kind: 'list_tools',
          serverLabel: item.server_label,
          tools: item.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
          })),
          error: item.error ?? null,
        };
      } else {
        result = { kind: 'approval_request', serverLabel: item.server_label, name: item.name, arguments: item.arguments };
      }

      const status =
        item.type === 'mcp_call'
          ? item.status ?? (item.error ? 'failed' : 'completed')
          : item.type === 'mcp_list_tools'
            ? item.error
              ? 'failed'
              : 'completed'
            : 'awaiting_approval';

      return withId({ type: 'hosted_tool_call', tool: 'mcp', status, result }, item.id);
    }

    default:
      return null;
  }
}

function hasRefusal(output: ResponseOutputItem[]): boolean {
  return output.some(
    (item) => item.type === 'message' && item.content.some((part) => part.type === 'refusal'),
  );
}

function finishReasonOf(resp: OpenAiSdkResponse, output: AiOutputItem[]): AiFinishReason {
  if (resp.status === 'failed' || resp.status === 'cancelled') return 'error';

  if (resp.status === 'incomplete') {
    return resp.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length';
  }

  if (hasRefusal(resp.output)) return 'content_filter';
  if (output.some((item) => item.type === 'function_call')) return 'tool_calls';

  return 'stop';
}

function usageOf(resp: OpenAiSdkResponse): AiUsage {
  const usage = resp.usage;

  if (!usage) return {};

  const out: AiUsage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };

  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  const cached = usage.input_tokens_details?.cached_tokens;

  if (typeof reasoning === 'number') out.reasoningTokens = reasoning;
  if (typeof cached === 'number') out.cachedInputTokens = cached;

  return out;
}

export interface FromOpenAiResponseOptions {
  /** The originating request; its `structuredOutput` drives `parsed`. */
  request: AiResponseRequest;
  /** The `x-request-id` OpenAI answered with. */
  providerRequestId?: string | null;
  /** Which OpenAI-family provider answered (#448); OpenAI by default. */
  family?: OpenAiFamily;
}

/**
 * Maps a finished SDK `Response` to an `AiResponse`.
 *
 * A `failed` response is an error, not a result: it throws the `AiError` its
 * body's error code means. When the request asked for structured output and
 * the model finished its turn (no pending tool call), the text is validated
 * with `parseStructured` — invalid JSON or a schema mismatch throws
 * `AI_STRUCTURED_OUTPUT_INVALID`.
 */
export function fromOpenAiResponse(
  resp: OpenAiSdkResponse,
  opts: FromOpenAiResponseOptions,
): AiResponse {
  const providerRequestId = opts.providerRequestId ?? undefined;
  const family = opts.family ?? OPENAI_FAMILY;

  if (resp.status === 'failed') {
    throw mapOpenAiResponseFailure(resp.error, providerRequestId, family);
  }

  const output = resp.output
    .map(fromOpenAiOutputItem)
    .filter((item): item is AiOutputItem => item !== null);

  const outputText = output
    .map((item) => (item.type === 'message' ? item.text : ''))
    .join('');

  const finishReason = finishReasonOf(resp, output);

  const result: AiResponse = {
    id: resp.id,
    provider: family.providerId,
    model: resp.model,
    output,
    outputText,
    usage: usageOf(resp),
    finishReason,
  };

  if (providerRequestId) result.providerRequestId = providerRequestId;

  if (opts.request.structuredOutput && finishReason !== 'tool_calls') {
    result.parsed = parseStructured(opts.request.structuredOutput.schema, outputText);
  }

  return result;
}
