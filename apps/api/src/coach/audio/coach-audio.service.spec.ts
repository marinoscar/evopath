import { CoachAudioService, COACH_AUDIO_WAIT_CAP_MS, COACH_TTS_INSTRUCTIONS_MAX } from './coach-audio.service';
import { renderPersonaStyle } from '../personas/resolve-register';

// =============================================================================
// CoachAudioService (E7.6, #246): the speech request, settle (ready, failed,
// refusal, timeout, duplicates) and the recorded text fallback.
// =============================================================================

const USER = '00000000-0000-4000-8000-000000000001';
const MESSAGE = '00000000-0000-4000-8000-0000000000a1';
const RUN = '00000000-0000-4000-8000-0000000000b1';
const OBJECT = '00000000-0000-4000-8000-0000000000c1';
const NOW = new Date('2026-10-01T10:00:00Z');

function setup(opts: { message?: Record<string, unknown> | null; run?: Record<string, unknown> | null; changed?: number } = {}) {
  const message =
    opts.message === null
      ? null
      : {
          id: MESSAGE,
          userId: USER,
          audioStatus: 'pending',
          audioRunId: RUN,
          deliveredAt: null,
          data: { momentKey: 'k', audioScript: 'secret script' },
          ...(opts.message ?? {}),
        };
  const prisma = {
    coachMessage: {
      findUnique: jest.fn(async () => message),
      updateMany: jest.fn(async () => ({ count: opts.changed ?? 1 })),
    },
    aiRun: {
      findUnique: jest.fn(async () => (opts.run === undefined ? null : opts.run)),
    },
  };
  const runs = { cancel: jest.fn(async () => ({})) };
  const jobs = { enqueue: jest.fn(async () => ({ id: 'job' })) };
  const features = { resolve: jest.fn() };
  const metrics = { coachAudioReady: jest.fn(), coachAudioFailure: jest.fn() };
  const service = new CoachAudioService(
    prisma as never,
    { forUser: jest.fn() } as never,
    runs as never,
    features as never,
    jobs as never,
    metrics as never,
  );
  return { service, prisma, runs, jobs, features, metrics };
}

const SPEECH_OK = {
  status: 'succeeded',
  output: { type: 'speech', storageObjectId: OBJECT, mimeType: 'audio/mpeg', size: 30_000, voice: 'onyx' },
  errorCode: null,
  errorMessage: null,
};

