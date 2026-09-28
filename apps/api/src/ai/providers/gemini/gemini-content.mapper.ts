// =============================================================================
// Our Responses types <-> Gemini `generateContent` (issue #447, epic #421)
// =============================================================================
//
// Pure functions, no I/O: `toGeminiRequest` builds the SDK parameters from an
// `AiResponseRequest`; `GeminiOutputAssembler` turns response PARTS into our
// output items, and is shared by `create` (`fromGeminiResponse`) and the
// stream mapper, so a streamed and a non-streamed call cannot disagree about
// what a response means.
//
// REQUEST MAPPING
//
//   instructions (+ system/developer messages)  -> `systemInstruction`
//   message (user)          -> user turn: `text`; `inlineData` (base64) for a
//                              `data:` URL or a storage object's bytes;
//                              `fileData { fileUri }` for any other URL
//   message (assistant)     -> model turn, text only
//   function_call           -> model `functionCall { name, args, id? }`
//   function_call_output    -> user `functionResponse { name, response, id? }`
//                              — Gemini keys a response by the function NAME,
//                              which is read off the matching `function_call`
//                              earlier in the (full-history) input
//   reasoning               -> the `thoughtSignature` it carries as provider
//                              state (`AI_PROVIDER_STATE`), put back on the
//                              part it came from (see REPLAY below); a
//                              reasoning item without Gemini state is dropped
//   function tools          -> one tool of `functionDeclarations`
//                              (`parametersJsonSchema`)
//   toolChoice              -> `functionCallingConfig.mode` AUTO | NONE | ANY,
//                              a named function -> ANY + `allowedFunctionNames`
//   reasoning               -> `thinkingConfig { includeThoughts: true, ... }`:
//                              'level' families `thinkingLevel`, 'budget'
//                              families (and unclassified models)
//                              `thinkingBudget` (`GEMINI_THINKING_BUDGETS`)
//   structuredOutput        -> `responseMimeType: 'application/json'` +
//                              `responseJsonSchema`, validated with
//                              `parseStructured`
//   maxOutputTokens / temperature -> the same-named config fields
//
// Consecutive items of the same role merge into one turn, so a replayed round
// (a model turn of text + function calls, then a user turn of all their
// responses) is exactly the alternating shape Gemini requires.
//
// THOUGHTS ARE NEVER EXPOSED RAW. With `includeThoughts`, Gemini returns
// thought SUMMARIES (parts marked `thought: true`); their text becomes a
// reasoning item's `summary`. A part's `thoughtSignature` — Gemini's opaque,
// encrypted reasoning state, required back on a function-call turn by Gemini
// 3 — travels only as symbol-keyed provider state, never in a serialisable
// field.
//
// REPLAY. A signature belongs to one PART, so its reasoning item names the
// part (`GeminiReasoningState.target`):
//
//   'thought'        a thought summary part: replayed as that thought part;
//   'function_call'  the `functionCall` part of `callId`: the signature is put
//                    back on that part when the function call is replayed;
//   'text'           the text part before it: put back on the replayed text.
//
// The signature-only reasoning items ('function_call', 'text') carry an empty
// `summary` — they exist to carry the signature through the tool loop's
// `replayOutput` hop, which keeps reasoning state and nothing else's.
//
// FUNCTION CALL IDS. Gemini 3 names each call; earlier models do not. A call
// without an id gets a synthetic one (`GEMINI_SYNTHETIC_CALL_ID_PREFIX`) so
// the neutral contract's non-empty `callId` holds; a synthetic id is never
// sent back to Gemini (the call and its response are matched by name and
// order, as Gemini itself does for id-less calls).
//
// REFUSED (AI_CAPABILITY_UNSUPPORTED): `previousResponseId` (Gemini stores
// nothing — the facade refuses it first; this is defence in depth), every
// hosted tool (`supportsHostedTools: false`), a reasoning effort on a family
// without thinking, structured output on a family that is not sent a schema,
// and a schema combined with function tools on a family that rejects that
// combination.
//
// NOT MAPPED: `metadata` (the Gemini API has no free-form request metadata) —
// dropped. `providerOptions.gemini` is shallow-merged into the CONFIG last as
// the escape hatch, except `abortSignal`, which belongs to the port.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type {
  Content,
  FinishReason,
  FunctionCall,
  FunctionCallingConfigMode,
  FunctionDeclaration,
  GenerateContentConfig,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  Part,
  ThinkingConfig,
  ThinkingLevel,
  Tool,
  ToolConfig,
} from '@google/genai';

