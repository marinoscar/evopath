import { randomUUID } from 'node:crypto';

import { MemorySaver } from '@langchain/langgraph-checkpoint';

import type { PlanTree } from '../../../src/programs/contracts/plan-tree.contract';
import type { PlanSignals } from '../../../src/programs/signals/plan-signals.contract';
import type { ExerciseHistoryFacts } from '../../../src/training-agents/context/planner-context.contract';
import {
  ADAPT_AS_OF,
  ADAPT_NOW,
  ADAPT_START,
  type AdaptationFixtureOptions,
  adaptationFixture,
} from '../../../src/training-agents/testing/adaptation-fixtures';
import { LIB } from '../../../src/training-agents/testing/context-fixtures';
import { createEvaluationStore } from '../../../src/training-agents/testing/evaluation-harness';
import { createNodeContextHarness } from '../../../src/training-agents/testing/node-context-harness';
import { ex, planTree, type WeekSpec } from '../../../src/training-agents/testing/plan-fixtures';
import { scenarioScripts } from './scenario-script';

// =============================================================================
// The evaluate scenarios' plan and runner (TEST-ONLY)
// =============================================================================
//
// The evaluator fixtures (`fixtures/training/scenarios/evaluator/*.json`) name
// rows by short ref against the plan `planner/valid-8w.json` compiles to:
// 8 weeks in two 4-week blocks, three workouts a week (Monday, Wednesday,
// Friday) of five exercises, weeks 4 and 8 deloads. This file builds that shape
// over the fixture library, started Monday 2026-09-07 with `asOf` Thursday
// 2026-09-24 (week 3): weeks 1 and 2 and week 3's Monday and Wednesday are
// locked, weeks 5 to 7 are open and not deloads, which is where every fixture
// change lands.
// =============================================================================

const KEYS = ['dumbbell_lunge', 'dumbbell_bench_press', 'dumbbell_row', 'dumbbell_romanian_deadlift', 'glute_bridge'];

function week(deload: boolean): WeekSpec {
  const sets = deload ? 2 : 3;
  return {
    deload,
    workouts: [1, 3, 5].map((weekday) => ({
      weekday,
      exercises: KEYS.map((key, i) =>
        ex(key, {
          isPriority: i === 0,
          sets,
          repMin: 8,
          repMax: 12,
          targetRpe: 7,
          restSeconds: 60,
          // The bench press is prescribed at 15 kg so a load nudge has a basis to build on.
          ...(key === 'dumbbell_bench_press' ? { targetLoadKg: 15, loadGuidance: 'fixed' as const } : {}),
        }),
      ),
    })),
  };
}

