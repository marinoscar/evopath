import { randomUUID } from 'node:crypto';

import type { PlanChangeOperation } from '../../programs/contracts/plan-change.contract';
import type { PlanTree } from '../../programs/contracts/plan-tree.contract';
import type { PlanSignals } from '../../programs/signals/plan-signals.contract';
import type { AssessmentStatus } from '../agents/evaluator/evaluation-result.contract';
import type { ExerciseHistoryFacts } from '../context/planner-context.contract';
import { buildEvaluatorContext, type EvaluationSources } from '../evaluation/build-evaluator-context';
import type { EvaluateRunContext, SafetyGateResult } from '../evaluation/evaluate-context';
import { forcedSafetyOperations, needsRecovery, painPattern } from '../guardrails/safety-stop';
import type { EnvelopeInput } from '../guardrails/envelope';
import type { GuardrailContext } from '../guardrails/types';
import { LIB, LIBRARY } from './context-fixtures';
import { evaluationSignals } from './evaluation-fixtures';
import { intakeFixture } from './intake-fixtures';
import { ex, guardrailContextFixture, planTree, type WeekSpec } from './plan-fixtures';

// =============================================================================
// An adaptation fixture over the guardrails' fixture library, for the
// envelope, apply and evaluator node specs.
//
// A 5-week, one-block plan started Monday 2026-09-07, three workouts a week
// (Mon: squat, bench, row; Wed: leg press, dumbbell bench, cable row;
// Fri: RDL, overhead press, pulldown), week 5 a deload. `asOf` is Thursday
// 2026-09-24 (week 3): weeks 1 and 2 and week 3's Monday and Wednesday are
// LOCKED; week 3's Friday (`W3-3`) and weeks 4 and 5 are open.
//
// Refs: `W4-1-1` = week 4, Monday, back squat; `W4-3` = week 4's Friday.
// =============================================================================

export const ADAPT_START = '2026-09-07';
export const ADAPT_AS_OF = '2026-09-24';
export const ADAPT_NOW = new Date(`${ADAPT_AS_OF}T12:00:00.000Z`);

function week(deload = false): WeekSpec {
  return {
    deload,
    workouts: [
      {
        weekday: 1,
        exercises: [
          ex('barbell_back_squat', { isPriority: true, sets: 3, repMin: 5, repMax: 8, targetLoadKg: 100, loadGuidance: 'fixed', targetRpe: 8 }),
          ex('barbell_bench_press', { sets: 3, repMin: 8, repMax: 10, targetLoadKg: 60, loadGuidance: 'fixed', targetRpe: 8 }),
          ex('barbell_row', { sets: 3, repMin: 8, repMax: 12 }),
        ],
      },
      {
        weekday: 3,
        exercises: [
          ex('leg_press', { isPriority: true, sets: 3, repMin: 10, repMax: 12 }),
          ex('dumbbell_bench_press', { sets: 3, repMin: 8, repMax: 12 }),
          ex('seated_cable_row', { sets: 3, repMin: 10, repMax: 12 }),
        ],
      },
      {
        weekday: 5,
        exercises: [
          ex('romanian_deadlift', { isPriority: true, sets: 3, repMin: 8, repMax: 10 }),
          ex('barbell_overhead_press', { sets: 3, repMin: 6, repMax: 10 }),
          ex('lat_pulldown', { sets: 3, repMin: 10, repMax: 12 }),
        ],
      },
    ],
  };
}

/** Every row with a uuid (a live tree always has them). */
function withIds(tree: PlanTree): PlanTree {
  for (const block of tree.blocks) {
    block.id = randomUUID();
    for (const w of block.weeks) {
      w.id = randomUUID();
      for (const workout of w.workouts) {
        workout.id = randomUUID();
        for (const exercise of workout.exercises) exercise.id = randomUUID();
      }
    }
  }
  return tree;
}

export function adaptationTree(): PlanTree {
  return withIds(planTree([week(), week(), week(), week(), week(true)]));
}

/** History for the Monday lifts: last exposure at the planned load, every set reached the rep floor. */
export function adaptationHistory(over: Partial<Record<string, Partial<ExerciseHistoryFacts>>> = {}): Map<string, ExerciseHistoryFacts> {
  const rows: ExerciseHistoryFacts[] = [
    { exerciseId: LIB.barbell_back_squat.id, key: 'barbell_back_squat', lastLoadKg: 100, lastDate: '2026-09-21', lastMinReps: 8, bestRecentLoadKg: 100, painFlagged: false },
    { exerciseId: LIB.barbell_bench_press.id, key: 'barbell_bench_press', lastLoadKg: 60, lastDate: '2026-09-21', lastMinReps: 10, bestRecentLoadKg: 60, painFlagged: false },
  ].map((row) => ({ ...row, ...(over[row.key] ?? {}) }));
  return new Map(rows.map((row) => [row.exerciseId, row]));
}

