// =============================================================================
// Replaying a conversation as input (issue #446, epic #421)
// =============================================================================
//
// A provider that cannot chain with `previousResponseId`
// (`AiProviderAdapter.supportsPreviousResponseId: false`) is sent the whole
// conversation every time. These two helpers are the one definition of what
// "the conversation so far" is as `AiInputItem`s — shared by the runtime's
// tool loop and the conformance kit, so both replay a turn identically.
// =============================================================================

import { AI_PROVIDER_STATE, type AiInputItem, type AiOutputItem, type AiResponseRequest } from './types/responses.types';

/** A request's `input` as items: a bare string is one user message. */
export function asInputItems(input: AiResponseRequest['input']): AiInputItem[] {
  return typeof input === 'string'
    ? [{ type: 'message', role: 'user', content: [{ type: 'text', text: input }] }]
    : [...input];
}

/**
 * One response's output as the input items that replay it (#446). A
 * `reasoning` item keeps its symbol-keyed provider state — the reason it is
 * copied with a spread rather than rebuilt field by field.
 */
export function replayOutput(output: AiOutputItem[]): AiInputItem[] {
  const items: AiInputItem[] = [];

  for (const item of output) {
    switch (item.type) {
      case 'message':
        if (item.text.length > 0) {
          items.push({ type: 'message', role: 'assistant', content: [{ type: 'text', text: item.text }] });
        }
        break;

      case 'function_call':
        items.push({ type: 'function_call', callId: item.callId, name: item.name, arguments: item.arguments });
        break;

      case 'reasoning': {
        const state = item[AI_PROVIDER_STATE];

        items.push({ type: 'reasoning', summary: [...item.summary], ...(state ? { [AI_PROVIDER_STATE]: state } : {}) });
        break;
      }

      default:
        // hosted_tool_call: executed by the provider inside that response; not replayable.
        break;
    }
  }

  return items;
}
