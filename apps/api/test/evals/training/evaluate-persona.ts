import { randomUUID } from 'node:crypto';

import type { PlanChangeOperation } from '../../../src/programs/contracts/plan-change.contract';
import type { PlanTree } from '../../../src/programs/contracts/plan-tree.contract';
import type { PlanSignals } from '../../../src/programs/signals/plan-signals.contract';
import { type EvaluationResult, evaluationResultSchema } from '../../../src/training-agents/agents/evaluator/evaluation-result.contract';
import { type AcceptedOperation, applyOperations } from '../../../src/training-agents/evaluation/apply-operations';
import { lockedWorkoutIdsOf } from '../../../src/training-agents/evaluation/build-evaluator-context';
import type { EvaluatorRef } from '../../../src/training-agents/evaluation/evaluate-context';
import { evaluateContextOf } from '../../../src/training-agents/evaluation/evaluate-context';
import { dueSessions } from '../../../src/training-agents/nodes/evaluate.node';
import {
  ADAPT_AS_OF,
  ADAPT_NOW,
  ADAPT_START,
  adaptationFixture,
  adaptationTree,
} from '../../../src/training-agents/testing/adaptation-fixtures';
import { LIB } from '../../../src/training-agents/testing/context-fixtures';
import { CANARY, painRow } from '../../../src/training-agents/testing/evaluation-fixtures';
import { createEvaluationStore, evaluatorScript, plateauSignals } from '../../../src/training-agents/testing/evaluation-harness';
import { SCRIPT_USAGE } from '../../../src/training-agents/testing/agent-scripts';
import { createNodeContextHarness } from '../../../src/training-agents/testing/node-context-harness';
import type { EvalPersona, EvaluationScenario, EvaluatorVariant } from './persona.schema';
import type { EvalArtifact } from './properties';
import type { PersonaRun } from './run-persona';

// =============================================================================
// Evaluate personas: the REAL evaluate graph over the scripted fake provider
// =============================================================================
//
// Each scenario is signals over the adaptation fixture's plan (5 weeks, three
// workouts a week, `asOf` in week 3: weeks 1 and 2 and week 3's Monday and
// Wednesday are locked). The persona's scripted `EvaluationResult` for the
// variant is replayed as the evaluator's answer. Two layers are scored:
//
//   raw      the evaluator's operations applied AS PROPOSED (refs resolved
//            naively, no envelope, locks ignored): measures the model;
//   shipped  the plan after the run (envelope, critique, apply): what ships.
// =============================================================================

/** The facts an evaluator property reads, on top of the artifact's tree (the plan after). */
export interface AdaptationArtifact {
  scenario: EvaluationScenario;
  before: PlanTree;
  lockedWorkoutIds: string[];
  decision: EvaluationResult['decision'];
  dueSessions: number;
  /** Automatic adjustments paused (a pain pattern). */
  paused: boolean;
  painKeys: string[];
  plateauKeys: string[];
}

const PLATEAU_KEY = 'barbell_back_squat';

/** The adaptation critic's answer in pipeline mode: approve (the envelope is what these evals measure). */
const APPROVE = { verdict: 'approve', blockers: [], summary: 'The changes are reasonable.' };

