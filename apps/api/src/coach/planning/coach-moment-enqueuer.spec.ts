import { CoachMomentEnqueuer } from './coach-moment-enqueuer';
import type { PlannedMoment } from './plan-coach-moments';

const USER = '00000000-0000-4000-8000-000000000001';

const top: PlannedMoment = {
  moment: 'missed_twice',
  lane: 'nudge',
  priority: 1,
  reason: 'missed_streak',
  eventKey: 'coach.nudge',
  suppressedBy: null,
};
const second: PlannedMoment = { ...top, moment: 'missed_session', priority: 5, reason: 'missed_yesterday' };

function setup(registered: string[]) {
  const jobs = { enqueue: jest.fn(async () => ({ id: 'job-1' })) };
  const registry = { get: jest.fn((type: string) => (registered.includes(type) ? {} : undefined)) };
  const metrics = { suppressed: jest.fn(), momentPlanned: jest.fn() };
  return { enqueuer: new CoachMomentEnqueuer(jobs as never, registry as never, metrics as never), jobs, metrics };
}

describe('CoachMomentEnqueuer', () => {
  it('queues ai.coach.nudge with the user as subject and ids-only payload', async () => {
    const t = setup(['ai.coach.nudge']);
    const outcome = await t.enqueuer.enqueueNudge(USER, top, [top, second], '2026-09-30', 'sweep');
    expect(outcome).toEqual({ status: 'enqueued', jobId: 'job-1' });
    expect(t.jobs.enqueue).toHaveBeenCalledWith({
      type: 'ai.coach.nudge',
      reason: 'backfill',
      subjectType: 'user',
      subjectId: USER,
      payload: {
        userId: USER,
        moment: 'missed_twice',
        momentKey: 'missed_twice:2026-09-30',
        candidates: [
          { moment: 'missed_twice', priority: 1, reason: 'missed_streak' },
          { moment: 'missed_session', priority: 5, reason: 'missed_yesterday' },
        ],
        trigger: 'sweep',
      },
    });
    expect(t.metrics.momentPlanned).toHaveBeenCalledWith('missed_twice');
  });

  it('queues nothing and counts handler_missing while the nudge handler is not registered', async () => {
    const t = setup([]);
    expect(await t.enqueuer.enqueueNudge(USER, top, [top], '2026-09-30', 'sweep')).toEqual({ status: 'handler_missing' });
    expect(t.jobs.enqueue).not.toHaveBeenCalled();
    expect(t.metrics.suppressed).toHaveBeenCalledWith('handler_missing', 'missed_twice');
  });

  it('queues ai.coach.weekly_review with the ISO week, or counts handler_missing', async () => {
    const t = setup(['ai.coach.weekly_review']);
    await t.enqueuer.enqueueWeeklyReview(USER, '2026-W40');
    expect(t.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ai.coach.weekly_review', subjectId: USER, payload: { userId: USER, isoWeek: '2026-W40' } }),
    );
    const missing = setup([]);
    expect(await missing.enqueuer.enqueueWeeklyReview(USER, '2026-W40')).toEqual({ status: 'handler_missing' });
  });
  describe('enqueueKickoff (E7.12)', () => {
    const PROGRAM = '00000000-0000-4000-8000-0000000000f1';

    it('queues the kickoff with the program as subject and a per-program momentKey', async () => {
      const t = setup(['ai.coach.nudge']);
      expect(await t.enqueuer.enqueueKickoff(USER, PROGRAM)).toEqual({ status: 'enqueued', jobId: 'job-1' });
      expect(t.jobs.enqueue).toHaveBeenCalledWith({
        type: 'ai.coach.nudge',
        reason: 'upload',
        subjectType: 'program',
        subjectId: PROGRAM,
        payload: { userId: USER, moment: 'kickoff', momentKey: `kickoff:${PROGRAM}`, trigger: 'program_activated', programId: PROGRAM },
      });
      expect(t.metrics.momentPlanned).toHaveBeenCalledWith('kickoff');
    });

    it('queues nothing and counts handler_missing while the nudge handler is not registered', async () => {
      const t = setup([]);
      expect(await t.enqueuer.enqueueKickoff(USER, PROGRAM)).toEqual({ status: 'handler_missing' });
      expect(t.jobs.enqueue).not.toHaveBeenCalled();
      expect(t.metrics.suppressed).toHaveBeenCalledWith('handler_missing', 'kickoff');
    });
  });
});
