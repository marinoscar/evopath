import { threeDayPlanInput } from '../../../test/fixtures/training/signals/three-day-plan.fixture';
import { toJsonSchema } from '../../ai/core/structured-output';
import { aggregateSignals } from '../../programs/signals/aggregate-signals';
import { compactSignals } from '../../programs/signals/compact-signals';
import { COACH_PAUSE_INVALID } from './coach-chat-errors';
import { COACH_CHAT_TOOL_NAMES, createCoachChatTools, type CoachChatToolDeps, type CoachChatTurnActions } from './tools';
import { minimiseToday } from './tools/get-today-plan.tool';
import { withoutIds } from './tools/minimise';

// =============================================================================
// The coach chat tools (E7.7): bound to the caller, minimised, one narrow write
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-01T12:00:00.000Z');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function makeDeps() {
  const signals = aggregateSignals(threeDayPlanInput());
  const deps = {
    prisma: {
      workout: { findMany: jest.fn().mockResolvedValue([]) },
      coachMessage: { findFirst: jest.fn().mockResolvedValue(null) },
      coachState: { upsert: jest.fn().mockResolvedValue({}) },
    },
    signals: { forUser: jest.fn().mockResolvedValue(signals) },
    today: { today: jest.fn() },
    checkIns: { today: jest.fn().mockResolvedValue('2026-10-01'), list: jest.fn().mockResolvedValue({ items: [] }) },
    photos: { summarize: jest.fn() },
    now: () => NOW,
  };
  return { deps, signals };
}

function tools(deps: unknown, actions: CoachChatTurnActions = { pausedUntil: null }) {
  return Object.fromEntries(createCoachChatTools(deps as CoachChatToolDeps, actions).map((t) => [t.tool.name, t]));
}

async function run(deps: unknown, name: string, args: unknown = {}, actions?: CoachChatTurnActions) {
  const tool = tools(deps, actions)[name];
  const parsed = tool.parseArguments(JSON.stringify(args));
  if (!parsed.success) throw new Error(parsed.error);
  return tool.execute(parsed.data, { userId: USER });
}

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysDeep(v, out);
    }
  }
  return out;
}

