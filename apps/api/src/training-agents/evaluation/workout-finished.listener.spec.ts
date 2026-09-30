import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JobSettledEvent } from '../../jobs/events/job-settled.event';
import { TRAINING_RUN_JOB_TYPE, TRAINING_RUN_SUBJECT_TYPE } from '../runtime/training-runs.constants';
import { TrainingEvaluationListener } from './workout-finished.listener';

function settled(overrides: Record<string, unknown>): JobSettledEvent {
  return new JobSettledEvent({
    id: 'job-1',
    type: TRAINING_RUN_JOB_TYPE,
    status: 'succeeded',
    subjectType: TRAINING_RUN_SUBJECT_TYPE,
    subjectId: 'run-1',
    ...overrides,
  } as never);
}

describe('TrainingEvaluationListener', () => {
  function setup() {
    const scheduler = {
      requestEvaluation: jest.fn(async () => ({ status: 'created', runId: 'r', programId: 'p' })),
      onRunSettled: jest.fn(async () => null),
    };
    return { scheduler, listener: new TrainingEvaluationListener(scheduler as never) };
  }

  it('asks the scheduler for a workout_finished evaluation when a workout finishes', async () => {
    const t = setup();

    await t.listener.onWorkoutFinished({ userId: 'u1', workoutId: 'w1' });

    expect(t.scheduler.requestEvaluation).toHaveBeenCalledWith('u1', 'workout_finished');
  });

  it('never throws: a failed request is logged and dropped (the sweep is the safety net)', async () => {
    const t = setup();
    t.scheduler.requestEvaluation.mockRejectedValueOnce(new Error('database down'));

    await expect(t.listener.onWorkoutFinished({ userId: 'u1', workoutId: 'w1' })).resolves.toBeUndefined();
  });

  it('applies the follow-up rule when a training run job settles, succeeded or failed', async () => {
    const t = setup();

    await t.listener.onRunJobSettled(settled({}));
    await t.listener.onRunJobSettled(settled({ status: 'failed', subjectId: 'run-2' }));

    expect(t.scheduler.onRunSettled.mock.calls).toEqual([['run-1'], ['run-2']]);
  });

  it('ignores other job types and jobs without a run subject', async () => {
    const t = setup();

    await t.listener.onRunJobSettled(settled({ type: 'training.runs.purge' }));
    await t.listener.onRunJobSettled(settled({ subjectType: null, subjectId: null }));
    await t.listener.onRunJobSettled(settled({ subjectId: null }));

    expect(t.scheduler.onRunSettled).not.toHaveBeenCalled();
  });

  it('never throws from the settle listener either', async () => {
    const t = setup();
    t.scheduler.onRunSettled.mockRejectedValueOnce(new Error('boom'));

    await expect(t.listener.onRunJobSettled(settled({}))).resolves.toBeUndefined();
  });

  describe('its bodies only call the scheduler (no storage, provider or detached work)', () => {
    const source = readFileSync(join(__dirname, 'workout-finished.listener.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    /** Each `@OnEvent` method body, brace-matched after its parameter list. */
    function bodies(): string[] {
      const found: string[] = [];
      let index = source.indexOf('@OnEvent(');
      while (index !== -1) {
        const close = (open: number, a: string, b: string) => {
          let depth = 0;
          for (let i = open; i < source.length; i += 1) {
            if (source[i] === a) depth += 1;
            else if (source[i] === b && --depth === 0) return i + 1;
          }
          return source.length;
        };
        const afterDecorator = close(source.indexOf('(', index), '(', ')');
        const afterParams = close(source.indexOf('(', afterDecorator), '(', ')');
        const open = source.indexOf('{', afterParams);
        const end = close(open, '{', '}');
        found.push(source.slice(open, end));
        index = source.indexOf('@OnEvent(', end);
      }
      return found;
    }

    it('finds both listeners', () => {
      expect(bodies()).toHaveLength(2);
    });

    it.each([
      [/\bthis\.(prisma|storage\w*|ai|aiService|jobs|notifications|signals|http)\b/, 'a service other than the scheduler'],
      [/\.(download|upload|forUser|enqueue)\(/, 'storage, provider or queue work'],
      [/\bfetch\(/, 'a network call'],
      [/\bvoid\s+this\./, 'detached work'],
    ])('no body contains %s (%s)', (pattern) => {
      for (const body of bodies()) expect(body).not.toMatch(pattern);
    });

    it('every body calls the scheduler', () => {
      for (const body of bodies()) expect(body).toMatch(/await this\.scheduler\.(requestEvaluation|onRunSettled)\(/);
    });
  });
});
