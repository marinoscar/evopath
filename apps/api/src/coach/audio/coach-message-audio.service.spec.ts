import { DEFAULT_SYSTEM_SETTINGS } from '../../common/types/settings.types';
import { CoachSlidingWindowLimiter } from './coach-preview-rate-limiter';
import { CoachAudioService } from './coach-audio.service';
import { CoachMessageAudioService, messageAudioView, stripMarkdownLinks } from './coach-message-audio.service';

// =============================================================================
// CoachMessageAudioService (#259): the guarded on-demand transition, the
// register-aware voice, and the error path that never leaves a claim stuck.
// The HTTP behaviour is in test/coach/coach-message-audio.integration.spec.ts.
// =============================================================================

const USER = '00000000-0000-4000-8000-000000000001';
const MESSAGE = '00000000-0000-4000-8000-0000000000a1';
const RUN = '00000000-0000-4000-8000-0000000000b1';
const OBJECT = '00000000-0000-4000-8000-0000000000c1';
const NOW = new Date('2026-10-01T10:00:00Z');

function setup(
  opts: {
    message?: Record<string, unknown>;
    afterLostClaim?: Record<string, unknown>;
    claimCount?: number;
    coach?: Record<string, unknown>;
    startThrows?: Error;
  } = {},
) {
  const base = {
    id: MESSAGE,
    body: 'Body',
    personaId: 'drill_sergeant',
    intensity: 3,
    audioStatus: 'none',
    audioStorageObjectId: null,
    audioRunId: null,
    data: { audioScript: 'Script', audioInstructions: 'Loud.' },
    ...(opts.message ?? {}),
  };
  const reads = [base, { ...base, ...(opts.afterLostClaim ?? {}) }];
  const prisma = {
    coachMessage: {
      findFirst: jest.fn(async () => reads.shift() ?? null),
      findUnique: jest.fn(async () => ({ data: base.data })),
      updateMany: jest.fn(async () => ({ count: opts.claimCount ?? 1 })),
    },
    userSettings: {
      findUnique: jest.fn(async () => ({
        value: { coach: { audio: { enabled: true }, ...(opts.coach ?? {}) } },
        user: { healthProfile: { dateOfBirth: null } },
      })),
    },
    aiRun: { findUnique: jest.fn(async () => null) },
  };
  const speak = jest.fn(async (_req: Record<string, unknown>) => ({ runId: RUN, jobId: 'job' }));
  const ai = { forUser: jest.fn(() => ({ speak })) };
  const jobs = { enqueue: jest.fn(async () => ({ id: 'job' })) };
  const metrics = { coachAudioRequest: jest.fn(), coachAudioFailure: jest.fn(), coachAudioReady: jest.fn() };
  const audio = new CoachAudioService(prisma as never, ai as never, {} as never, {} as never, jobs as never, metrics as never);
  if (opts.startThrows) jest.spyOn(audio, 'start').mockRejectedValue(opts.startThrows);
  const features = { resolve: jest.fn(async () => ({ state: 'ready', model: { provider: 'openai', modelId: 'tts' } })) };
  const systemSettings = { getCoachPolicy: jest.fn(async () => ({ ...DEFAULT_SYSTEM_SETTINGS.coach, allowAudio: true })) };
  const service = new CoachMessageAudioService(
    prisma as never,
    systemSettings as never,
    features as never,
    audio,
    new CoachSlidingWindowLimiter(20, 600_000) as never,
    metrics as never,
  );
  return { service, prisma, speak, ai, jobs, metrics, audio };
}