import { AiError } from '../../core/ai-error';
import { parseStructured, toJsonSchema } from '../../core/structured-output';
import type { AiStorageInputModality } from '../../core/types/file-inputs.types';
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
  type AiStreamEvent,
  type AiTool,
  type AiToolChoice,
  type AiUsage,
} from '../../core/types/responses.types';
import { GEMINI_PROVIDER_ID } from './gemini-errors';
import { GEMINI_THINKING_BUDGETS, type GeminiModelProfile } from './gemini-model-catalog';

/** The parameters of one `generateContent` / `generateContentStream` call, minus the signal. */
export interface GeminiRequest {
  model: string;
  contents: Content[];
  config: GenerateContentConfig;
}

/** Which part a replayed `thoughtSignature` belongs on (see REPLAY above). */
export type GeminiSignatureTarget = 'thought' | 'text' | 'function_call';

/** What `AI_PROVIDER_STATE.data` holds for a Gemini reasoning item. */
export interface GeminiReasoningState {
  signature: string;
  target: GeminiSignatureTarget;
  /** `target: 'function_call'` only: the call the signature belongs to. */
  callId?: string;
}

/** The prefix of a call id this adapter made up for an id-less Gemini call. */
export const GEMINI_SYNTHETIC_CALL_ID_PREFIX = 'gemini_call_';

/**
 * How one storage-object input reached Gemini (#441): its bytes, read under
 * the runtime's cap, sent inline. Nothing is uploaded, so nothing is deleted.
 */
export interface GeminiStorageDelivery {
  modality: AiStorageInputModality;
  mimeType: string;
  filename: string;
  data: Uint8Array;
}

/** Deliveries keyed by storage object id. */
export type GeminiStorageDeliveries = ReadonlyMap<string, GeminiStorageDelivery>;

function unsupported(message: string, details: Record<string, unknown> = {}): AiError {
  return new AiError('AI_CAPABILITY_UNSUPPORTED', message, {
    details: { provider: GEMINI_PROVIDER_ID, ...details },
  });
}

function invalid(message: string, details: Record<string, unknown> = {}): AiError {
  return new AiError('AI_INVALID_REQUEST', message, {
    details: { provider: GEMINI_PROVIDER_ID, ...details },
  });
}

// ---- request: content -----------------------------------------------------------

/** `data:<type>;base64,<payload>` -> its parts, or `null` for anything else. */
function parseDataUrl(url: string): { mimeType: string; base64: string } | null {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(url);

  return match ? { mimeType: match[1].trim().toLowerCase(), base64: match[2] } : null;
}

/** File extensions whose MIME type is unambiguous, for a `fileData` URL (Gemini requires one). */
const EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/md',
  html: 'text/html',
  csv: 'text/csv',
  json: 'application/json',
  mp3: 'audio/mp3',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

/** The MIME type a URL's path extension names, or `undefined` (Gemini then decides). */
export function geminiMimeTypeFromUrl(url: string): string | undefined {
  let path: string;

  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }

  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();

  return ext ? EXTENSION_MIME_TYPES[ext] : undefined;
}

function partFromUrl(url: string): Part {
  const data = parseDataUrl(url);

  if (data) return { inlineData: { mimeType: data.mimeType, data: data.base64 } };

  const mimeType = geminiMimeTypeFromUrl(url);

  return { fileData: { fileUri: url, ...(mimeType ? { mimeType } : {}) } };
}