function sessionOn(workout: PlanTree['blocks'][number]['weeks'][number]['workouts'][number], weekNumber: number, status: 'done' | 'missed'): PlanSignals['sessions'][number] {
  const date = new Date(`${ADAPT_START}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 7 * (weekNumber - 1) + ((workout.weekday ?? 1) - 1));
  return {
    programWorkoutId: workout.id!,
    name: CANARY.workoutName,
    plannedFor: date.toISOString().slice(0, 10),
    status,
    workoutId: status === 'done' ? randomUUID() : null,
    setsPlanned: 9,
    setsDone: status === 'done' ? 9 : 0,
    completionPct: status === 'done' ? 100 : 0,
    avgRpe: status === 'done' ? 7.5 : null,
  };
}

/** The scenario's signals. */
export function scenarioSignals(scenario: EvaluationScenario, tree: PlanTree): (signals: PlanSignals) => void {
  const weeks = tree.blocks[0].weeks;
  return (signals) => {
    switch (scenario) {
      case 'plateau':
        plateauSignals(tree)(signals);
        return;
      case 'adherence_gap':
        // Week 1 all done; weeks 2 and 3 only Monday done, the rest missed.
        for (const workout of weeks[0].workouts) signals.sessions.push(sessionOn(workout, 1, 'done'));
        for (const w of [2, 3]) {
          weeks[w - 1].workouts.forEach((workout, i) => {
            const session = sessionOn(workout, w, i === 0 ? 'done' : 'missed');
            if (session.plannedFor <= ADAPT_AS_OF) signals.sessions.push(session);
          });
        }
        signals.adherence.missedStreak = 3;
        signals.adherence.totals = { ...signals.adherence.totals, planned: 8, completed: 5, missed: 3, adherencePct: 62.5 };
        return;
      case 'pain_pattern':
        plateauSignals(tree)(signals);
        signals.pain.push({ ...painRow('bench'), exerciseId: LIB.barbell_bench_press.id, slug: 'barbell_bench_press', consecutiveFlaggedSessions: 3, flaggedSessions28d: 3 });
        return;
      case 'thin_data':
        signals.sessions.push(sessionOn(weeks[0].workouts[0], 1, 'done'));
        return;
    }
  };
}

/** The operations applied as proposed: refs resolved to every row of the slot in the range, locks and bounds ignored. */
export function applyAsProposed(tree: PlanTree, refs: Readonly<Record<string, EvaluatorRef>>, ops: readonly PlanChangeOperation[]): PlanTree {
  const parts = (ref: string) => ref.slice(1).split('-').map(Number);
  const accepted: AcceptedOperation[] = [];

  for (const op of ops) {
    const targets = { exerciseRowIds: [] as string[], workoutRowIds: [] as string[], weekNumbers: [] as number[], exerciseId: null as string | null };
    if (op.op === 'set_prescription' || op.op === 'swap_exercise' || op.op === 'remove_exercise') {
      const ref = refs[op.target.exerciseRef];
      if (!ref?.exerciseId) continue;
      const slot = parts(op.target.exerciseRef)[1];
      for (const [candidate, row] of Object.entries(refs)) {
        const [w, o] = parts(candidate);
        if (row.kind === 'exercise' && row.exerciseId === ref.exerciseId && o === slot && w >= op.target.weeks.from && w <= op.target.weeks.to) {
          targets.exerciseRowIds.push(row.programExerciseId!);
        }
      }
      if (op.op === 'swap_exercise') targets.exerciseId = LIB[op.withExerciseKey]?.id ?? null;
    } else if (op.op === 'add_exercise' || op.op === 'set_weekday' || op.op === 'drop_workout') {
      const slot = parts(op.workoutRef)[1];
      for (let w = op.weeks.from; w <= op.weeks.to; w += 1) {
        const row = refs[`W${w}-${slot}`];
        if (row) targets.workoutRowIds.push(row.programWorkoutId);
      }
      if (op.op === 'add_exercise') targets.exerciseId = LIB[op.exerciseKey]?.id ?? null;
    } else if (op.op === 'mark_deload') {
      targets.weekNumbers = [op.weekNumber];
      targets.workoutRowIds = Object.values(refs).filter((r) => r.kind === 'workout' && r.weekNumber === op.weekNumber).map((r) => r.programWorkoutId);
    }
    accepted.push({ ...op, fingerprint: '', description: '', targets } as AcceptedOperation);
  }
  return applyOperations(tree, accepted).tree;
}

export async function runEvaluatePersona(persona: EvalPersona, variant: EvaluatorVariant): Promise<PersonaRun> {
  const started = Date.now();
  const scenario = persona.evaluation!.scenario;
  const output = evaluationResultSchema.parse(persona.evaluation!.outputs[variant]);

  const tree = adaptationTree();
  const fixture = adaptationFixture({ tree, signals: scenarioSignals(scenario, tree) });
  const store = createEvaluationStore(fixture);
  const h = createNodeContextHarness({
    kind: 'evaluate',
    now: () => ADAPT_NOW,
    ports: store.ports,
    scripts: { evaluator: evaluatorScript([output]), critic: () => ({ outputText: JSON.stringify(APPROVE), usage: SCRIPT_USAGE }) },
  });

  const result = await h.runGraph({ input: { programId: store.programId, input: { trigger: 'weekly' } } });
  const context = evaluateContextOf(result.state)!;
  const outcome = result.state.outcome;

  const facts: AdaptationArtifact = {
    scenario,
    before: fixture.tree,
    lockedWorkoutIds: lockedWorkoutIdsOf(fixture.tree, ADAPT_START, ADAPT_AS_OF, new Set()),
    decision: output.decision,
    dueSessions: dueSessions(context),
    paused: context.safety?.paused ?? false,
    painKeys: context.server.pain.map((row) => row.key),
    plateauKeys: scenario === 'plateau' ? [PLATEAU_KEY] : [],
  };
  const raw: EvalArtifact = {
    layer: 'raw',
    tree: applyAsProposed(fixture.tree, context.server.refs, output.decision === 'adjust' ? output.changes : []),
    ctx: fixture.guardrails,
    adaptation: facts,
  };
  const shipped: EvalArtifact = { layer: 'shipped', tree: store.store.tree, ctx: fixture.guardrails, adaptation: facts };

  const providerCalls = h.runtime.fake.callsTo('responses.create').length;
  const usage: PersonaRun['usage'] = {};
  for (const report of h.usage) {
    const entry = (usage[report.role] ??= { inputTokens: 0, outputTokens: 0 });
    entry.inputTokens += report.usage.inputTokens;
    entry.outputTokens += report.usage.outputTokens;
  }

  return {
    personaId: persona.id,
    variant: variant as PersonaRun['variant'],
    status: outcome?.status === 'completed' || outcome?.status === 'no_change' ? 'completed' : 'failed',
    verdict: outcome?.verdict ?? null,
    warnings: [...result.state.warnings],
    plannerCalls: 0,
    criticRounds: 0,
    providerCalls,
    latencyMs: Date.now() - started,
    usage,
    raw,
    shipped,
    safety: null,
    plannerRequests: [],
    guardrailStatus: null,
    violations: {},
  };
}
