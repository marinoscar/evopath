import { randomUUID } from 'node:crypto';

import { ConflictException } from '@nestjs/common';

import type { AiResponseRequest } from '../../ai/core/types/responses.types';
import type { FakeAiScriptedResponse } from '../../ai/testing/fake-ai-provider';
import type { PlanChangeOperation } from '../../programs/contracts/plan-change.contract';
import { planTreeSchema, type PlanTree } from '../../programs/contracts/plan-tree.contract';
import type { PlanSignals } from '../../programs/signals/plan-signals.contract';
import type { ApplyChangeInput } from '../../programs/programs.service';
import type { EvaluationResult } from '../agents/evaluator/evaluation-result.contract';
import { lockedWorkoutIdsOf } from '../evaluation/build-evaluator-context';
import { evidenceOf } from '../finalize/plan-evidence';
import type { EvaluationPort, NotificationsPort, ProgramsPort } from '../graph/node-context';
import { ADAPT_AS_OF, ADAPT_START, type AdaptationFixture } from './adaptation-fixtures';
import { LIB } from './context-fixtures';
import { CANARY } from './evaluation-fixtures';
import type { AgentScript } from './node-context-harness';
import { SCRIPT_USAGE } from './agent-scripts';
import { STUB_VERIFIED_BRIEF } from './stub-agent-nodes';

// =============================================================================
// An in-memory plan store behind the evaluate graph's ports, and scripted
// evaluator answers, for scenario specs over the fake provider.
//
// The store follows the chokepoint's contract where the nodes can observe
// it: a stale `expectedVersion` is a 409 `TRAINING_STALE_PLAN` that changes
// nothing; the tree must parse; new rows get ids; an approved proposal row
// becomes the applied entry. Every write and notification lands in one
// ordered `log`, so a spec can assert that a notification came after the
// write. The real transaction is proven by the Postgres spec.
// =============================================================================

export interface StoreEntry {
  id: string;
  kind: string;
  actor: string;
  status: string;
  fromVersion: number | null;
  toVersion: number | null;
  runId: string | null;
  summary: string;
  rationale: string | null;
  operations: unknown[];
  citations: unknown[];
  createdAt: Date;
  decidedAt: Date | null;
}

export interface EvaluationStore {
  tree: PlanTree;
  version: number;
  versions: Array<{ versionNumber: number; runId: string | null; origin: string; tree: PlanTree }>;
  changeLog: StoreEntry[];
  pausedReason: string | null;
  linkedWorkoutIds: string[];
  log: string[];
  notifications: Array<{ eventKey: string; userId: string; data: unknown }>;
}

function withRowIds(tree: PlanTree): PlanTree {
  for (const block of tree.blocks)
    for (const week of block.weeks)
      for (const workout of week.workouts) {
        workout.id ??= randomUUID();
        for (const exercise of workout.exercises) exercise.id ??= randomUUID();
      }
  return tree;
}