function storagePart(storageObjectId: string, storage: GeminiStorageDeliveries | undefined, kind: 'image' | 'file'): Part {
  const delivered = storage?.get(storageObjectId);

  if (!delivered) {
    throw invalid('A storage-object input was not resolved by the runtime.', { part: kind });
  }

  return { inlineData: { mimeType: delivered.mimeType, data: Buffer.from(delivered.data).toString('base64') } };
}

function toUserPart(part: AiContentPart, storage: GeminiStorageDeliveries | undefined): Part {
  switch (part.type) {
    case 'text':
      return { text: part.text };

    case 'image':
    case 'file':
      if (part.url) return partFromUrl(part.url);
      if (part.storageObjectId) return storagePart(part.storageObjectId, storage, part.type);
      throw invalid(`An ${part.type} part needs a url or a storageObjectId.`, { part: part.type });
  }
}

/** Every storage object id `req` names, in order, each once. */
export function geminiStorageObjectIds(req: AiResponseRequest): string[] {
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

/** The Gemini state an item carries, or `undefined` for another provider's / none. */
export function geminiReasoningState(item: AiReasoningItem): GeminiReasoningState | undefined {
  const state = item[AI_PROVIDER_STATE];

  if (!state || state.provider !== GEMINI_PROVIDER_ID) return undefined;

  const data = state.data as Partial<GeminiReasoningState> | undefined;

  if (!data || typeof data.signature !== 'string' || data.signature.length === 0) return undefined;
  if (data.target !== 'thought' && data.target !== 'text' && data.target !== 'function_call') return undefined;

  return {
    signature: data.signature,
    target: data.target,
    ...(typeof data.callId === 'string' ? { callId: data.callId } : {}),
  };
}

function isSyntheticCallId(callId: string): boolean {
  return callId.startsWith(GEMINI_SYNTHETIC_CALL_ID_PREFIX);
}

function parseArguments(item: Extract<AiInputItem, { type: 'function_call' }>): Record<string, unknown> {
  let value: unknown;

  try {
    value = JSON.parse(item.arguments || '{}');
  } catch {
    throw invalid('A replayed function call carries arguments that are not JSON.', { callId: item.callId });
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('A replayed function call carries arguments that are not a JSON object.', { callId: item.callId });
  }

  return value as Record<string, unknown>;
}

/**
 * A function's output as Gemini's `functionResponse.response` (a JSON object):
 * a JSON object output is sent as-is; anything else — JSON or plain text — is
 * wrapped as `{ output }`, the key Gemini documents for a function's output.
 */
export function geminiFunctionResponse(output: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(output);

    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;

    return { output: value };
  } catch {
    return { output };
  }
}

interface Conversation {
  system: string[];
  contents: Content[];
}

/** Appends parts to the conversation, merging into the previous turn when the role matches. */
function push(conv: Conversation, role: 'user' | 'model', parts: Part[]): void {
  if (parts.length === 0) return;

  const last = conv.contents[conv.contents.length - 1];

  if (last && last.role === role && last.parts) {
    last.parts.push(...parts);
  } else {
    conv.contents.push({ role, parts: [...parts] });
  }
}

/** The last text part of the current model turn, if the conversation ends in one. */
function lastModelTextPart(conv: Conversation): Part | undefined {
  const last = conv.contents[conv.contents.length - 1];

  if (!last || last.role !== 'model' || !last.parts) return undefined;

  for (let i = last.parts.length - 1; i >= 0; i -= 1) {
    const part = last.parts[i];

    if (typeof part.text === 'string' && part.thought !== true) return part;
  }

  return undefined;
}

