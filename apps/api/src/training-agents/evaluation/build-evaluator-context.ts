import { addDays } from '../../check-ins/local-date';
import type { PlanTree } from '../../programs/contracts/plan-tree.contract';
import { compactSignals } from '../../programs/signals/compact-signals';
import type { PlanSignals } from '../../programs/signals/plan-signals.contract';
import { daysFrom, occurrenceDate } from '../../programs/today/resolve-today';
import { trainingIntakeSchema } from '../contracts/training-intake.contract';
import { briefFromEvidence } from '../finalize/plan-evidence';
import { conservativeModeOf } from '../guardrails/safety-screen';
import {
  EVALUATE_CONTEXT_VERSION,
  type EvaluateRunContext,
  type EvaluatorEvidenceClaim,
  type EvaluatorHistoryEntry,
  type EvaluatorPlan,
  type EvaluatorPlanWeek,
  type EvaluatorProfile,
  type EvaluatorRef,
  type EvaluatorSignals,
} from './evaluate-context';

// =============================================================================
// buildEvaluatorContext: the evaluate run's context from its sources (pure)
// =============================================================================
//
// SHORT REFS. Every week of the live plan is numbered program-wide; its
// workouts by position (1-based), their exercises by position (1-based):
// `W3-2` is week 3's second workout, `W3-2-4` its fourth exercise. The same
// numbering names the planned sessions in the signals. `server.refs` maps each
// ref back to its row ids; the evaluator never sees a uuid.
//
// LOCKED (envelope E1). A workout is locked when a logged session is linked
// to it, or it occurs on or before `asOf` (an unscheduled one: when its plan
// week ended on or before `asOf`). Only weeks from the current one on are
// sent.
//
// NEVER SENT (`context/never-send.ts`): names (of the person, the plan, its
// blocks and workouts, and exercises: exercises go by key), notes, pain notes,
// free text other than the plan's own intake, ids.
// =============================================================================

export const EVALUATOR_HISTORY_ENTRIES = 10;
export const EVALUATOR_EVIDENCE_CLAIMS = 12;

export interface EvaluationSources {
  program: {
    id: string;
    goal: string;
    autonomy: string;
    autonomyPausedReason: string | null;
    /** `YYYY-MM-DD`, null for a plan never activated. */
    startDate: string | null;
    currentVersion: number;
    intake: unknown;
  };
  /** The live tree, with row ids. */
  tree: PlanTree;
  /** Every exercise the tree or the signals name: id and stable key (slug). */
  exercises: Array<{ id: string; key: string }>;
  /** Program workouts a logged session is linked to. */
  linkedProgramWorkoutIds: string[];
  /** `TrainingSignalsService.forEvaluator` (full; compacted here). */
  signals: PlanSignals;
  /** The latest change log entries, newest first. */
  changeLog: Array<{ createdAt: Date; kind: string; actor: string; status: string; summary: string; operations: unknown }>;
  /** Stored version evidence of the plan's AI versions, newest first. */
  evidence: unknown[];
}

export interface BuildEvaluatorContextOptions {
  trigger: string | null;
  deep: boolean;
  now: Date;
}

const FEEDBACK: Record<string, EvaluatorHistoryEntry['feedback']> = {
  reverted: 'undone',
  rejected: 'declined',
  expired: 'expired',
};

