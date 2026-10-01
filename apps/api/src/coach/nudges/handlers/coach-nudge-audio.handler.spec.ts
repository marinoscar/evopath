import { GOOD, NOW, PAYLOAD, USER, setupNudge } from '../../../../test/coach/coach-nudge.fixtures';

// =============================================================================
// ai.coach.nudge and audio (#259, on demand; spec §2.7)
// =============================================================================
//
// Audio is spoken only when the user asks (`POST /api/coach/messages/:id/audio`).
// Whatever the user's `audio.enabled`, the system `allowAudio` and the
// `coach.voice` resolution, the nudge job never calls `speak()`, never
// resolves `coach.voice`, writes `audioStatus = 'none'` (keeping the
// guard-approved `audioScript` and `audioInstructions` for a later Listen)
// and enqueues delivery at once.
// =============================================================================

const AUDIO_ON = { audio: { enabled: true } };

function enqueuedTypes(jobs: { enqueue: jest.Mock }): string[] {
  return jobs.enqueue.mock.calls.map(([input]) => (input as { type: string }).type);
}

describe('CoachNudgeHandler — audio is on demand (#259)', () => {
  it.each([
    ['audio on, system allows, coach.voice runnable', { coach: AUDIO_ON }],
    ['audio off (the default)', {}],
    ['system allowAudio off', { coach: AUDIO_ON, system: { allowAudio: false } }],
    ['coach.voice unresolved', { coach: AUDIO_ON, voiceResolution: { state: 'no_models', model: null } }],
  ])('%s: never speaks, writes audioStatus none and delivers the text at once', async (_label, options) => {
    const t = setupNudge(options);
    const outcome = await t.handler.run('job-1', PAYLOAD, NOW);

    expect(outcome).toEqual({ status: 'persisted', messageId: 'msg-1', source: 'model' });
    expect(t.speak).not.toHaveBeenCalled();
    expect(t.features.resolve).not.toHaveBeenCalledWith(USER, 'coach.voice');
    expect(t.prisma.coachMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          audioStatus: 'none',
          body: GOOD.body,
          data: expect.objectContaining({ audioScript: GOOD.audioScript, audioInstructions: GOOD.audioInstructions }),
        }),
      }),
    );
    const data = (t.prisma.coachMessage.create.mock.calls[0][0] as { data: { data: Record<string, unknown> } }).data.data;
    expect(data).not.toHaveProperty('audioFailure');
    expect(enqueuedTypes(t.jobs)).toEqual(['coach.message.deliver']);
    expect(t.metrics.coachAudioFailure).not.toHaveBeenCalled();
  });

  it('a retry finding its undelivered message only re-enqueues delivery, never a settle or a speak()', async () => {
    const t = setupNudge({ coach: AUDIO_ON, existing: { id: 'msg-old', deliveredAt: null } });
    await expect(t.handler.run('job-1', PAYLOAD, NOW)).resolves.toEqual({ status: 'redelivered', messageId: 'msg-old' });
    expect(t.speak).not.toHaveBeenCalled();
    expect(enqueuedTypes(t.jobs)).toEqual(['coach.message.deliver']);
    expect(t.jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ subjectId: 'msg-old', payload: { messageId: 'msg-old' } }));
  });
});