function toConversation(req: AiResponseRequest, storage: GeminiStorageDeliveries | undefined): Conversation {
  const conv: Conversation = { system: req.instructions ? [req.instructions] : [], contents: [] };

  if (typeof req.input === 'string') {
    push(conv, 'user', [{ text: req.input }]);

    return conv;
  }

  const items = req.input;
  /** Signatures waiting for the `functionCall` part of their call, by call id. */
  const callSignatures = new Map<string, string>();

  items.forEach((item, index) => {
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
            'model',
            item.content
              .map((part) => (part.type === 'text' ? part.text : ''))
              .filter((text) => text.length > 0)
              .map((text): Part => ({ text })),
          );
        } else {
          push(conv, 'user', item.content.map((part) => toUserPart(part, storage)));
        }
        break;

      case 'function_call': {
        const call: FunctionCall = {
          name: item.name,
          args: parseArguments(item),
          ...(isSyntheticCallId(item.callId) ? {} : { id: item.callId }),
        };
        const signature = callSignatures.get(item.callId);

        callSignatures.delete(item.callId);
        push(conv, 'model', [{ functionCall: call, ...(signature ? { thoughtSignature: signature } : {}) }]);
        break;
      }

      case 'function_call_output': {
        // Gemini matches a response to its call by NAME: find the call.
        const call = items
          .slice(0, index)
          .reverse()
          .find((earlier): earlier is Extract<AiInputItem, { type: 'function_call' }> =>
            earlier.type === 'function_call' && earlier.callId === item.callId,
          );

        if (!call) {
          throw invalid(
            'A function_call_output needs its function_call earlier in the input; Gemini stores no conversation.',
            { callId: item.callId },
          );
        }

        push(conv, 'user', [
          {
            functionResponse: {
              name: call.name,
              response: geminiFunctionResponse(item.output),
              ...(isSyntheticCallId(item.callId) ? {} : { id: item.callId }),
            },
          },
        ]);
        break;
      }

      case 'reasoning': {
        const state = geminiReasoningState(item);

        if (!state) break;

        if (state.target === 'function_call' && state.callId) {
          callSignatures.set(state.callId, state.signature);
        } else if (state.target === 'text') {
          const text = lastModelTextPart(conv);

          if (text && !text.thoughtSignature) text.thoughtSignature = state.signature;
        } else if (state.target === 'thought') {
          push(conv, 'model', [{ text: item.summary.join('\n\n'), thought: true, thoughtSignature: state.signature }]);
        }
        break;
      }
    }
  });

  return conv;
}

// ---- request: tools, schema, thinking ---------------------------------------------

function toFunctionDeclaration(tool: AiTool): FunctionDeclaration {
  if (tool.type !== 'function') {
    throw unsupported(`Hosted tool "${tool.type}" is not supported by Gemini.`, { tool: tool.type });
  }

  const schema = toJsonSchema(tool.parameters);

  if (schema.type !== 'object') {
    throw invalid(`Tool "${tool.name}" parameters must be an object schema.`, { tool: tool.name });
  }

  return { name: tool.name, description: tool.description, parametersJsonSchema: schema };
}

function toToolConfig(choice: AiToolChoice): ToolConfig {
  const mode = (value: 'AUTO' | 'NONE' | 'ANY') => value as FunctionCallingConfigMode;

  if (choice === 'auto') return { functionCallingConfig: { mode: mode('AUTO') } };
  if (choice === 'none') return { functionCallingConfig: { mode: mode('NONE') } };
  if (choice === 'required') return { functionCallingConfig: { mode: mode('ANY') } };

  return { functionCallingConfig: { mode: mode('ANY'), allowedFunctionNames: [choice.name] } };
}

/** `req.reasoning` as a `thinkingConfig` for this family — or refused. */
function toThinkingConfig(req: AiResponseRequest, profile: GeminiModelProfile | null): ThinkingConfig | undefined {
  const effort = req.reasoning?.effort;
  const wantsSummary = req.reasoning?.summary !== undefined;

  if (effort === undefined && !wantsSummary) return undefined;

  // An unclassified model is asked with a budget, which every thinking
  // family accepts; an administrator enabled it knowing more than this table,
  // and Gemini's own 400 is then the answer.
  const style = profile?.thinking ?? 'budget';

  if (style === 'none') {
    if (effort !== undefined) {
      throw unsupported(`Model "${req.model}" does not support reasoning effort.`, {
        model: req.model,
        capability: 'reasoning',
      });
    }

    // A summary asked of a model that does not think: nothing to summarise.
    return undefined;
  }

  const config: ThinkingConfig = { includeThoughts: true };

  if (effort !== undefined) {
    if (style === 'level' && profile?.thinkingLevels) {
      config.thinkingLevel = profile.thinkingLevels[effort] as ThinkingLevel;
    } else {
      config.thinkingBudget = GEMINI_THINKING_BUDGETS[effort];
    }
  }

  return config;
}