export interface AdaptationFixtureOptions {
  tree?: PlanTree;
  signals?: (signals: PlanSignals) => void;
  changeLog?: EvaluationSources['changeLog'];
  autonomy?: 'autonomous' | 'ask_first';
  pausedReason?: string | null;
  linkedWorkoutIds?: string[];
  intake?: Parameters<typeof intakeFixture>[0];
  history?: Map<string, ExerciseHistoryFacts>;
  guardrails?: Partial<GuardrailContext>;
}

export interface AdaptationFixture {
  tree: PlanTree;
  sources: EvaluationSources;
  context: EvaluateRunContext;
  guardrails: GuardrailContext;
  /** The envelope input for `assessment`. */
  input(assessment?: AssessmentStatus): EnvelopeInput;
}

/** The safety gate's result, computed as `safety_gate` does (no text screen). */
export function safetyOf(context: EvaluateRunContext): SafetyGateResult {
  const pattern = painPattern(context.server.pain, context.server.asOf);
  return {
    text: { level: 'ok', reasons: [] },
    painPattern: pattern,
    forced: forcedSafetyOperations(context.server.pain, context.server.refs),
    recover: needsRecovery(context.server.readinessLowStreak),
    paused: context.server.autonomyPausedReason !== null || pattern.triggered,
    changeLogId: null,
  };
}

export function adaptationFixture(opts: AdaptationFixtureOptions = {}): AdaptationFixture {
  const tree = opts.tree ?? adaptationTree();
  const intake = intakeFixture({ daysPerWeek: 3, preferredWeekdays: [1, 3, 5, 6], minutesPerSession: 75, ...opts.intake });
  const sources: EvaluationSources = {
    program: {
      id: randomUUID(),
      goal: intake.goal.type,
      autonomy: opts.autonomy ?? 'autonomous',
      autonomyPausedReason: opts.pausedReason ?? null,
      startDate: ADAPT_START,
      currentVersion: 4,
      intake,
    },
    tree,
    exercises: LIBRARY.map((row) => ({ id: row.id, key: row.key })),
    linkedProgramWorkoutIds: opts.linkedWorkoutIds ?? [],
    signals: evaluationSignals(opts.signals),
    changeLog: opts.changeLog ?? [],
    evidence: [],
  };
  const built = buildEvaluatorContext(sources, { trigger: 'workout_finished', deep: false, now: ADAPT_NOW });
  const context: EvaluateRunContext = { ...built, safety: safetyOf(built) };
  context.sent = { ...context.sent, profile: { ...context.sent.profile, alreadyDecided: context.safety!.forced } };

  const guardrails: GuardrailContext = {
    ...guardrailContextFixture({ intake: { daysPerWeek: 3, preferredWeekdays: [1, 3, 5, 6], minutesPerSession: 75, ...opts.intake } }),
    history: opts.history ?? adaptationHistory(),
    now: ADAPT_NOW,
    ...opts.guardrails,
  };

  return {
    tree,
    sources,
    context,
    guardrails,
    input: (assessment = 'stalled') => ({ context, tree, guardrails, assessment, now: ADAPT_NOW }),
  };
}

/** A `set_prescription` with every field null but the ones given. */
export function prescription(
  exerciseRef: string,
  weeks: { from: number; to: number },
  over: Partial<Omit<Extract<PlanChangeOperation, { op: 'set_prescription' }>, 'op' | 'target'>> = {},
): Extract<PlanChangeOperation, { op: 'set_prescription' }> {
  return {
    op: 'set_prescription',
    target: { exerciseRef, weeks },
    sets: null,
    repMin: null,
    repMax: null,
    targetRpe: null,
    restSeconds: null,
    targetLoadKg: null,
    loadGuidance: null,
    reason: 'Progress',
    ...over,
  };
}

/** The exercise rows of `tree` with `key`, per week number. */
export function rowsOf(tree: PlanTree, key: string): Array<{ weekNumber: number; exercise: PlanTree['blocks'][number]['weeks'][number]['workouts'][number]['exercises'][number] }> {
  const id = LIB[key]?.id;
  return tree.blocks.flatMap((b) =>
    b.weeks.flatMap((w) => w.workouts.flatMap((o) => o.exercises.filter((e) => e.exerciseId === id).map((exercise) => ({ weekNumber: w.weekNumber, exercise })))),
  );
}