export function buildEvaluatorContext(sources: EvaluationSources, options: BuildEvaluatorContextOptions): EvaluateRunContext {
  const { program, signals } = sources;
  const asOf = signals.asOf;
  const keyById = new Map(sources.exercises.map((exercise) => [exercise.id, exercise.key]));
  const { plan, refs, refByWorkoutId } = renderPlan(sources, asOf, keyById);

  return {
    version: EVALUATE_CONTEXT_VERSION,
    kind: 'evaluate',
    sent: {
      run: {
        trigger: options.trigger,
        deep: options.deep,
        recover: false,
        paused: program.autonomyPausedReason !== null,
      },
      signals: sanitizeSignals(signals, refByWorkoutId),
      plan,
      history: sources.changeLog.slice(0, EVALUATOR_HISTORY_ENTRIES).map(historyEntry),
      evidence: evidenceClaims(sources.evidence),
      profile: profileDigest(program, signals),
    },
    server: {
      programId: program.id,
      planVersion: program.currentVersion,
      autonomy: program.autonomy === 'ask_first' ? 'ask_first' : 'autonomous',
      autonomyPausedReason: program.autonomyPausedReason,
      startDate: program.startDate,
      asOf,
      refs,
      exerciseIdsByKey: Object.fromEntries(sources.exercises.map((exercise) => [exercise.key, exercise.id])),
      pain: signals.pain.map((row) => ({
        exerciseId: row.exerciseId,
        key: keyById.get(row.exerciseId) ?? row.slug,
        lastFlaggedOn: row.lastFlaggedOn,
        flaggedSessions28d: row.flaggedSessions28d,
        consecutiveFlaggedSessions: row.consecutiveFlaggedSessions,
      })),
      readinessLowStreak: signals.readiness.lowStreak,
    },
    safety: null,
    builtAt: options.now.toISOString(),
  };
}

function renderPlan(
  sources: EvaluationSources,
  asOf: string,
  keyById: ReadonlyMap<string, string>,
): { plan: EvaluatorPlan; refs: Record<string, EvaluatorRef>; refByWorkoutId: Map<string, string> } {
  const startDate = sources.program.startDate;
  const linked = new Set(sources.linkedProgramWorkoutIds);
  const refs: Record<string, EvaluatorRef> = {};
  const refByWorkoutId = new Map<string, string>();
  const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position;

  const blocks = [...sources.tree.blocks].sort(byPosition);
  const allWeeks = blocks.flatMap((block, blockIndex) => {
    const weeks = [...block.weeks].sort((a, b) => a.weekNumber - b.weekNumber);
    const last = weeks.length ? weeks[weeks.length - 1].weekNumber : null;
    return weeks.map((week) => ({ week, block: blockIndex + 1, lastWeekOfBlock: week.weekNumber === last }));
  });
  const currentWeek = startDate ? Math.max(1, Math.floor(daysFrom(startDate, asOf) / 7) + 1) : null;

  const weeks: EvaluatorPlanWeek[] = [];
  for (const { week, block, lastWeekOfBlock } of allWeeks.sort((a, b) => a.week.weekNumber - b.week.weekNumber)) {
    const weekEnd = startDate ? addDays(startDate, 7 * week.weekNumber - 1) : null;
    const rendered: EvaluatorPlanWeek = { weekNumber: week.weekNumber, block, isDeload: week.isDeload, lastWeekOfBlock, workouts: [] };

    [...week.workouts].sort(byPosition).forEach((workout, w) => {
      const workoutRef = `W${week.weekNumber}-${w + 1}`;
      const date = startDate && workout.weekday ? occurrenceDate(startDate, week.weekNumber, workout.weekday) : null;
      const locked =
        (workout.id !== undefined && linked.has(workout.id)) ||
        (date !== null ? date <= asOf : weekEnd !== null && weekEnd <= asOf);
      if (workout.id) refByWorkoutId.set(workout.id, workoutRef);
      refs[workoutRef] = { kind: 'workout', weekNumber: week.weekNumber, programWorkoutId: workout.id ?? '', date, locked };

      const exercises = [...workout.exercises].sort(byPosition).map((exercise, e) => {
        const ref = `${workoutRef}-${e + 1}`;
        const key = keyById.get(exercise.exerciseId) ?? 'unknown';
        refs[ref] = {
          kind: 'exercise',
          weekNumber: week.weekNumber,
          programWorkoutId: workout.id ?? '',
          programExerciseId: exercise.id ?? '',
          exerciseId: exercise.exerciseId,
          exerciseKey: key,
          date,
          locked,
        };
        return {
          ref,
          key,
          isPriority: exercise.isPriority,
          sets: exercise.targetSets,
          repMin: exercise.repMin,
          repMax: exercise.repMax,
          targetRpe: exercise.targetRpe ?? null,
          restSeconds: exercise.restSeconds,
          targetLoadKg: exercise.targetLoadKg ?? null,
          loadGuidance: exercise.loadGuidance,
        };
      });

      rendered.workouts.push({ ref: workoutRef, weekday: workout.weekday ?? null, date, locked, exercises });
    });

    if (currentWeek === null || week.weekNumber >= currentWeek) weeks.push(rendered);
  }

  return { plan: { currentWeek, totalWeeks: allWeeks.length, weeks }, refs, refByWorkoutId };
}