describe('coach chat tools (E7.7)', () => {
  it('registers exactly the spec tool list, with no user id parameter anywhere', () => {
    const { deps } = makeDeps();
    const list = createCoachChatTools(deps as unknown as CoachChatToolDeps, { pausedUntil: null });
    expect(list.map((t) => t.tool.name)).toEqual([...COACH_CHAT_TOOL_NAMES]);
    for (const t of list) {
      const schema = JSON.stringify(toJsonSchema(t.tool.parameters));
      expect(schema.toLowerCase()).not.toContain('userid');
      expect(schema.toLowerCase()).not.toContain('user_id');
    }
  });

  it('no tool can mutate a plan, program or workout: the only write is coachState', async () => {
    const { deps } = makeDeps();
    await run(deps, 'pause_coach', { days: 2, reason: 'sick' });
    const writes = Object.entries(deps.prisma).flatMap(([model, api]) =>
      Object.entries(api as Record<string, jest.Mock>)
        .filter(([method, fn]) => fn.mock.calls.length > 0 && /create|update|upsert|delete/i.test(method))
        .map(([method]) => `${model}.${method}`),
    );
    expect(writes).toEqual(['coachState.upsert']);
  });

  describe('get_training_signals', () => {
    it('reads TrainingSignalsService.forUser with the route defaults for the caller and equals its compaction', async () => {
      const { deps, signals } = makeDeps();
      const result = await run(deps, 'get_training_signals');

      expect(deps.signals.forUser).toHaveBeenCalledWith(USER, {});
      // The same figures GET /api/training/signals serves (same call, same defaults), ids stripped.
      expect(result).toEqual(withoutIds(compactSignals(signals)));
      const compact = compactSignals(signals);
      expect((result as any).adherence.totals).toEqual(compact.adherence.totals);
      expect((result as any).adherence.missedStreak).toBe(compact.adherence.missedStreak);
      expect(keysDeep(result).filter((k) => /^id$|Id$|Ids$/.test(k))).toEqual([]);
      expect(JSON.stringify(result)).not.toMatch(UUID);
    });

    it('answers a safe unavailable result instead of throwing raw errors', async () => {
      const { deps } = makeDeps();
      deps.signals.forUser.mockRejectedValue(new Error('connection refused at 10.0.0.5'));
      const result = await run(deps, 'get_training_signals');
      expect(result).toMatchObject({ error: 'unavailable' });
      expect(JSON.stringify(result)).not.toContain('10.0.0.5');
    });
  });

  describe('get_progress_photo_summary', () => {
    it('returns dates and counts only', async () => {
      const { deps } = makeDeps();
      deps.photos.summarize.mockResolvedValue({
        count: 3,
        lastLocalDate: '2026-09-28',
        byPose: { front: 2, side: 1, back: 0, other: 0 },
        // Anything else the service might ever return is not forwarded.
        storageObjectId: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      });
      const result = await run(deps, 'get_progress_photo_summary');
      expect(result).toEqual({ count: 3, lastLocalDate: '2026-09-28', byPose: { front: 2, side: 1, back: 0, other: 0 } });
      expect(JSON.stringify(result)).not.toMatch(UUID);
      expect(JSON.stringify(result)).not.toMatch(/url|storage|note/i);
    });
  });

  describe('get_check_ins', () => {
    it('returns the scores and never the note', async () => {
      const { deps } = makeDeps();
      deps.checkIns.list.mockResolvedValue({
        items: [{ date: '2026-10-01', energy: 4, sleepQuality: 3, soreness: 2, stress: 1, note: 'CANARY-NOTE', updatedAt: NOW.toISOString() }],
      });
      const result = await run(deps, 'get_check_ins');
      expect(result).toEqual({ checkIns: [{ date: '2026-10-01', energy: 4, sleepQuality: 3, soreness: 2, stress: 1 }] });
      expect(deps.checkIns.list).toHaveBeenCalledWith(USER, 14);
    });
  });

  describe('get_recent_workouts', () => {
    it('selects no notes, gym or ids, scopes to the caller, and counts working sets', async () => {
      const { deps } = makeDeps();
      deps.prisma.workout.findMany.mockResolvedValue([
        {
          name: 'Upper A',
          date: new Date('2026-09-30T00:00:00.000Z'),
          durationSeconds: 3540,
          exercises: [
            {
              exercise: { name: 'Bench press' },
              sets: [
                { completed: true, isWarmup: true },
                { completed: true, isWarmup: false },
                { completed: true, isWarmup: false },
                { completed: false, isWarmup: false },
              ],
            },
          ],
        },
      ]);
      const result = await run(deps, 'get_recent_workouts');
      expect(result).toEqual({
        workouts: [{ date: '2026-09-30', name: 'Upper A', durationMinutes: 59, exercises: [{ name: 'Bench press', workingSetsDone: 2 }] }],
      });
      const query = deps.prisma.workout.findMany.mock.calls[0][0];
      expect(query.where).toEqual({ userId: USER, status: 'completed' });
      const selected = keysDeep(query.select);
      for (const forbidden of ['notes', 'painNote', 'gym', 'gymId', 'id', 'photos', 'readinessSnapshot']) {
        expect(selected).not.toContain(forbidden);
      }
    });
  });

  describe('get_today_plan', () => {
    it("reads today's plan for the caller's local today and keeps names and sets only", async () => {
      const { deps } = makeDeps();
      deps.today.today.mockResolvedValue({
        kind: 'workout',
        date: '2026-10-01',
        program: { id: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', name: 'Strength' },
        programWorkout: { id: '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', name: 'Lower A', weekday: 4, estimatedMinutes: 50 },
        weekNumber: 2,
        totalWeeks: 8,
        isDeload: false,
        done: false,
        completedWorkoutId: null,
        inProgressWorkoutId: null,
        session: {
          estimatedMinutes: 50,
          exercises: [
            {
              programExerciseId: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
              exercise: { id: '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', name: 'Back squat' },
              sets: 3,
              repMin: 5,
              repMax: 8,
              targetRpe: 8,
              restSeconds: 180,
              rationale: 'free text the model does not need',
            },
          ],
        },
      });
      const result = await run(deps, 'get_today_plan');
      expect(deps.today.today).toHaveBeenCalledWith(USER, '2026-10-01', NOW);
      expect(result).toMatchObject({ kind: 'workout', workout: 'Lower A', exercises: [{ name: 'Back squat', sets: 3, repMin: 5, repMax: 8 }] });
      expect(JSON.stringify(result)).not.toMatch(UUID);
      expect(JSON.stringify(result)).not.toContain('rationale');
    });

    it('describes a day without a program', () => {
      expect(minimiseToday({ kind: 'no_program', date: '2026-10-01' })).toEqual({ kind: 'no_program', date: '2026-10-01' });
    });
  });

  describe('get_last_weekly_review', () => {
    it('answers found: false before the first review', async () => {
      const { deps } = makeDeps();
      expect(await run(deps, 'get_last_weekly_review')).toEqual({ found: false });
      expect(deps.prisma.coachMessage.findFirst.mock.calls[0][0].where).toEqual({ userId: USER, kind: 'weekly_review' });
    });

    it('returns the headline and the stats without ids', async () => {
      const { deps } = makeDeps();
      deps.prisma.coachMessage.findFirst.mockResolvedValue({
        title: 'Week 40: 3 of 3',
        data: { done: 3, planned: 3, programId: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' },
        createdAt: NOW,
      });
      expect(await run(deps, 'get_last_weekly_review')).toEqual({
        found: true,
        writtenAt: NOW.toISOString(),
        headline: 'Week 40: 3 of 3',
        stats: { done: 3, planned: 3 },
      });
    });
  });

  describe('pause_coach', () => {
    it('sets pausedUntil to now plus the days and records it for the turn', async () => {
      const { deps } = makeDeps();
      const actions: CoachChatTurnActions = { pausedUntil: null };
      const result = await run(deps, 'pause_coach', { days: 3, reason: "I'm sick" }, actions);

      const until = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
      expect(result).toEqual({ ok: true, days: 3, pausedUntil: until.toISOString() });
      expect(deps.prisma.coachState.upsert).toHaveBeenCalledWith({
        where: { userId: USER },
        create: { userId: USER, pausedUntil: until },
        update: { pausedUntil: until },
      });
      expect(actions.pausedUntil).toEqual(until);
      // The reason is not stored on the state.
      expect(JSON.stringify(deps.prisma.coachState.upsert.mock.calls[0][0])).not.toContain('sick');
    });

    it.each([0, 15, -1, 100])('refuses days=%s with COACH_PAUSE_INVALID and writes nothing', async (days) => {
      const { deps } = makeDeps();
      const actions: CoachChatTurnActions = { pausedUntil: null };
      expect(await run(deps, 'pause_coach', { days, reason: 'x' }, actions)).toMatchObject({ ok: false, error: COACH_PAUSE_INVALID });
      expect(deps.prisma.coachState.upsert).not.toHaveBeenCalled();
      expect(actions.pausedUntil).toBeNull();
    });

    it.each([1, 14])('accepts the bound days=%s', async (days) => {
      const { deps } = makeDeps();
      expect(await run(deps, 'pause_coach', { days, reason: 'holiday' })).toMatchObject({ ok: true, days });
    });

    it('rejects a fractional day count and an over-long reason at argument parsing', () => {
      const { deps } = makeDeps();
      const tool = tools(deps).pause_coach;
      expect(tool.parseArguments(JSON.stringify({ days: 1.5, reason: 'x' })).success).toBe(false);
      expect(tool.parseArguments(JSON.stringify({ days: 2, reason: 'x'.repeat(121) })).success).toBe(false);
    });
  });
});
