import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CoachEventsListener } from './coach-events.listener';

// AC 15: the listener performs no I/O beyond enqueueing.

const USER = '00000000-0000-4000-8000-000000000001';
const WORKOUT = '00000000-0000-4000-8000-0000000000aa';

describe('CoachEventsListener', () => {
  it('enqueues coach.workout_finished for the user on workout.finished', async () => {
    const jobs = { enqueue: jest.fn(async () => ({ id: 'job-1' })) };
    await new CoachEventsListener(jobs as never).onWorkoutFinished({ userId: USER, workoutId: WORKOUT });
    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: 'coach.workout_finished',
      reason: 'upload',
      subjectType: 'user',
      subjectId: USER,
      payload: { userId: USER, workoutId: WORKOUT },
    });
  });

  it('never throws: a failed enqueue costs a log line', async () => {
    const jobs = { enqueue: jest.fn(async () => Promise.reject(new Error('db down'))) };
    await expect(new CoachEventsListener(jobs as never).onWorkoutFinished({ userId: USER, workoutId: WORKOUT })).resolves.toBeUndefined();
  });

  it('injects only the queue (no Prisma, no storage, no planner)', () => {
    const source = readFileSync(join(__dirname, 'coach-events.listener.ts'), 'utf8');
    expect(source).not.toMatch(/PrismaService|StorageProvider|CoachPlannerService|TrainingSignalsService/);
  });
});