function sanitizeSignals(signals: PlanSignals, refByWorkoutId: ReadonlyMap<string, string>): EvaluatorSignals {
  const compact = compactSignals(signals);
  return {
    range: compact.range,
    asOf: compact.asOf,
    planVersion: compact.planVersion,
    weeksInRange: compact.weeksInRange,
    truncated: compact.truncated,
    planChangedOn: compact.planChangedOn,
    adherence: compact.adherence,
    frequency: compact.frequency,
    sessions: compact.sessions.map((session) => ({
      workoutRef: refByWorkoutId.get(session.programWorkoutId) ?? null,
      plannedFor: session.plannedFor,
      status: session.status,
      setsPlanned: session.setsPlanned,
      setsDone: session.setsDone,
      avgRpe: session.avgRpe,
    })),
    volume: compact.volume,
    performance: compact.performance.map(({ exerciseId: _id, name: _name, slug, ...rest }) => ({ key: slug, ...rest })),
    effort: compact.effort,
    pain: compact.pain.map((row) => ({
      key: row.slug,
      lastFlaggedOn: row.lastFlaggedOn,
      flaggedSessions28d: row.flaggedSessions28d,
      consecutiveFlaggedSessions: row.consecutiveFlaggedSessions,
    })),
    readiness: compact.readiness,
    body: compact.body,
    dropped: {
      weeks: compact.dropped.weeks,
      sessions: compact.dropped.sessions,
      muscles: compact.dropped.muscles,
      exercises: compact.dropped.exercises.length,
      pain: compact.dropped.pain.length,
    },
  };
}

function historyEntry(row: EvaluationSources['changeLog'][number]): EvaluatorHistoryEntry {
  return {
    date: row.createdAt.toISOString().slice(0, 10),
    kind: row.kind,
    actor: row.actor,
    status: row.status,
    summary: row.summary.slice(0, 300),
    feedback: FEEDBACK[row.status] ?? null,
    operations: Array.isArray(row.operations) ? row.operations.length : 0,
  };
}

function evidenceClaims(stored: readonly unknown[]): EvaluatorEvidenceClaim[] {
  for (const evidence of stored) {
    const brief = briefFromEvidence(evidence);
    if (brief) {
      return brief.claims.slice(0, EVALUATOR_EVIDENCE_CLAIMS).map((claim) => ({
        id: claim.id,
        topic: claim.topic,
        claim: claim.claim,
        confidence: claim.confidence,
      }));
    }
  }
  return [];
}

function profileDigest(program: EvaluationSources['program'], signals: PlanSignals): EvaluatorProfile {
  const parsed = trainingIntakeSchema.safeParse(program.intake);
  const readiness = signals.readiness.avg;

  if (!parsed.success) {
    return {
      goal: { type: program.goal, description: '' },
      experience: null,
      daysPerWeek: null,
      preferredWeekdays: null,
      minutesPerSession: null,
      limitations: [],
      avoidExerciseKeys: [],
      conservative: conservativeModeOf({ texts: [], limitationCount: 0, readiness }).conservative,
      alreadyDecided: [],
    };
  }

  const intake = parsed.data;
  return {
    goal: { type: intake.goal.type, description: intake.goal.description },
    experience: intake.experience,
    daysPerWeek: intake.daysPerWeek,
    preferredWeekdays: intake.preferredWeekdays,
    minutesPerSession: intake.minutesPerSession,
    limitations: intake.limitations.map((limitation) => ({ area: limitation.area, description: limitation.description })),
    avoidExerciseKeys: [...intake.avoidExerciseKeys],
    conservative: conservativeModeOf({
      texts: [intake.goal.description, ...intake.limitations.map((limitation) => limitation.description), intake.preferences],
      limitationCount: intake.limitations.length,
      readiness,
    }).conservative,
    alreadyDecided: [],
  };
}
