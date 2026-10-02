/**
 * The `/coach` page's service calls (E7.8, #248): the timeline query, the
 * E7.5 signals, the chat stream's frame parsing and refusal classification,
 * and the defensive readers of `data`.
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { ApiError } from '../../services/api';
import {
  COACH_AUDIO_MESSAGES,
  coachAudioFailureOf,
  coachSpeechEnabled,
  getCoachMessageAudio,
  requestCoachMessageAudio,
  coachChatFailureOf,
  coachDisplayText,
  coachMessageData,
  coachToolLabel,
  getCoachMessages,
  getCoachState,
  isCoachMessageId,
  markCoachMessageOpened,
  setCoachMessageFeedback,
  streamCoachChat,
} from '../../services/coach';
import {
  coachMessageId,
  coachSseBody,
  mockCoachAudioPending,
  mockCoachAudioReady,
  mockCoachSettingsView,
  mockCoachState,
} from '../mocks/fixtures/coach';

const API = '*/api';

describe('coach page services', () => {
  it('reads the state', async () => {
    expect(await getCoachState()).toEqual(mockCoachState());
  });

  it('pages the timeline with before and limit', async () => {
    let url = '';
    server.use(
      http.get(`${API}/coach/messages`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ data: { items: [], nextCursor: null } });
      }),
    );
    await getCoachMessages({ before: coachMessageId(5), limit: 10 });
    const params = new URL(url).searchParams;
    expect(params.get('before')).toBe(coachMessageId(5));
    expect(params.get('limit')).toBe('10');
  });

  it('posts opened and feedback to the message routes', async () => {
    const seen: Array<[string, unknown]> = [];
    server.use(
      http.post(`${API}/coach/messages/:id/:action`, async ({ params, request }) => {
        const text = await request.text();
        seen.push([`${String(params.action)}:${String(params.id)}`, text ? JSON.parse(text) : null]);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await markCoachMessageOpened(coachMessageId(1));
    await setCoachMessageFeedback(coachMessageId(1), 'down');
    await setCoachMessageFeedback(coachMessageId(1), null);
    expect(seen).toEqual([
      [`opened:${coachMessageId(1)}`, null],
      [`feedback:${coachMessageId(1)}`, { feedback: 'down' }],
      [`feedback:${coachMessageId(1)}`, { feedback: null }],
    ]);
  });

  it('streams every frame type to its handler', async () => {
    server.use(
      http.post(`${API}/coach/chat/stream`, () =>
        new HttpResponse(
          coachSseBody([
            ['safety', { level: 'conservative', screen: 'pain' }],
            ['tool', { name: 'get_check_ins', status: 'ok' }],
            ['delta', { text: 'Easy ' }],
            ['delta', { text: 'does it.' }],
            ['done', { messageId: 'm', userMessageId: 'u', links: [{ label: 'Go', href: '/train' }, { label: 'X', href: '//evil' }], pausedUntil: null, fallback: true }],
          ]),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
    );
    const events: unknown[] = [];
    await streamCoachChat('my knee hurts', {
      onSafety: (f) => events.push(['safety', f]),
      onTool: (f) => events.push(['tool', f]),
      onDelta: (t) => events.push(['delta', t]),
      onDone: (f) => events.push(['done', f]),
    });
    expect(events).toEqual([
      ['safety', { level: 'conservative', screen: 'pain' }],
      ['tool', { name: 'get_check_ins', status: 'ok' }],
      ['delta', 'Easy '],
      ['delta', 'does it.'],
      ['done', { messageId: 'm', userMessageId: 'u', links: [{ label: 'Go', href: '/train' }], pausedUntil: null, fallback: true, profileUpdated: false }],
    ]);
  });

  it('reads profileUpdated on the done frame only when it is literally true (#327)', async () => {
    const dones: Array<Record<string, unknown>> = [];
    for (const profileUpdated of [true, 'true', undefined]) {
      server.use(
        http.post(`${API}/coach/chat/stream`, () =>
          new HttpResponse(
            coachSseBody([
              ['done', { messageId: 'm', userMessageId: 'u', links: [], pausedUntil: null, fallback: false, ...(profileUpdated === undefined ? {} : { profileUpdated }) }],
            ]),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
        ),
      );
      await streamCoachChat('call me Sam', { onDone: (f) => dones.push({ ...f }) });
    }
    expect(dones.map((d) => d.profileUpdated)).toEqual([true, false, false]);
  });

  it('sends retryOf only when given, and reads the error frame\'s stored user message id', async () => {
    const bodies: unknown[] = [];
    let frames: Array<[string, unknown]> = [['error', { code: 'AI_PROVIDER_ERROR', message: 'Failed', userMessageId: 'u1' }]];
    server.use(
      http.post(`${API}/coach/chat/stream`, async ({ request }) => {
        bodies.push(await request.json());
        return new HttpResponse(coachSseBody(frames), { headers: { 'Content-Type': 'text/event-stream' } });
      }),
    );
    const errors: unknown[] = [];
    await streamCoachChat('hi', { onError: (f) => errors.push(f) });
    await streamCoachChat('hi', { onError: (f) => errors.push(f) }, undefined, { retryOf: 'u1' });
    frames = [['error', { code: 'AI_PROVIDER_ERROR', message: 'Failed' }]];
    await streamCoachChat('hi', { onError: (f) => errors.push(f) }, undefined, { retryOf: null });
    expect(bodies).toEqual([{ text: 'hi' }, { text: 'hi', retryOf: 'u1' }, { text: 'hi' }]);
    expect(errors).toEqual([
      { code: 'AI_PROVIDER_ERROR', message: 'Failed', userMessageId: 'u1' },
      { code: 'AI_PROVIDER_ERROR', message: 'Failed', userMessageId: 'u1' },
      { code: 'AI_PROVIDER_ERROR', message: 'Failed', userMessageId: null },
    ]);
  });

  it('rejects with ApiError on a refusal before the stream', async () => {
    server.use(
      http.post(`${API}/coach/chat/stream`, () =>
        HttpResponse.json({ message: 'off', details: { code: 'COACH_DISABLED' } }, { status: 403 }),
      ),
    );
    await expect(streamCoachChat('hi', {})).rejects.toBeInstanceOf(ApiError);
  });

  it('classifies refusals', () => {
    expect(coachChatFailureOf(new ApiError('x', 403, 'FORBIDDEN', { code: 'COACH_DISABLED' })).kind).toBe('disabled');
    expect(coachChatFailureOf(new ApiError('x', 409, 'CONFLICT', { reason: 'AI_FEATURE_UNAVAILABLE' })).kind).toBe('unavailable');
    expect(coachChatFailureOf(new ApiError('x', 429)).kind).toBe('rate_limited');
    expect(coachChatFailureOf(new ApiError('Bad', 500)).message).toBe('Bad');
    expect(coachChatFailureOf(new Error('net')).kind).toBe('other');
  });

  it('validates deep-link ids', () => {
    expect(isCoachMessageId(coachMessageId(1))).toBe(true);
    expect(isCoachMessageId('../../x')).toBe(false);
    expect(isCoachMessageId(null)).toBe(false);
  });

  it('reads data defensively', () => {
    expect(coachMessageData(null)).toMatchObject({ links: [], safety: null, fallback: false, headline: null, adherence: null, wins: [] });
    expect(coachMessageData('junk').links).toEqual([]);
    expect(
      coachMessageData({ stats: { headline: 'H', adherence: { done: 1, planned: 2 }, wins: ['a', 3, ''], focus: ['f'] } }),
    ).toMatchObject({ headline: 'H', adherence: { done: 1, planned: 2 }, wins: ['a'], focus: 'f' });
    expect(coachMessageData({ links: [{ label: 'ok', href: 'javascript:alert(1)' }] }).links).toEqual([]);
  });

  it('reduces app Markdown links to their label and labels tools', () => {
    expect(coachDisplayText('Go [Adjust](/train) now, [x](https://e.com)')).toBe('Go Adjust now, [x](https://e.com)');
    expect(coachToolLabel('get_today_plan')).toBe("Looking at today's plan");
    expect(coachToolLabel('unknown')).toBe('Working on it');
  });

  describe('on-demand Listen (#259)', () => {
    it('posts for audio (202 pending) and reads its status (ready) by default', async () => {
      const id = coachMessageId(7);
      const seen: string[] = [];
      server.events.on('request:start', ({ request }) => {
        if (request.url.includes('/audio')) seen.push(`${request.method} ${new URL(request.url).pathname}`);
      });
      expect(await requestCoachMessageAudio(id)).toEqual(mockCoachAudioPending());
      expect(await getCoachMessageAudio(id)).toEqual(mockCoachAudioReady());
      server.events.removeAllListeners();
      expect(seen).toEqual([`POST /api/coach/messages/${id}/audio`, `GET /api/coach/messages/${id}/audio`]);
    });

    it('answers 200 ready when the audio exists', async () => {
      server.use(
        http.post(`${API}/coach/messages/:id/audio`, () => HttpResponse.json({ data: mockCoachAudioReady('o', 'v') })),
      );
      expect(await requestCoachMessageAudio(coachMessageId(7))).toEqual({ status: 'ready', storageObjectId: 'o', voice: 'v' });
    });

    it('classifies refusals', () => {
      const err = (status: number, details: unknown = {}) => new ApiError('x', status, undefined, details);
      expect(coachAudioFailureOf(err(403, { code: 'COACH_AUDIO_DISABLED' }))).toEqual({
        kind: 'disabled',
        message: COACH_AUDIO_MESSAGES.disabled,
      });
      expect(coachAudioFailureOf(err(409, { reason: 'x' })).kind).toBe('unavailable');
      expect(coachAudioFailureOf(err(429)).message).toBe('Too many requests, try again in a minute');
      expect(coachAudioFailureOf(err(404, { code: 'COACH_MESSAGE_NOT_FOUND' })).kind).toBe('not_found');
      expect(coachAudioFailureOf(err(500)).kind).toBe('other');
      expect(coachAudioFailureOf(new Error('network')).message).toBe(COACH_AUDIO_MESSAGES.failed);
    });

    it('treats speech as on only when the user and the policy both allow it', () => {
      const on = { audio: { enabled: true, voice: null, speed: 1 } };
      expect(coachSpeechEnabled(null)).toBe(false);
      expect(coachSpeechEnabled(mockCoachSettingsView())).toBe(false);
      expect(coachSpeechEnabled(mockCoachSettingsView({ settings: on }))).toBe(true);
      expect(coachSpeechEnabled(mockCoachSettingsView({ settings: on, policy: { allowAudio: false } }))).toBe(false);
    });
  });
});