export function scenarioPlanTree(): PlanTree {
  const tree = planTree([1, 2, 3, 4, 5, 6, 7, 8].map((n) => week(n % 4 === 0)));
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

/** Weeks 1 to 3 done at RPE 7 and the bench press at the top of its range twice. */
export function completedSignals(tree: PlanTree): (signals: PlanSignals) => void {
  return (signals) => {
    for (const w of tree.blocks[0].weeks.slice(0, 3)) {
      for (const workout of w.workouts) {
        const date = new Date(`${ADAPT_START}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() + 7 * (w.weekNumber - 1) + ((workout.weekday ?? 1) - 1));
        const plannedFor = date.toISOString().slice(0, 10);
        if (plannedFor > ADAPT_AS_OF) continue;
        signals.sessions.push({
          programWorkoutId: workout.id!,
          name: 'Full body',
          plannedFor,
          status: 'done',
          workoutId: randomUUID(),
          setsPlanned: 15,
          setsDone: 15,
          completionPct: 100,
          avgRpe: 7,
        });
      }
    }
    signals.performance.push({
      exerciseId: LIB.dumbbell_bench_press.id,
      slug: 'dumbbell_bench_press',
      name: 'Dumbbell bench press',
      sessions: 3,
      best: { weightKg: 15, reps: 12, e1rmKg: 21 },
      lastTopSets: [
        { date: '2026-09-21', weightKg: 15, reps: 12, rpe: 7 },
        { date: '2026-09-14', weightKg: 15, reps: 12, rpe: 7 },
        { date: '2026-09-07', weightKg: 15, reps: 11, rpe: 7.5 },
      ],
      trend: 'flat',
      trendPct: 0,
      prInRange: false,
    });
    signals.adherence.completedStreak = 7;
  };
}

/** The bench pressed at 15 kg for 12 reps last time (the floor of 8 met). */
function history(): Map<string, ExerciseHistoryFacts> {
  const rows: ExerciseHistoryFacts[] = [
    { exerciseId: LIB.dumbbell_bench_press.id, key: 'dumbbell_bench_press', lastLoadKg: 15, lastDate: '2026-09-21', lastMinReps: 12, bestRecentLoadKg: 15, painFlagged: false },
    { exerciseId: LIB.dumbbell_row.id, key: 'dumbbell_row', lastLoadKg: 20, lastDate: '2026-09-21', lastMinReps: 12, bestRecentLoadKg: 20, painFlagged: false },
  ];
  return new Map(rows.map((row) => [row.exerciseId, row]));
}

export interface EvaluateScenarioOptions {
  autonomy?: 'autonomous' | 'ask_first';
  /** Pain on the dumbbell bench press in this many sessions in a row. */
  painSessionsInARow?: number;
  pausedReason?: string | null;
  changeLog?: AdaptationFixtureOptions['changeLog'];
  /** No completed session: thin data. */
  noHistory?: boolean;
  /** Free-text pain notes of the last 14 days (they never leave the server). */
  painNotes?: string[];
}

/** The plan, its store and the ports for one evaluate scenario. */
export function evaluateScenarioPlan(opts: EvaluateScenarioOptions = {}) {
  const tree = scenarioPlanTree();
  const done = opts.noHistory ? () => undefined : completedSignals(tree);
  const fixture = adaptationFixture({
    tree,
    autonomy: opts.autonomy,
    pausedReason: opts.pausedReason,
    changeLog: opts.changeLog,
    history: history(),
    signals: (signals) => {
      done(signals);
      if (opts.painSessionsInARow) {
        signals.pain.push({
          exerciseId: LIB.dumbbell_bench_press.id,
          slug: 'dumbbell_bench_press',
          name: 'Dumbbell bench press',
          lastFlaggedOn: '2026-09-21',
          flaggedSessions28d: opts.painSessionsInARow,
          consecutiveFlaggedSessions: opts.painSessionsInARow,
        });
      }
    },
  });
  return { fixture, ...createEvaluationStore(fixture, { painNotes: opts.painNotes }) };
}

export type EvaluateScenarioPlan = ReturnType<typeof evaluateScenarioPlan>;

/** A runner: the scenario's scripts over the plan's ports, on one (shareable) checkpointer. */
export function evaluateScenario(name: string, opts: EvaluateScenarioOptions = {}, shared: { plan?: EvaluateScenarioPlan; checkpointer?: MemorySaver; runId?: string } = {}) {
  const plan = shared.plan ?? evaluateScenarioPlan(opts);
  const checkpointer = shared.checkpointer ?? new MemorySaver();
  const h = createNodeContextHarness({
    kind: 'evaluate',
    now: () => ADAPT_NOW,
    ports: plan.ports,
    scripts: scenarioScripts(name),
    ...(shared.runId ? { runId: shared.runId } : {}),
  });
  const log = () => h.events.events.get(h.runId) ?? [];
  return {
    plan,
    h,
    checkpointer,
    store: plan.store,
    run: () => h.runGraph({ input: { programId: plan.programId, input: { trigger: 'workout_finished' } }, checkpointer }),
    resume: (decision: 'approve' | 'reject') => h.runGraph({ resume: { decision }, checkpointer }),
    events: (type: string) => log().filter((e) => e.type === type).map((e) => e.data),
    types: () => log().map((e) => e.type),
    calls: (agent?: string) => h.runtime.fake.callsTo('responses.create').filter((c) => !agent || c.request?.metadata?.agent === agent),
  };
}
