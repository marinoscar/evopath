import { JobSettledEvent } from '../../jobs/events/job-settled.event';
import { CoachAudioSettledListener } from './coach-audio-settled.listener';
import { CoachAudioSettleHandler } from './handlers/coach-audio-settle.handler';

// =============================================================================
// job.settled -> coach.audio.settle -> coach.message.deliver (E7.6, #246):
// enqueue only, unknown runs ignored, duplicates deliver at most once.
// =============================================================================

const RUN = '00000000-0000-4000-8000-0000000000b1';
const MESSAGE = '00000000-0000-4000-8000-0000000000a1';

function settled(overrides: Record<string, unknown> = {}): JobSettledEvent {
  return new JobSettledEvent({
    id: 'job-speech',
    type: 'ai.audio.speech',
    status: 'succeeded',
    subjectType: 'ai_run',
    subjectId: RUN,
    lastError: null,
    executor: 'server',
    ...overrides,
  } as never);
}

function setupListener(message: { id: string; audioStatus: string } | null) {
  const prisma = { coachMessage: { findFirst: jest.fn(async () => message) } };
  const audio = { enqueueSettle: jest.fn(async () => undefined) };
  const listener = new CoachAudioSettledListener(prisma as never, audio as never);
  return { listener, prisma, audio };
}

describe('CoachAudioSettledListener', () => {
  it('queues one settle job for the pending message waiting on that speech run', async () => {
    const t = setupListener({ id: MESSAGE, audioStatus: 'pending' });
    await t.listener.onJobSettled(settled());
    expect(t.prisma.coachMessage.findFirst).toHaveBeenCalledWith({
      where: { audioRunId: RUN },
      select: { id: true, audioStatus: true },
    });
    expect(t.audio.enqueueSettle).toHaveBeenCalledWith(MESSAGE, 'settled', undefined, true);
  });

  it('passes a failed job through so an active run is not waited on', async () => {
    const t = setupListener({ id: MESSAGE, audioStatus: 'pending' });
    await t.listener.onJobSettled(settled({ status: 'failed' }));
    expect(t.audio.enqueueSettle).toHaveBeenCalledWith(MESSAGE, 'settled', undefined, false);
  });

  it.each([
    ['another job type', { type: 'ai.image.generate' }],
    ['a job with no run subject', { subjectType: null, subjectId: null }],
  ])('ignores %s without reading anything', async (_label, overrides) => {
    const t = setupListener({ id: MESSAGE, audioStatus: 'pending' });
    await t.listener.onJobSettled(settled(overrides));
    expect(t.prisma.coachMessage.findFirst).not.toHaveBeenCalled();
    expect(t.audio.enqueueSettle).not.toHaveBeenCalled();
  });

  it('ignores a run no coach message waits on (a preview) and a message already settled (a repeat)', async () => {
    const unknown = setupListener(null);
    await unknown.listener.onJobSettled(settled());
    expect(unknown.audio.enqueueSettle).not.toHaveBeenCalled();

    const repeat = setupListener({ id: MESSAGE, audioStatus: 'ready' });
    await repeat.listener.onJobSettled(settled());
    expect(repeat.audio.enqueueSettle).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const t = setupListener(null);
    t.prisma.coachMessage.findFirst.mockRejectedValueOnce(new Error('db down'));
    await expect(t.listener.onJobSettled(settled())).resolves.toBeUndefined();
  });
});

describe('CoachAudioSettleHandler', () => {
  function setupHandler(outcomes: Array<{ status: string; deliver: boolean }>) {
    const audio = {
      settle: jest.fn(async () => outcomes.shift()),
      enqueueDelivery: jest.fn(async () => undefined),
    };
    const registry = { register: jest.fn() };
    return { handler: new CoachAudioSettleHandler(registry as never, audio as never), audio, registry };
  }

  it('is a registered, server-only job type', () => {
    const t = setupHandler([]);
    t.handler.onModuleInit();
    expect(t.registry.register).toHaveBeenCalledWith(t.handler);
    expect(t.handler.type).toBe('coach.audio.settle');
    expect(t.handler.profile).toEqual({ maxRuntimeMs: 30_000, maxAttempts: 3 });
    expect('nodeResultSchema' in t.handler).toBe(false);
    expect('persistNodeResult' in t.handler).toBe(false);
  });

  it('enqueues delivery when the audio settled; the duplicate after delivery enqueues nothing', async () => {
    const t = setupHandler([
      { status: 'ready', deliver: true },
      { status: 'not_pending', deliver: false },
    ]);
    await t.handler.process({ id: 'j1', payload: { messageId: MESSAGE, cause: 'settled', jobSucceeded: true } } as never);
    await t.handler.process({ id: 'j2', payload: { messageId: MESSAGE, cause: 'timeout' } } as never);
    expect(t.audio.settle).toHaveBeenNthCalledWith(1, MESSAGE, 'settled', expect.any(Date), true);
    expect(t.audio.settle).toHaveBeenNthCalledWith(2, MESSAGE, 'timeout', expect.any(Date), null);
    expect(t.audio.enqueueDelivery).toHaveBeenCalledTimes(1);
    expect(t.audio.enqueueDelivery).toHaveBeenCalledWith(MESSAGE);
  });

  it('a timeout delivers text when the run never settled', async () => {
    const t = setupHandler([{ status: 'failed', deliver: true }]);
    await t.handler.run(MESSAGE, 'timeout', new Date());
    expect(t.audio.enqueueDelivery).toHaveBeenCalledWith(MESSAGE);
  });

  it('a waiting settle delivers nothing (the cap will)', async () => {
    const t = setupHandler([{ status: 'waiting', deliver: false }]);
    await t.handler.run(MESSAGE, 'settled', new Date(), true);
    expect(t.audio.enqueueDelivery).not.toHaveBeenCalled();
  });

  it('ignores an invalid payload', async () => {
    const t = setupHandler([]);
    await t.handler.process({ id: 'j', payload: { messageId: 'nope' } } as never);
    expect(t.audio.settle).not.toHaveBeenCalled();
  });
});
