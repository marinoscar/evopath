/**
 * `services/memories.ts` (#325) and the chat stream's `memory` frame: the
 * wire calls, and the refusal-to-sentence mapping the page relies on.
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { ApiError } from '../../services/api';
import {
  createMemory,
  deleteAllMemories,
  listMemories,
  memoryCategoryLabel,
  memoryErrorMessage,
  updateMemorySettings,
} from '../../services/memories';
import { parseCoachMemoryFrame, streamCoachChat, type CoachChatMemoryFrame } from '../../services/coach';
import { coachSseBody } from '../mocks/fixtures/coach';
import { mockMemoryListView } from '../mocks/fixtures/memories';

const API = '*/api';

describe('memories service', () => {
  it('lists memories, passing the category filter', async () => {
    let url = '';
    server.use(
      http.get(`${API}/memories`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ data: mockMemoryListView() });
      }),
    );
    expect(await listMemories()).toEqual(mockMemoryListView());
    expect(new URL(url).search).toBe('');
    await listMemories('goal');
    expect(new URL(url).searchParams.get('category')).toBe('goal');
  });

  it('creates, deletes all, and writes preferences under the memory namespace', async () => {
    const seen: Array<{ method: string; path: string; body: unknown }> = [];
    server.use(
      http.post(`${API}/memories`, async ({ request }) => {
        seen.push({ method: 'POST', path: new URL(request.url).pathname, body: await request.json() });
        return HttpResponse.json({ data: { id: 'x' } }, { status: 201 });
      }),
      http.delete(`${API}/memories`, ({ request }) => {
        seen.push({ method: 'DELETE', path: new URL(request.url).pathname, body: null });
        return new HttpResponse(null, { status: 204 });
      }),
      http.patch(`${API}/user-settings`, async ({ request }) => {
        seen.push({ method: 'PATCH', path: new URL(request.url).pathname, body: await request.json() });
        return HttpResponse.json({ data: {} });
      }),
    );
    await createMemory({ content: 'Hi', category: 'other' });
    await deleteAllMemories();
    await updateMemorySettings({ enabled: false });
    expect(seen).toEqual([
      { method: 'POST', path: '/api/memories', body: { content: 'Hi', category: 'other' } },
      { method: 'DELETE', path: '/api/memories', body: null },
      { method: 'PATCH', path: '/api/user-settings', body: { memory: { enabled: false } } },
    ]);
  });

  it('labels unknown categories as Other', () => {
    expect(memoryCategoryLabel('constraint_injury')).toBe('Injuries & limits');
    expect(memoryCategoryLabel('something_new')).toBe('Other');
  });

  describe('memoryErrorMessage', () => {
    it('maps the limit by details.code, top-level code or a bare 409', () => {
      expect(memoryErrorMessage(new ApiError('x', 409, 'CONFLICT', { code: 'MEMORY_LIMIT_REACHED' }), 50)).toMatch(
        /limit of 50 memories/,
      );
      expect(memoryErrorMessage(new ApiError('x', 409, 'MEMORY_LIMIT_REACHED'))).toMatch(/memory limit/);
      expect(memoryErrorMessage(new ApiError('x', 409))).toMatch(/memory limit/);
    });

    it('maps memory being off', () => {
      expect(memoryErrorMessage(new ApiError('x', 403, 'FORBIDDEN', { reason: 'MEMORY_DISABLED' }))).toMatch(
        /Memory is switched off/,
      );
    });

    it('uses the first validation issue on a 400, else the message', () => {
      expect(
        memoryErrorMessage(new ApiError('Validation failed', 400, 'VALIDATION_ERROR', { issues: [{ path: 'content', message: 'Too long' }] })),
      ).toBe('Too long');
      expect(memoryErrorMessage(new ApiError('Bad content', 400))).toBe('Bad content');
    });

    it('maps network failures and server errors', () => {
      expect(memoryErrorMessage(new TypeError('fetch failed'))).toMatch(/Could not reach the server/);
      expect(memoryErrorMessage(new ApiError('x', 500))).toMatch(/went wrong on the server/);
    });
  });
});

describe('coach chat memory frame (#325)', () => {
  it('parses a valid frame and rejects malformed ones', () => {
    expect(parseCoachMemoryFrame({ op: 'added', memoryId: 'm1', content: 'Likes rowing' })).toEqual({
      op: 'added',
      memoryId: 'm1',
      content: 'Likes rowing',
    });
    expect(parseCoachMemoryFrame({ op: 'deleted', memoryId: 'm1' })).toEqual({ op: 'deleted', memoryId: 'm1', content: '' });
    expect(parseCoachMemoryFrame({ op: 'merged', memoryId: 'm1' })).toBeNull();
    expect(parseCoachMemoryFrame({ op: 'added' })).toBeNull();
  });

  it('streamCoachChat hands memory frames to onMemory and ignores unknown frames', async () => {
    server.use(
      http.post(`${API}/coach/chat/stream`, () =>
        new HttpResponse(
          coachSseBody([
            ['delta', { text: 'Noted.' }],
            ['memory', { op: 'added', memoryId: 'm1', content: 'Trains before work' }],
            ['memory', { op: 'bogus' }],
            ['sparkle', { anything: true }],
            ['done', { messageId: 'm', userMessageId: 'u', links: [], pausedUntil: null, fallback: false }],
          ]),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
    );
    const memories: CoachChatMemoryFrame[] = [];
    let done = false;
    await streamCoachChat('remember I train before work', {
      onMemory: (frame) => memories.push(frame),
      onDone: () => {
        done = true;
      },
    });
    expect(memories).toEqual([{ op: 'added', memoryId: 'm1', content: 'Trains before work' }]);
    expect(done).toBe(true);
  });
});
