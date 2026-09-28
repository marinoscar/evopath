// =============================================================================
// OpenAI Responses stream events -> AiStreamEvent (issue #426, epic #419)
// =============================================================================
//
// One `OpenAiStreamMapper` per stream: it is stateful because OpenAI's
// `response.function_call_arguments.delta` names the OUTPUT ITEM (`item_id`)
// while our event names the CALL (`callId`), and the pairing is only
// announced once, by that item's `response.output_item.added`.
//
// Event mapping (anything else is dropped):
//
//   response.created                        -> response.created
//   response.output_text.delta              -> output_text.delta
//   response.reasoning_summary_text.delta   -> reasoning_summary.delta
//   response.function_call_arguments.delta  -> function_call.arguments.delta
//   response.output_item.done               -> output_item.done
//   response.completed | response.incomplete-> response.completed
//   response.failed | error                 -> error
//
// HOSTED TOOL PROGRESS (#442). `response.web_search_call.*`,
// `response.file_search_call.*`, `response.code_interpreter_call.*` (and its
// `_code.delta`), `response.image_generation_call.*` (partial images
// included), `response.mcp_call.*` and `response.mcp_list_tools.*` carry only
// an item id and a phase — no result. They are consumed here on purpose: each
// hosted call surfaces ONCE, as the `output_item.done` its own
// `response.output_item.done` produces, carrying the same typed
// `hosted_tool_call` (status + result) `create` returns. Likewise
// `response.output_text.annotation.added`: citations arrive on the message's
// `output_item.done` and on the completed response.
//
// `response.incomplete` is terminal too (the turn hit `max_output_tokens` or
// a content filter): it completes with `finishReason` `length` /
// `content_filter`, exactly as the same response would from `create`.
//
// The completed response is built by `fromOpenAiResponse`, the same function
// `create` uses, so structured-output validation happens identically; if it
// fails, the stream ends with an `error` event carrying that code instead.
//
// Error events carry OUR generic message for the code, never OpenAI's text.
// =============================================================================

import type { ResponseStreamEvent } from 'openai/resources/responses/responses';

import { AiError } from '../../core/ai-error';
import type { AiResponseRequest, AiStreamEvent } from '../../core/types/responses.types';
import {
  classifyOpenAiErrorCode,
  mapOpenAiResponseFailure,
  OPENAI_FAMILY,
  type OpenAiFamily,
  openAiErrorMessage,
} from './openai-errors';
import { fromOpenAiOutputItem, fromOpenAiResponse } from './openai-responses.mapper';

export interface OpenAiStreamMapperOptions {
  request: AiResponseRequest;
  providerRequestId?: string | null;
  /** Which OpenAI-family provider is streaming (#448); OpenAI by default. */
  family?: OpenAiFamily;
}

function errorEvent(err: AiError): AiStreamEvent {
  return { type: 'error', code: err.code, message: err.message };
}

export class OpenAiStreamMapper {
  private readonly callIds = new Map<string, string>();
  private startedFlag = false;
  private terminalFlag = false;

  constructor(private readonly opts: OpenAiStreamMapperOptions) {}

  private get family(): OpenAiFamily {
    return this.opts.family ?? OPENAI_FAMILY;
  }

  /** Whether `response.created` has been emitted. */
  get started(): boolean {
    return this.startedFlag;
  }

  /** Whether a terminal event (`response.completed` or `error`) has been emitted. */
  get terminated(): boolean {
    return this.terminalFlag;
  }

  /** Maps one SDK event to zero or more of ours. Nothing is emitted after a terminal event. */
  map(event: ResponseStreamEvent): AiStreamEvent[] {
    if (this.terminalFlag) return [];

    switch (event.type) {
      case 'response.created':
        if (this.startedFlag) return [];
        this.startedFlag = true;

        return [{ type: 'response.created', id: event.response.id }];

      case 'response.output_text.delta':
        return event.delta ? [{ type: 'output_text.delta', delta: event.delta }] : [];

      case 'response.reasoning_summary_text.delta':
        return event.delta ? [{ type: 'reasoning_summary.delta', delta: event.delta }] : [];

      case 'response.output_item.added':
        if (event.item.type === 'function_call' && event.item.id) {
          this.callIds.set(event.item.id, event.item.call_id);
        }

        return [];

      case 'response.function_call_arguments.delta':
        return event.delta
          ? [
              {
                type: 'function_call.arguments.delta',
                callId: this.callIds.get(event.item_id) ?? event.item_id,
                delta: event.delta,
              },
            ]
          : [];

      case 'response.output_item.done': {
        const item = fromOpenAiOutputItem(event.item);

        return item ? [{ type: 'output_item.done', item }] : [];
      }

      case 'response.completed':
      case 'response.incomplete':
        return this.complete(event.response);

      case 'response.failed':
        return this.fail(
          mapOpenAiResponseFailure(event.response.error, this.opts.providerRequestId ?? undefined, this.family),
        );

      case 'error': {
        const code = classifyOpenAiErrorCode(event.code);

        return this.fail(
          new AiError(code, openAiErrorMessage(code, this.family), { details: { provider: this.family.providerId } }),
        );
      }

      default:
        return [];
    }
  }

  /** Ends the stream with an `error` event for `err` (idempotent). */
  fail(err: AiError): AiStreamEvent[] {
    if (this.terminalFlag) return [];
    this.terminalFlag = true;

    return [errorEvent(err)];
  }

  private complete(response: Parameters<typeof fromOpenAiResponse>[0]): AiStreamEvent[] {
    let mapped;

    try {
      mapped = fromOpenAiResponse(response, {
        request: this.opts.request,
        providerRequestId: this.opts.providerRequestId,
        family: this.family,
      });
    } catch (err) {
      return this.fail(AiError.wrap(err));
    }

    this.terminalFlag = true;

    return [{ type: 'response.completed', response: mapped }];
  }
}