export function createEvaluationStore(fixture: AdaptationFixture, opts: { painNotes?: string[] } = {}) {
  const store: EvaluationStore = {
    tree: structuredClone(fixture.tree),
    version: fixture.sources.program.currentVersion,
    versions: [{ versionNumber: fixture.sources.program.currentVersion, runId: null, origin: 'ai_create', tree: structuredClone(fixture.tree) }],
    changeLog: fixture.sources.changeLog.map((row) => ({
      id: randomUUID(),
      kind: row.kind,
      actor: row.actor,
      status: row.status,
      fromVersion: null,
      toVersion: null,
      runId: null,
      summary: row.summary,
      rationale: null,
      operations: Array.isArray(row.operations) ? row.operations : [],
      citations: [],
      createdAt: row.createdAt,
      decidedAt: row.decidedAt ?? null,
    })),
    pausedReason: fixture.sources.program.autonomyPausedReason,
    linkedWorkoutIds: [...fixture.sources.linkedProgramWorkoutIds],
    log: [],
    notifications: [],
  };
  const programId = fixture.sources.program.id;
  const entry = (over: Partial<StoreEntry>): StoreEntry => ({
    id: randomUUID(),
    kind: 'adapted',
    actor: 'ai',
    status: 'applied',
    fromVersion: store.version,
    toVersion: store.version,
    runId: null,
    summary: '',
    rationale: null,
    operations: [],
    citations: [],
    createdAt: new Date(),
    decidedAt: null,
    ...over,
  });

  const evaluation: EvaluationPort = {
    loadSources: async (_userId, id) =>
      id !== programId
        ? null
        : {
            ...fixture.sources,
            program: { ...fixture.sources.program, currentVersion: store.version, autonomyPausedReason: store.pausedReason },
            tree: structuredClone(store.tree),
            linkedProgramWorkoutIds: [...store.linkedWorkoutIds],
            changeLog: [...store.changeLog].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 10),
            evidence: [evidenceOf(STUB_VERIFIED_BRIEF)],
          },
    recentPainNotes: async () => opts.painNotes ?? [],
    recordReview: async (input) => {
      const row = entry({ kind: 'reviewed', actor: input.actor, runId: input.runId ?? null, summary: input.summary, rationale: input.rationale ?? null, citations: input.citations ?? [] });
      store.changeLog.push(row);
      let paused = false;
      if (input.pause && store.pausedReason === null) {
        store.pausedReason = input.pause;
        paused = true;
      }
      store.log.push('recordReview');
      return { changeLogId: row.id, versionNumber: store.version, paused };
    },
    findRunReview: async (_userId, runId, actor) => {
      const row = store.changeLog.find((r) => r.runId === runId && r.kind === 'reviewed' && r.actor === actor);
      return row ? { changeLogId: row.id } : null;
    },
    loadAdaptationFacts: async (_userId, id) =>
      id !== programId
        ? null
        : {
            currentVersion: store.version,
            tree: structuredClone(store.tree),
            lockedWorkoutIds: lockedWorkoutIdsOf(store.tree, ADAPT_START, ADAPT_AS_OF, new Set(store.linkedWorkoutIds)),
            guardrails: fixture.guardrails,
            brief: STUB_VERIFIED_BRIEF,
          },
    recordUnappliedChange: async (input) => {
      const row = entry({
        status: input.status,
        fromVersion: input.fromVersion,
        toVersion: null,
        runId: input.runId ?? null,
        summary: input.summary,
        rationale: input.rationale ?? null,
        operations: input.operations ?? [],
        citations: input.citations ?? [],
        decidedAt: input.status === 'proposed' ? null : new Date(),
      });
      store.changeLog.push(row);
      store.log.push(`record:${input.status}`);
      return { changeLogId: row.id };
    },
    findRunUnapplied: async (_userId, runId) => {
      const row = [...store.changeLog].reverse().find((r) => r.runId === runId && r.kind === 'adapted' && r.toVersion === null);
      return row ? { changeLogId: row.id, status: row.status, fromVersion: row.fromVersion } : null;
    },
    resolveProposal: async (_userId, changeLogId, status) => {
      const row = store.changeLog.find((r) => r.id === changeLogId && r.status === 'proposed');
      if (!row) return false;
      row.status = status;
      row.decidedAt = new Date();
      store.log.push(`resolve:${status}`);
      return true;
    },
  };

  const programs: ProgramsPort = {
    createWithTree: async () => {
      throw new Error('not used by the evaluate graph');
    },
    recentAiEvidence: async () => [],
    applyChange: async (input: ApplyChangeInput) => {
      if (input.expectedVersion !== store.version) {
        throw new ConflictException({ message: 'stale', details: { reason: 'TRAINING_STALE_PLAN', currentVersion: store.version } });
      }
      const tree = withRowIds(planTreeSchema.parse(input.mutate(structuredClone(store.tree))) as PlanTree);
      const versionNumber = store.version + 1;
      let changeLogId: string;
      if (input.proposalLogId) {
        const row = store.changeLog.find((r) => r.id === input.proposalLogId && r.status === 'proposed');
        if (!row) throw new ConflictException({ message: 'decided', details: { reason: 'NOT_PROPOSED' } });
        Object.assign(row, { status: 'applied', fromVersion: input.expectedVersion, toVersion: versionNumber, decidedAt: new Date(), operations: input.operations ?? [] });
        changeLogId = row.id;
      } else {
        const row = entry({
          kind: input.kind,
          actor: input.actor,
          fromVersion: input.expectedVersion,
          toVersion: versionNumber,
          runId: input.runId ?? null,
          summary: input.summary,
          rationale: input.rationale ?? null,
          operations: input.operations ?? [],
          citations: input.citations ?? [],
        });
        store.changeLog.push(row);
        changeLogId = row.id;
      }
      store.tree = tree;
      store.version = versionNumber;
      store.versions.push({ versionNumber, runId: input.runId ?? null, origin: input.origin, tree: structuredClone(tree) });
      store.log.push('applyChange');
      return { versionNumber, changeLogId, warnings: [] };
    },
    findRunVersion: async (_userId, runId) => {
      const version = [...store.versions].reverse().find((v) => v.runId === runId);
      if (!version) return null;
      const log = store.changeLog.find((r) => r.runId === runId && r.toVersion === version.versionNumber);
      return { programId, programName: 'Plan', versionNumber: version.versionNumber, changeLogId: log?.id ?? null };
    },
  };

  const notifications: NotificationsPort = {
    notify: (eventKey, userId, data) => {
      store.log.push(`notify:${eventKey}`);
      store.notifications.push({ eventKey, userId, data });
    },
  };

  /** A manual edit landing meanwhile (the owner's own change): bumps the version. */
  const manualEdit = (mutate: (tree: PlanTree) => void = () => undefined) => {
    const tree = structuredClone(store.tree);
    mutate(tree);
    store.tree = withRowIds(tree);
    store.version += 1;
    store.versions.push({ versionNumber: store.version, runId: null, origin: 'manual_edit', tree: structuredClone(store.tree) });
  };

  return { store, ports: { evaluation, programs, notifications }, manualEdit, programId };
}