/**
 * Builds the Gemini request for `req`.
 *
 * `profile` is the model's classifier profile (or `null` when unclassified);
 * `storage` is what the adapter delivered for each storage-object part.
 * Throws `AiError` (never an SDK error): see the file header.
 */
export function toGeminiRequest(
  req: AiResponseRequest,
  profile: GeminiModelProfile | null,
  storage?: GeminiStorageDeliveries,
): GeminiRequest {
  if (req.previousResponseId !== undefined) {
    throw unsupported('Gemini does not store responses; send the conversation history as input instead.', {
      capability: 'previous_response_id',
    });
  }

  if (profile?.kind === 'embedding') {
    throw unsupported(`Model "${req.model}" is an embedding model and cannot generate responses.`, {
      model: req.model,
      capability: 'responses',
    });
  }

  const conv = toConversation(req, storage);

  if (conv.contents.length === 0) {
    throw invalid('The request has no user or assistant content.');
  }

  const declarations = (req.tools ?? []).map(toFunctionDeclaration);
  const config: GenerateContentConfig = {};

  if (conv.system.length > 0) config.systemInstruction = { parts: [{ text: conv.system.join('\n\n') }] };

  if (declarations.length > 0) config.tools = [{ functionDeclarations: declarations } satisfies Tool];
  if (req.toolChoice !== undefined) config.toolConfig = toToolConfig(req.toolChoice);

  const thinkingConfig = toThinkingConfig(req, profile);

  if (thinkingConfig) config.thinkingConfig = thinkingConfig;

  if (req.structuredOutput) {
    if (profile && !profile.structuredOutput) {
      throw unsupported(`Model "${req.model}" does not support structured output.`, {
        model: req.model,
        capability: 'structured_output',
      });
    }
    if (profile && !profile.structuredWithTools && declarations.length > 0) {
      throw unsupported(`Model "${req.model}" cannot combine structured output with function tools.`, {
        model: req.model,
        capability: 'structured_output',
      });
    }

    config.responseMimeType = 'application/json';
    config.responseJsonSchema = toJsonSchema(req.structuredOutput.schema);
  }

  if (req.maxOutputTokens !== undefined) config.maxOutputTokens = req.maxOutputTokens;
  if (req.temperature !== undefined) config.temperature = req.temperature;

  const { abortSignal: _signal, ...escapeHatch } = (req.providerOptions?.[GEMINI_PROVIDER_ID] ?? {}) as Partial<
    GenerateContentConfig
  >;

  return { model: req.model, contents: conv.contents, config: { ...config, ...escapeHatch } };
}

// ---- response ------------------------------------------------------------------------

function reasoningItem(summary: string[], state: GeminiReasoningState | undefined): AiReasoningItem {
  if (!state) return { type: 'reasoning', summary };

  const providerState: AiProviderState = { provider: GEMINI_PROVIDER_ID, data: { ...state } };

  return { type: 'reasoning', summary, [AI_PROVIDER_STATE]: providerState };
}

type OpenItem = { kind: 'text' | 'thought'; text: string; signature?: string };

/**
 * Turns response parts into our output items, in order — incrementally, so
 * the stream mapper can emit deltas as parts arrive, and `create` feeds it a
 * whole response at once. Consecutive text parts are ONE message item and
 * consecutive thought parts ONE reasoning item (a stream splits one logical
 * part across many chunks); a function call closes whatever is open.
 */
