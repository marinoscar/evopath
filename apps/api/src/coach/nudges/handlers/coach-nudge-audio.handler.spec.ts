import { AiError } from '../../../ai/core/ai-error';
import { GOOD, NOW, PAYLOAD, USER, setupNudge } from '../../../../test/coach/coach-nudge.fixtures';
import { COACH_PERSONAS } from '../../personas';

// =============================================================================
// ai.coach.nudge, the audio branch (E7.6, #246; spec §2.7)
// =============================================================================
//
// Audio on (user AND system) with a runnable `coach.voice`: the message is
// written `pending`, `speak()` gets the resolved model, the user's voice and
// speed and the persona + message instructions, and delivery waits for the
// settle job (the 2-minute wait cap is queued). Every other combination is
// text only, and a message is never left undelivered.
// =============================================================================

const RUN_ID = '00000000-0000-4000-8000-0000000000a1';
const AUDIO_ON = { audio: { enabled: true } };
const coachPersona = COACH_PERSONAS.find((p) => p.id === 'coach')!;

function enqueuedTypes(jobs: { enqueue: jest.Mock }): string[] {
  return jobs.enqueue.mock.calls.map(([input]) => (input as { type: string }).type);
}

describe('CoachNudgeHandler — audio (E7.6)', () => {
  it('audio on: persists pending, calls speak() with the resolved coach.voice model, voice, speed and instructions, and does NOT deliver yet', async () => {
    const t = setupNudge({ coach: AUDIO_ON });
    const outcome = await t.handler.run('job-1', PAYLOAD, NOW);

    expect(outcome).toEqual({ status: 'persisted', messageId: 'msg-1', source: 'model' });
    expect(t.features.resolve).toHaveBeenCalledWith(USER, 'coach.voice');
    expect(t.prisma.coachMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ audioStatus: 'pending', title: GOOD.title, body: GOOD.body }) }),
    );

    expect(t.speak).toHaveBeenCalledTimes(1);
    const req = t.speak.mock.calls[0][0] as Record<string, unknown>;
    expect(req).toMatchObject({
      provider: 'openai',
      model: 'tts-test',
      input: GOOD.audioScript,
      voice: coachPersona.voice.byIntensity[2],
      speed: 1,
    });
    expect(req.instructions).toContain(coachPersona.voice.instructions);
    expect(req.instructions).toContain(GOOD.audioInstructions);

    // audioRunId stored on the still-pending row.
    expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledWith({
      where: { id: 'msg-1', audioStatus: 'pending' },
      data: { audioRunId: RUN_ID },
    });

    // The wait cap, two minutes out and never deduplicated; no delivery yet.
    expect(enqueuedTypes(t.jobs)).toEqual(['coach.audio.settle']);
    expect(t.jobs.enqueue).toHaveBeenCalledWith({
      type: 'coach.audio.settle',
      reason: 'backfill',
      subjectType: 'coach_message',
      subjectId: 'msg-1',
      payload: { messageId: 'msg-1', cause: 'timeout' },
      scheduledFor: new Date(NOW.getTime() + 120_000),
      skipDedup: true,
    });
  });

  it("uses the user's own voice and speed when set", async () => {
    const t = setupNudge({ coach: { audio: { enabled: true, voice: 'cedar', speed: 1.25 } } });
    await t.handler.run('job-1', PAYLOAD, NOW);
    expect(t.speak.mock.calls[0][0]).toMatchObject({ voice: 'cedar', speed: 1.25 });
  });

  it('settles at once when the speech run already finished before audioRunId was stored', async () => {
    const t = setupNudge({ coach: AUDIO_ON, speechRunStatus: 'succeeded' });
    await t.handler.run('job-1', PAYLOAD, NOW);
    expect(enqueuedTypes(t.jobs)).toEqual(['coach.audio.settle', 'coach.audio.settle']);
    expect(t.jobs.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: { messageId: 'msg-1', cause: 'settled' }, subjectId: 'msg-1' }),
    );
  });

  it('audio off for the user (the default): speak() is never called, text only', async () => {
    const t = setupNudge();
    await t.handler.run('job-1', PAYLOAD, NOW);
    expect(t.speak).not.toHaveBeenCalled();
    expect(t.features.resolve).not.toHaveBeenCalledWith(USER, 'coach.voice');
    expect(t.prisma.coachMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ audioStatus: 'none' }) }),
    );
    expect(enqueuedTypes(t.jobs)).toEqual(['coach.message.deliver']);
  });

  it('system allowAudio off: speak() is never called even when the user enabled audio', async () => {
    const t = setupNudge({ coach: AUDIO_ON, system: { allowAudio: false } });
    await t.handler.run('job-1', PAYLOAD, NOW);
    expect(t.speak).not.toHaveBeenCalled();
    expect(t.prisma.coachMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ audioStatus: 'none' }) }),
    );
    expect(enqueuedTypes(t.jobs)).toEqual(['coach.message.deliver']);
  });

  it.each([
    ['with no usable model', { state: 'no_models', model: null }],
    ['lacking audio_speech', { state: 'missing_capability', model: null }],
  ])('coach.voice %s: text only, failed with the no_voice_model reason recorded', async (_label, voiceResolution) => {
    const t = setupNudge({ coach: AUDIO_ON, voiceResolution });
    await t.handler.run('job-1', PAYLOAD, NOW);

    expect(t.speak).not.toHaveBeenCalled();
    expect(t.prisma.coachMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          audioStatus: 'failed',
          body: GOOD.body,
          data: expect.objectContaining({ audioFailure: expect.objectContaining({ reason: 'no_voice_model' }) }),
        }),
      }),
    );
    expect(t.metrics.coachAudioFailure).toHaveBeenCalledWith('no_voice_model');
    expect(enqueuedTypes(t.jobs)).toEqual(['coach.message.deliver']);
  });

  it('speak() refusing to queue: audio recorded failed, text delivered now, no retry', async () => {
    const t = setupNudge({ coach: AUDIO_ON, speak: new AiError('AI_INVALID_REQUEST', 'bad voice') });
    await expect(t.handler.run('job-1', PAYLOAD, NOW)).resolves.toEqual({
      status: 'persisted',
      messageId: 'msg-1',
      source: 'model',
    });

    expect(t.speak).toHaveBeenCalledTimes(1);
    expect(t.prisma.coachMessage.updateMany).toHaveBeenCalledWith({
      where: { id: 'msg-1', audioStatus: 'pending' },
      data: expect.objectContaining({
        audioStatus: 'failed',
        data: expect.objectContaining({ audioFailure: expect.objectContaining({ reason: 'provider_error', code: 'AI_INVALID_REQUEST' }) }),
      }),
    });
    expect(t.metrics.coachAudioFailure).toHaveBeenCalledWith('provider_error');
    expect(enqueuedTypes(t.jobs)).toEqual(['coach.message.deliver']);
  });

  it('a retry finding its pending message queues the settle instead of a second speak()', async () => {
    const t = setupNudge({
      coach: AUDIO_ON,
      existing: { id: 'msg-old', deliveredAt: null, audioStatus: 'pending', createdAt: new Date(NOW.getTime() - 30_000) },
    });
    await expect(t.handler.run('job-1', PAYLOAD, NOW)).resolves.toEqual({ status: 'redelivered', messageId: 'msg-old' });
    expect(t.speak).not.toHaveBeenCalled();
    expect(t.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'coach.audio.settle',
        subjectId: 'msg-old',
        payload: { messageId: 'msg-old', cause: 'timeout' },
        scheduledFor: new Date(NOW.getTime() - 30_000 + 120_000),
      }),
    );
    expect(enqueuedTypes(t.jobs)).not.toContain('coach.message.deliver');
  });
});
