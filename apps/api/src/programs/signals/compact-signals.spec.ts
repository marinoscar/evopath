import { longHistoryInput, LONG_EXERCISES } from '../../../test/fixtures/training/signals/long-history.fixture';
import { threeDayPlanInput } from '../../../test/fixtures/training/signals/three-day-plan.fixture';
import { aggregateSignals, emptySignals } from './aggregate-signals';
import { COMPACT_TOKEN_BUDGET, compactSignals, estimateTokens } from './compact-signals';
import type { PlanSignals } from './plan-signals.contract';

// =============================================================================
// compactSignals (E5.9): caps, flagged lifts, drop report and the budget
// =============================================================================

describe('compactSignals', () => {
  const long = aggregateSignals(longHistoryInput());

  it('stays under the token budget for a 26-week user', () => {
    expect(long.weeksInRange).toBe(26);
    expect(long.performance.length).toBe(20);
    expect(estimateTokens(long)).toBeGreaterThan(COMPACT_TOKEN_BUDGET);
    const compact = compactSignals(long);
    expect(estimateTokens(compact)).toBeLessThanOrEqual(COMPACT_TOKEN_BUDGET);
  });

  it('respects the caps and reports what it dropped', () => {
    const compact = compactSignals(long);
    expect(compact.adherence.weeks).toHaveLength(8);
    expect(compact.frequency.perWeek).toHaveLength(8);
    expect(compact.adherence.weeks[0].weekStart).toBe(long.adherence.weeks[18].weekStart);
    expect(compact.volume.length).toBeLessThanOrEqual(12);
    expect(compact.volume.every((row) => row.weeks.length === 8)).toBe(true);
    expect(compact.performance).toHaveLength(12);
    expect(compact.dropped.weeks).toBe(18);
    expect(compact.dropped.sessions).toBe(18 * 3);
    expect(compact.dropped.exercises).toHaveLength(8);
    expect(compact.dropped.muscles).toHaveLength(long.volume.length - compact.volume.length);
    expect(compact.sessions.every((session) => session.plannedFor >= compact.adherence.weeks[0].weekStart)).toBe(true);
  });

  it('keeps every total and summary untouched', () => {
    const compact = compactSignals(long);
    expect(compact.adherence.totals).toEqual(long.adherence.totals);
    expect(compact.frequency.avgPerWeek).toBe(long.frequency.avgPerWeek);
    expect(compact.effort).toEqual(long.effort);
    expect(compact.readiness).toEqual(long.readiness);
    expect(compact.body).toEqual(long.body);
  });

  it('keeps flagged lifts ahead of busier unflagged ones', () => {
    const quiet: PlanSignals = {
      ...long,
      performance: long.performance.map((lift) => ({ ...lift, prInRange: false, trend: 'flat' as const })),
    };
    const leastUsed = [...quiet.performance].sort((a, b) => a.sessions - b.sessions)[0];
    const withPr: PlanSignals = {
      ...quiet,
      performance: quiet.performance.map((lift) => (lift.exerciseId === leastUsed.exerciseId ? { ...lift, prInRange: true } : lift)),
      pain: [],
    };
    expect(compactSignals(withPr, { maxExercises: 3 }).performance.map((lift) => lift.exerciseId)).toContain(leastUsed.exerciseId);

    const pained = LONG_EXERCISES[19].id;
    expect(long.pain.map((row) => row.exerciseId)).toContain(pained);
    const withPain: PlanSignals = { ...quiet, pain: long.pain };
    expect(compactSignals(withPain, { maxExercises: 1 }).performance.map((lift) => lift.exerciseId)).toEqual([pained]);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(compactSignals(long))).toBe(JSON.stringify(compactSignals(aggregateSignals(longHistoryInput()))));
  });

  it('keeps everything when under the caps', () => {
    const small = aggregateSignals(threeDayPlanInput());
    const compact = compactSignals(small);
    expect(compact.dropped).toEqual({ weeks: 0, sessions: 0, muscles: [], exercises: [], pain: [] });
    expect(compact.performance).toEqual(small.performance);
    expect(compact.volume).toEqual(small.volume);
  });

  it('handles empty signals and zero caps', () => {
    const empty = emptySignals({ from: '2026-09-01', to: '2026-09-28' }, '2026-09-28');
    expect(compactSignals(empty).sessions).toEqual([]);
    const none = compactSignals(long, { maxWeeks: 0, maxMuscles: 0, maxExercises: 0 });
    expect(none.adherence.weeks).toEqual([]);
    expect(none.sessions).toEqual([]);
    expect(none.volume).toEqual([]);
    expect(none.performance).toEqual([]);
    expect(none.dropped.weeks).toBe(26);
  });
});
