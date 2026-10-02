import { HttpException } from '@nestjs/common';
import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import { MEMORY_CATEGORIES, MEMORY_CONTENT_MAX, MEMORY_REASONS, MEMORY_SENSITIVITIES } from '../../../memory/memory.constants';
import type { CoachChatToolDeps, CoachChatTurnActions } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';

// =============================================================================
// The coach chat's memory tools (#325; docs/specs/ai-memory.md §2.4)
// =============================================================================
//
//   remember({ content, category, sensitivity })   store one fact (`explicit`)
//   forget({ memoryId, query })                    soft-delete one memory
//   update_memory({ memoryId, content })           correct one memory
//
// Registered only while memory is on for the user (system and user
// switches). Every write goes through `MemoryService` (validation: no
// instruction, URL, email, code, secret, financial, phone or third-party
// data; the health switch; dedup; the cap), which answers a refusal the
// model can relay or rephrase.
//
// NO INTERNAL ID REACHES THE MODEL. The memory block in the instructions
// numbers each memory `[m1]`, `[m2]`, ... and `memoryId` is that ref
// (`MemoryRefs`, per turn); a memory added this turn gets the next ref. The
// memory's real id goes only to the client, in the `memory` SSE frame
// (`actions.memoryEvents`), so the chat can offer Undo.
//
// ⚠ No memory text is logged, counted or put on a span.
// =============================================================================

export const COACH_CHAT_MEMORY_TOOL_NAMES = ['remember', 'forget', 'update_memory'] as const;

function refusal(err: unknown) {
  if (err instanceof HttpException) {
    const response = err.getResponse() as { message?: unknown; details?: { reason?: unknown; rule?: unknown } };
    const reason = typeof response?.details?.reason === 'string' ? response.details.reason : 'MEMORY_REFUSED';
    return {
      ok: false,
      error: reason,
      ...(typeof response?.details?.rule === 'string' ? { rule: response.details.rule } : {}),
      message: typeof response?.message === 'string' ? response.message : 'The memory was not saved.',
    };
  }
  return TOOL_UNAVAILABLE;
}

const NOT_FOUND = {
  ok: false,
  error: MEMORY_REASONS.NOT_FOUND,
  message: 'No matching memory. Tell the user you could not find it; do not guess.',
};

export function createRememberTool(deps: CoachChatToolDeps, actions: CoachChatTurnActions) {
  return defineTool({
    name: 'remember',
    description:
      'Remember one short, lasting fact about the user for future conversations and plans. Call it when the user ' +
      'asks you to remember something, or states a durable preference or fact about themselves (the name they want ' +
      'to be called, their schedule, equipment, an injury their training must respect, how they like to be coached). ' +
      'Write ONE sentence starting with "User" (e.g. "User prefers to be called Bobby."). Never store something the ' +
      'user did not say, a secret, money, contact details or another person\'s details. Returns the memory\'s ref.',
    parameters: z.object({
      content: z.string().describe(`One sentence starting with "User", at most ${MEMORY_CONTENT_MAX} characters.`),
      category: z.enum(MEMORY_CATEGORIES).describe('What the fact is about.'),
      sensitivity: z
        .enum(MEMORY_SENSITIVITIES)
        .nullable()
        .describe('"health" for an injury, condition or other health matter; null otherwise.'),
    }),
    execute: async ({ content, category, sensitivity }, ctx) => {
      const memory = deps.memory;
      if (!memory) return TOOL_UNAVAILABLE;
      try {
        const result = await memory.service.write(
          ctx.userId,
          { content, category, sensitivity: sensitivity ?? null, source: 'explicit' },
          'agent',
        );
        const ref = memory.refs.refFor(result.memory.id);
        if (result.op !== 'unchanged') {
          (actions.memoryEvents ??= []).push({ op: result.op, memoryId: result.memory.id, content: result.memory.content });
        }
        return {
          ok: true,
          op: result.op === 'unchanged' ? 'already_remembered' : result.op,
          memoryRef: ref,
          content: result.memory.content,
        };
      } catch (err) {
        return refusal(err);
      }
    },
  });
}

export function createForgetTool(deps: CoachChatToolDeps, actions: CoachChatTurnActions) {
  return defineTool({
    name: 'forget',
    description:
      'Forget one remembered fact when the user asks you to. Pass memoryId, the [m<n>] ref from your memory notes, ' +
      'or, when you do not know it, a short query describing the fact (pass null for the other). Returns what was forgotten.',
    parameters: z.object({
      memoryId: z.string().nullable().describe('The memory ref, e.g. "m3", or null.'),
      query: z.string().nullable().describe('A few words describing the fact to forget, or null.'),
    }),
    execute: async ({ memoryId, query }, ctx) => {
      const memory = deps.memory;
      if (!memory) return TOOL_UNAVAILABLE;
      try {
        let id = memory.refs.resolve(memoryId);
        if (!id && query && query.trim().length > 0) {
          const match = await memory.service.findBestMatch(ctx.userId, query);
          id = match?.id ?? null;
        }
        if (!id) return NOT_FOUND;
        const deleted = await memory.service.softDelete(ctx.userId, id);
        (actions.memoryEvents ??= []).push({ op: 'deleted', memoryId: deleted.id, content: deleted.content });
        return { ok: true, op: 'deleted', memoryRef: memory.refs.refFor(deleted.id), content: deleted.content };
      } catch (err) {
        if (err instanceof HttpException && err.getStatus() === 404) return NOT_FOUND;
        return refusal(err);
      }
    },
  });
}

export function createUpdateMemoryTool(deps: CoachChatToolDeps, actions: CoachChatTurnActions) {
  return defineTool({
    name: 'update_memory',
    description:
      'Correct one remembered fact when the user says it changed. Pass memoryId, the [m<n>] ref from your memory ' +
      'notes, and the new fact as one sentence starting with "User". Returns the updated memory.',
    parameters: z.object({
      memoryId: z.string().describe('The memory ref, e.g. "m3".'),
      content: z.string().describe(`The corrected fact, at most ${MEMORY_CONTENT_MAX} characters.`),
    }),
    execute: async ({ memoryId, content }, ctx) => {
      const memory = deps.memory;
      if (!memory) return TOOL_UNAVAILABLE;
      const id = memory.refs.resolve(memoryId);
      if (!id) return NOT_FOUND;
      try {
        const updated = await memory.service.update(ctx.userId, id, { content }, 'agent');
        (actions.memoryEvents ??= []).push({ op: 'updated', memoryId: updated.id, content: updated.content });
        return { ok: true, op: 'updated', memoryRef: memory.refs.refFor(updated.id), content: updated.content };
      } catch (err) {
        if (err instanceof HttpException && err.getStatus() === 404) return NOT_FOUND;
        return refusal(err);
      }
    },
  });
}