describe('CoachAudioService', () => {
  describe('resolveVoiceModel', () => {
    it('returns the coach.voice model when runnable, null otherwise', async () => {
      const t = setup();
      t.features.resolve.mockResolvedValueOnce({ state: 'ready', model: { provider: 'openai', modelId: 'gpt-4o-mini-tts' } });
      await expect(t.service.resolveVoiceModel(USER)).resolves.toEqual({ provider: 'openai', modelId: 'gpt-4o-mini-tts' });
      expect(t.features.resolve).toHaveBeenCalledWith(USER, 'coach.voice');

      t.features.resolve.mockResolvedValueOnce({ state: 'missing_capability' });
      await expect(t.service.resolveVoiceModel(USER)).resolves.toBeNull();
    });
  });

  describe('speechRequest', () => {
    const style = renderPersonaStyle('drill_sergeant', 2, { profane: false, reason: 'toggle_off' });

    it('defaults to the persona voice for the rendered level and joins persona + message instructions', () => {
      const req = new CoachAudioService({} as never, {} as never, {} as never, {} as never, {} as never).speechRequest({
        style,
        userVoice: null,
        speed: 1.1,
        audioScript: 'Get to the bar.',
        body: 'Body text',
        audioInstructions: 'Short and sharp.',
      });
      expect(req).toEqual({
        input: 'Get to the bar.',
        voice: 'onyx',
        speed: 1.1,
        instructions: `${style.ttsInstructions} Short and sharp.`,
      });
    });

    it('falls back to the body without a script, prefers the user voice, and bounds the instructions', () => {
      const req = new CoachAudioService({} as never, {} as never, {} as never, {} as never, {} as never).speechRequest({
        style,
        userVoice: 'cedar',
        speed: 1,
        audioScript: '  ',
        body: 'Body text',
        audioInstructions: 'x'.repeat(5000),
      });
      expect(req.input).toBe('Body text');
      expect(req.voice).toBe('cedar');
      expect(req.instructions!.length).toBeLessThanOrEqual(COACH_TTS_INSTRUCTIONS_MAX);
    });
  });

  describe('settle', () => {
    it('ready: stores the object and voice, counts generated, asks for delivery', async () => {
      const t = setup({ run: SPEECH_OK });
      await expect(t.service.settle(MESSAGE, 'settled', NOW)).resolves.toEqual({ status: 'ready', userId: USER, deliver: true });
      expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledWith({
        where: { id: MESSAGE, audioStatus: 'pending' },
        data: {
          audioStatus: 'ready',
          audioStorageObjectId: OBJECT,
          data: expect.objectContaining({ momentKey: 'k', voice: 'onyx', audioMimeType: 'audio/mpeg' }),
        },
      });
      expect(t.metrics.coachAudioReady).toHaveBeenCalledTimes(1);
    });

    it('failed run: text fallback with reason provider_error recorded in data', async () => {
      const t = setup({ run: { status: 'failed', output: null, errorCode: 'AI_PROVIDER_UNAVAILABLE', errorMessage: 'x' } });
      await expect(t.service.settle(MESSAGE, 'settled', NOW)).resolves.toEqual({ status: 'failed', userId: USER, deliver: true });
      expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledWith({
        where: { id: MESSAGE, audioStatus: 'pending' },
        data: {
          audioStatus: 'failed',
          data: expect.objectContaining({
            momentKey: 'k',
            audioFailure: { reason: 'provider_error', code: 'AI_PROVIDER_UNAVAILABLE', at: NOW.toISOString() },
          }),
        },
      });
      expect(t.metrics.coachAudioFailure).toHaveBeenCalledWith('provider_error');
      expect(t.runs.cancel).not.toHaveBeenCalled();
    });

    it('refusal: the same text fallback with reason refusal, never retried', async () => {
      const t = setup({ run: { status: 'failed', output: null, errorCode: 'AI_CONTENT_FILTERED', errorMessage: null } });
      await t.service.settle(MESSAGE, 'settled', NOW);
      expect(t.metrics.coachAudioFailure).toHaveBeenCalledWith('refusal');
      expect(t.jobs.enqueue).not.toHaveBeenCalled();
    });

    it('timeout at the wait cap: fails with reason timeout and cancels the late run', async () => {
      const t = setup({ run: { status: 'running', output: null, errorCode: null, errorMessage: null } });
      await expect(t.service.settle(MESSAGE, 'timeout', NOW)).resolves.toMatchObject({ status: 'failed', deliver: true });
      expect(t.metrics.coachAudioFailure).toHaveBeenCalledWith('timeout');
      expect(t.runs.cancel).toHaveBeenCalledWith(USER, RUN);
    });

    it('a settle event for a still-active run waits for the cap', async () => {
      const t = setup({ run: { status: 'running', output: null, errorCode: null, errorMessage: null } });
      await expect(t.service.settle(MESSAGE, 'settled', NOW, true)).resolves.toEqual({
        status: 'waiting',
        userId: USER,
        deliver: false,
      });
      expect(t.prisma.coachMessage.updateMany).not.toHaveBeenCalled();
    });

    it('duplicate: a message no longer pending changes nothing; delivery only if not yet delivered', async () => {
      const t = setup({ message: { audioStatus: 'ready' } });
      await expect(t.service.settle(MESSAGE, 'settled', NOW)).resolves.toEqual({ status: 'not_pending', userId: USER, deliver: true });
      expect(t.prisma.aiRun.findUnique).not.toHaveBeenCalled();
      expect(t.prisma.coachMessage.updateMany).not.toHaveBeenCalled();

      const delivered = setup({ message: { audioStatus: 'failed', deliveredAt: NOW } });
      await expect(delivered.service.settle(MESSAGE, 'timeout', NOW)).resolves.toMatchObject({ deliver: false });
    });

    it('a lost race on the guarded update counts nothing', async () => {
      const t = setup({ run: SPEECH_OK, changed: 0 });
      await t.service.settle(MESSAGE, 'settled', NOW);
      expect(t.metrics.coachAudioReady).not.toHaveBeenCalled();
    });

    it('an unknown message is ignored', async () => {
      const t = setup({ message: null });
      await expect(t.service.settle(MESSAGE, 'settled', NOW)).resolves.toEqual({ status: 'not_found', deliver: false });
    });
  });

  describe('enqueueSettle', () => {
    it('the event-driven settle dedups per message; the wait cap never does', async () => {
      const t = setup();
      await t.service.enqueueSettle(MESSAGE, 'settled', undefined, true);
      await t.service.enqueueSettle(MESSAGE, 'timeout', new Date(NOW.getTime() + COACH_AUDIO_WAIT_CAP_MS));
      expect(t.jobs.enqueue).toHaveBeenNthCalledWith(1, {
        type: 'coach.audio.settle',
        reason: 'backfill',
        subjectType: 'coach_message',
        subjectId: MESSAGE,
        payload: { messageId: MESSAGE, cause: 'settled', jobSucceeded: true },
      });
      expect(t.jobs.enqueue).toHaveBeenNthCalledWith(2, expect.objectContaining({ skipDedup: true, scheduledFor: expect.any(Date) }));
    });
  });
});