describe('CoachMessageAudioService', () => {
  it('claims none -> pending with a guarded update, marks the request on demand and starts one run', async () => {
    const t = setup();
    await expect(t.service.request(USER, MESSAGE, NOW)).resolves.toEqual({ status: 'pending', runId: RUN });

    expect(t.prisma.coachMessage.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: MESSAGE,
        userId: USER,
        role: 'coach',
        OR: [{ audioStatus: { in: ['none', 'failed'] } }, { audioStatus: 'ready', audioStorageObjectId: null }],
      },
      data: {
        audioStatus: 'pending',
        audioRunId: null,
        audioStorageObjectId: null,
        data: { audioScript: 'Script', audioInstructions: 'Loud.', audioOnDemand: true, audioRequestedAt: NOW.toISOString() },
      },
    });
    expect(t.speak).toHaveBeenCalledTimes(1);
    expect(t.ai.forUser).toHaveBeenCalledWith(USER, {});
    expect(t.metrics.coachAudioRequest).toHaveBeenCalledWith('started');
  });

  it('a locked register speaks a Sarge L3 message with the L2 voice; the persona and message instructions both apply', async () => {
    const t = setup();
    await t.service.request(USER, MESSAGE, NOW);
    expect(t.speak.mock.calls[0][0]).toMatchObject({ voice: 'onyx', input: 'Script' });
    expect(t.speak.mock.calls[0][0].instructions).toContain('Loud.');
  });

  it("the user's own voice wins over the persona's", async () => {
    const t = setup({ coach: { audio: { enabled: true, voice: 'cedar', speed: 1.2 } } });
    await t.service.request(USER, MESSAGE, NOW);
    expect(t.speak.mock.calls[0][0]).toMatchObject({ voice: 'cedar', speed: 1.2 });
  });

  it.each([
    ['ready', { audioStatus: 'ready', audioStorageObjectId: OBJECT, data: { voice: 'onyx' } }, { status: 'ready', storageObjectId: OBJECT, voice: 'onyx' }],
    ['pending', { audioStatus: 'pending', audioRunId: RUN }, { status: 'pending', runId: RUN }],
  ])('losing the guard to a concurrent press answers the winner\'s state (%s), with no speak()', async (_label, after, expected) => {
    const t = setup({ claimCount: 0, afterLostClaim: after });
    await expect(t.service.request(USER, MESSAGE, NOW)).resolves.toEqual(expected);
    expect(t.speak).not.toHaveBeenCalled();
  });

  it('an unexpected error after the claim records the attempt failed rather than leaving it pending', async () => {
    const t = setup({ startThrows: new Error('db down') });
    const markFailed = jest.spyOn(t.audio, 'markFailed');
    await expect(t.service.request(USER, MESSAGE, NOW)).rejects.toThrow('db down');
    expect(markFailed).toHaveBeenCalledWith(MESSAGE, 'provider_error', null, NOW);
  });

  it('get is read only', async () => {
    const t = setup({ message: { audioStatus: 'failed' } });
    await expect(t.service.get(USER, MESSAGE)).resolves.toEqual({ status: 'failed' });
    expect(t.prisma.coachMessage.updateMany).not.toHaveBeenCalled();
    expect(t.speak).not.toHaveBeenCalled();
  });

  describe('messageAudioView', () => {
    const row = { audioStatus: 'none', audioStorageObjectId: null, audioRunId: null, data: null };
    it('maps each status to the documented shape', () => {
      expect(messageAudioView(row)).toEqual({ status: 'none' });
      expect(messageAudioView({ ...row, audioStatus: 'failed' })).toEqual({ status: 'failed' });
      expect(messageAudioView({ ...row, audioStatus: 'pending' })).toEqual({ status: 'pending' });
      expect(messageAudioView({ ...row, audioStatus: 'pending', audioRunId: RUN })).toEqual({ status: 'pending', runId: RUN });
      expect(messageAudioView({ ...row, audioStatus: 'ready', audioStorageObjectId: OBJECT })).toEqual({
        status: 'ready',
        storageObjectId: OBJECT,
      });
      // Ready but the object is gone (deleted): nothing to play.
      expect(messageAudioView({ ...row, audioStatus: 'ready' })).toEqual({ status: 'none' });
    });
  });

  it('stripMarkdownLinks keeps the labels only', () => {
    expect(stripMarkdownLinks('See [your plan](/programs/1) and ![chart](x.png).')).toBe('See your plan and chart.');
  });
});