export class GeminiOutputAssembler {
  readonly items: AiOutputItem[] = [];
  private open: OpenItem | null = null;
  private pendingSignature: string | undefined;

  /** Consumes one part; returns the deltas and completed items it produced. */
  push(part: Part): AiStreamEvent[] {
    const events: AiStreamEvent[] = [];

    if (part.functionCall) {
      events.push(...this.close());
      events.push(...this.functionCall(part.functionCall, part.thoughtSignature));

      return events;
    }

    if (typeof part.text !== 'string') {
      // A signature-only part, or a part kind this adapter never asks for
      // (executable code, inline media output): only its signature matters.
      if (part.thoughtSignature) this.attachSignature(part.thoughtSignature);

      return events;
    }

    const kind: OpenItem['kind'] = part.thought === true ? 'thought' : 'text';

    if (part.text.length === 0) {
      if (part.thoughtSignature) this.attachSignature(part.thoughtSignature);

      return events;
    }

    if (!this.open || this.open.kind !== kind) {
      events.push(...this.close());
      this.open = { kind, text: '' };

      if (this.pendingSignature) {
        this.open.signature = this.pendingSignature;
        this.pendingSignature = undefined;
      }
    }

    this.open.text += part.text;
    if (part.thoughtSignature) this.open.signature = part.thoughtSignature;

    events.push(
      kind === 'thought'
        ? { type: 'reasoning_summary.delta', delta: part.text }
        : { type: 'output_text.delta', delta: part.text },
    );

    return events;
  }

  /** Closes whatever is open; call once, after the last part. */
  finish(): AiStreamEvent[] {
    const events = this.close();

    if (this.pendingSignature) {
      events.push(this.done(reasoningItem([], { signature: this.pendingSignature, target: 'text' })));
      this.pendingSignature = undefined;
    }

    return events;
  }

  private attachSignature(signature: string): void {
    if (this.open && !this.open.signature) {
      this.open.signature = signature;
    } else {
      this.pendingSignature = signature;
    }
  }

  private done(item: AiOutputItem): AiStreamEvent {
    this.items.push(item);

    return { type: 'output_item.done', item };
  }

  private close(): AiStreamEvent[] {
    const open = this.open;

    if (!open) return [];

    this.open = null;

    if (open.kind === 'thought') {
      return [
        this.done(
          reasoningItem(
            open.text.length > 0 ? [open.text] : [],
            open.signature ? { signature: open.signature, target: 'thought' } : undefined,
          ),
        ),
      ];
    }

    const events = [this.done({ type: 'message', text: open.text })];

    if (open.signature) events.push(this.done(reasoningItem([], { signature: open.signature, target: 'text' })));

    return events;
  }

  private functionCall(call: FunctionCall, signature: string | undefined): AiStreamEvent[] {
    const callId = call.id && call.id.length > 0 ? call.id : `${GEMINI_SYNTHETIC_CALL_ID_PREFIX}${randomUUID()}`;
    const args = JSON.stringify(call.args ?? {});
    const events: AiStreamEvent[] = [];
    const sig = signature ?? this.pendingSignature;

    this.pendingSignature = undefined;

    if (sig) events.push(this.done(reasoningItem([], { signature: sig, target: 'function_call', callId })));

    events.push({ type: 'function_call.arguments.delta', callId, delta: args });
    events.push(this.done({ type: 'function_call', callId, name: call.name ?? '', arguments: args }));

    return events;
  }
}

/** Usage, normalised: output includes thinking tokens, as OpenAI's and Anthropic's do. */
export function geminiUsage(usage: GenerateContentResponseUsageMetadata | null | undefined): AiUsage {
  if (!usage) return {};

  const out: AiUsage = {};
  const prompt = usage.promptTokenCount;
  const toolPrompt = usage.toolUsePromptTokenCount ?? 0;
  const candidates = usage.candidatesTokenCount;
  const thoughts = usage.thoughtsTokenCount;

  if (typeof prompt === 'number') out.inputTokens = prompt + toolPrompt;
  if (typeof candidates === 'number' || typeof thoughts === 'number') {
    out.outputTokens = (candidates ?? 0) + (thoughts ?? 0);
  }
  if (typeof thoughts === 'number') out.reasoningTokens = thoughts;
  if (typeof usage.cachedContentTokenCount === 'number') out.cachedInputTokens = usage.cachedContentTokenCount;

  return out;
}

