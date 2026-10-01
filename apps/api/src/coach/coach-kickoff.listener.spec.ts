import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { PROGRAM_ACTIVATED_EVENT } from '../programs/program-events';
import { CoachKickoffListener } from './coach-kickoff.listener';
import { CoachMomentEnqueuer } from './planning/coach-moment-enqueuer';

// =============================================================================
// CoachKickoffListener (E7.12): program.activated -> one kickoff job, enqueue only
// =============================================================================

const USER = '00000000-0000-4000-8000-000000000001';
const PROGRAM = '00000000-0000-4000-8000-0000000000f1';

function realEnqueuer() {
  const jobs = { enqueue: jest.fn(async () => ({ id: 'job-1' })) };
  const registry = { get: jest.fn(() => ({})) };
  const metrics = { suppressed: jest.fn(), momentPlanned: jest.fn() };
  return { enqueuer: new CoachMomentEnqueuer(jobs as never, registry as never, metrics as never), jobs, metrics };
}

describe('CoachKickoffListener', () => {
  it('enqueues one ai.coach.nudge kickoff per activation, subject = the program, momentKey per program', async () => {
    const t = realEnqueuer();
    await new CoachKickoffListener(t.enqueuer).onProgramActivated({ userId: USER, programId: PROGRAM });

    expect(t.jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(t.jobs.enqueue).toHaveBeenCalledWith({
      type: 'ai.coach.nudge',
      reason: 'upload',
      subjectType: 'program',
      subjectId: PROGRAM,
      payload: {
        userId: USER,
        moment: 'kickoff',
        momentKey: `kickoff:${PROGRAM}`,
        trigger: 'program_activated',
        programId: PROGRAM,
      },
    });
    expect(t.metrics.momentPlanned).toHaveBeenCalledWith('kickoff');
  });

  it('repeated activations of one program produce the same dedup subject and momentKey (collapsed by the queue, then by the job)', async () => {
    const t = realEnqueuer();
    const listener = new CoachKickoffListener(t.enqueuer);
    await listener.onProgramActivated({ userId: USER, programId: PROGRAM });
    await listener.onProgramActivated({ userId: USER, programId: PROGRAM });

    const calls = t.jobs.enqueue.mock.calls.map((c) => (c as unknown as [Record<string, any>])[0]);
    expect(new Set(calls.map((c) => `${c.type}:${c.subjectType}:${c.subjectId}`)).size).toBe(1);
    expect(new Set(calls.map((c) => c.payload.momentKey)).size).toBe(1);
    expect(calls.every((c) => c.skipDedup === undefined)).toBe(true);
  });

  it('queues nothing while the nudge handler is not registered', async () => {
    const t = realEnqueuer();
    t.enqueuer = new CoachMomentEnqueuer(t.jobs as never, { get: () => undefined } as never, t.metrics as never);
    await new CoachKickoffListener(t.enqueuer).onProgramActivated({ userId: USER, programId: PROGRAM });
    expect(t.jobs.enqueue).not.toHaveBeenCalled();
    expect(t.metrics.suppressed).toHaveBeenCalledWith('handler_missing', 'kickoff');
  });

  it('never throws: a failed enqueue costs a log line, activation is unaffected', async () => {
    const enqueuer = { enqueueKickoff: jest.fn(async () => Promise.reject(new Error('db down'))) };
    await expect(
      new CoachKickoffListener(enqueuer as never).onProgramActivated({ userId: USER, programId: PROGRAM }),
    ).resolves.toBeUndefined();
  });

  it('subscribes to program.activated', async () => {
    const enqueuer = { enqueueKickoff: jest.fn(async () => ({ status: 'enqueued', jobId: 'j' })) };
    const listener = new CoachKickoffListener(enqueuer as never);
    const events = new EventEmitter2();
    events.on(PROGRAM_ACTIVATED_EVENT, (e) => listener.onProgramActivated(e));
    events.emit(PROGRAM_ACTIVATED_EVENT, { userId: USER, programId: PROGRAM });
    await new Promise((r) => setImmediate(r));
    expect(enqueuer.enqueueKickoff).toHaveBeenCalledWith(USER, PROGRAM);

    const source = readFileSync(join(__dirname, 'coach-kickoff.listener.ts'), 'utf8');
    expect(source).toMatch(/@OnEvent\(PROGRAM_ACTIVATED_EVENT, \{ async: true \}\)/);
  });

  it('injects only the enqueuer (no Prisma, no storage, no AI, no planner)', () => {
    const source = readFileSync(join(__dirname, 'coach-kickoff.listener.ts'), 'utf8');
    expect(source).not.toMatch(/PrismaService|StorageProvider|AiService|CoachPlannerService|TrainingSignalsService/);
  });
});