export type EvaluationStoreHarness = ReturnType<typeof createEvaluationStore>;

/**
 * Signals of a plateau as of `ADAPT_AS_OF`: weeks 1 to 3's past sessions done
 * at RPE 7, the back squat at 100 kg x 8 (the top of its 5-8 range) three
 * times running, readiness fine, no pain.
 */
export function plateauSignals(tree: PlanTree): (signals: PlanSignals) => void {
  return (signals) => {
    const weeks = tree.blocks[0].weeks.slice(0, 3);
    for (const week of weeks) {
      for (const workout of week.workouts) {
        const date = new Date(`${ADAPT_START}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() + 7 * (week.weekNumber - 1) + ((workout.weekday ?? 1) - 1));
        const plannedFor = date.toISOString().slice(0, 10);
        if (plannedFor > ADAPT_AS_OF) continue;
        signals.sessions.push({
          programWorkoutId: workout.id!,
          name: CANARY.workoutName,
          plannedFor,
          status: 'done',
          workoutId: randomUUID(),
          setsPlanned: 9,
          setsDone: 9,
          completionPct: 100,
          avgRpe: 7,
        });
      }
    }
    signals.performance.push({
      exerciseId: LIB.barbell_back_squat.id,
      slug: 'barbell_back_squat',
      name: CANARY.exerciseName,
      sessions: 3,
      best: { weightKg: 100, reps: 8, e1rmKg: 126.7 },
      lastTopSets: [
        { date: '2026-09-21', weightKg: 100, reps: 8, rpe: 7 },
        { date: '2026-09-14', weightKg: 100, reps: 8, rpe: 7 },
        { date: '2026-09-07', weightKg: 100, reps: 8, rpe: 7.5 },
      ],
      trend: 'flat',
      trendPct: 0,
      prInRange: false,
    });
    signals.adherence.completedStreak = 7;
  };
}

/** An `EvaluationResult` with defaults for everything not given. */
export function evaluationResult(over: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    assessment: { status: 'on_track', summary: 'Training is on track.', observations: [] },
    decision: 'no_change',
    changes: [],
    userMessage: 'Your plan stays as it is.',
    followUp: { suggestReview: false, note: null },
    confidence: 'moderate',
    evidenceRefs: [],
    ...over,
  };
}

/** A plateau response: one step up on week 4's squat, citing claim E3. */
export function plateauResult(changes: PlanChangeOperation[] = []): EvaluationResult {
  return evaluationResult({
    assessment: { status: 'stalled', summary: 'The squat has stayed at 100 kg for 8 reps at RPE 7 three times.', observations: [{ signal: 'performance', text: 'Squat top sets flat at the top of the range.' }] },
    decision: 'adjust',
    changes,
    userMessage: 'You hit the top of your squat range three times, so next week goes up by one small step.',
    evidenceRefs: ['E3'],
  });
}

/** An evaluator script answering `results[i]` on its i-th call (the last repeats); `seen` records requests. */
export function evaluatorScript(
  results: Array<EvaluationResult | (() => FakeAiScriptedResponse)>,
  seen: AiResponseRequest[] = [],
): AgentScript {
  let i = 0;
  return (req) => {
    seen.push(req);
    const next = results[Math.min(i, results.length - 1)];
    i += 1;
    return typeof next === 'function' ? next() : { outputText: JSON.stringify(next), usage: SCRIPT_USAGE };
  };
}