const CONTENT_FILTER_REASONS = new Set<string>([
  'SAFETY',
  'RECITATION',
  'LANGUAGE',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
]);

const ERROR_REASONS = new Set<string>([
  'MALFORMED_FUNCTION_CALL',
  'UNEXPECTED_TOOL_CALL',
  'TOO_MANY_TOOL_CALLS',
  'OTHER',
  'IMAGE_OTHER',
  'NO_IMAGE',
]);

/** Our finish reason for Gemini's (a candidate's `finishReason`, or a blocked prompt). */
export function geminiFinishReason(
  finishReason: FinishReason | string | null | undefined,
  output: AiOutputItem[],
  promptBlocked = false,
): AiFinishReason {
  if (promptBlocked) return 'content_filter';

  const reason = finishReason ?? '';

  if (reason === 'MAX_TOKENS') return 'length';
  if (CONTENT_FILTER_REASONS.has(reason)) return 'content_filter';
  if (ERROR_REASONS.has(reason)) return 'error';

  // STOP, unspecified, or not yet reported.
  return output.some((item) => item.type === 'function_call') ? 'tool_calls' : 'stop';
}

export interface GeminiResponseParts {
  id: string;
  model: string;
  output: AiOutputItem[];
  finishReason: FinishReason | string | null | undefined;
  promptBlocked: boolean;
  usage: AiUsage;
}

/**
 * The `AiResponse` for mapped parts — shared by `create` and the stream. When
 * the request asked for structured output and the model finished its turn,
 * the text is validated with `parseStructured` (a mismatch throws
 * `AI_STRUCTURED_OUTPUT_INVALID`); a filtered answer to a structured request
 * throws `AI_CONTENT_FILTERED`, since there is nothing to parse.
 */
export function finishGeminiResponse(parts: GeminiResponseParts, request: AiResponseRequest): AiResponse {
  const outputText = parts.output.map((item) => (item.type === 'message' ? item.text : '')).join('');
  const finishReason = geminiFinishReason(parts.finishReason, parts.output, parts.promptBlocked);

  const result: AiResponse = {
    id: parts.id,
    provider: GEMINI_PROVIDER_ID,
    model: parts.model,
    output: parts.output,
    outputText,
    usage: parts.usage,
    finishReason,
  };

  if (request.structuredOutput && finishReason !== 'tool_calls') {
    if (finishReason === 'content_filter') {
      throw new AiError('AI_CONTENT_FILTERED', 'Gemini blocked the response to a structured-output request.', {
        details: { provider: GEMINI_PROVIDER_ID },
      });
    }

    result.parsed = parseStructured(request.structuredOutput.schema, outputText);
  }

  return result;
}

/** An id for a response Gemini did not name. */
export function geminiFallbackResponseId(): string {
  return `gemini-${randomUUID()}`;
}

/** Maps a finished `GenerateContentResponse` to an `AiResponse`. */
export function fromGeminiResponse(response: GenerateContentResponse, request: AiResponseRequest): AiResponse {
  const candidate = response.candidates?.[0];
  const assembler = new GeminiOutputAssembler();

  for (const part of candidate?.content?.parts ?? []) assembler.push(part);
  assembler.finish();

  return finishGeminiResponse(
    {
      id: response.responseId || geminiFallbackResponseId(),
      model: response.modelVersion || request.model,
      output: assembler.items,
      finishReason: candidate?.finishReason,
      promptBlocked: !candidate && Boolean(response.promptFeedback?.blockReason),
      usage: geminiUsage(response.usageMetadata),
    },
    request,
  );
}
