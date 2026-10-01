import { createHash } from 'node:crypto';

import { PLAN_LIMITS, type PlanTree } from '../../programs/contracts/plan-tree.contract';
import type { VerifiedEvidenceBrief } from '../agents/researcher/evidence-brief.contract';
import { draftIssues, expandDraftWeeks, type PlanDraft } from '../agents/planner/plan-draft.contract';
import type { LibraryExercise } from '../context/planner-context.contract';
import { sanitizeModelText } from '../guardrails/citations';
import { estimateMinutes } from '../guardrails/duration';
import { briefUrls, unverifiedStatistics } from '../guardrails/plan-citations';
import type { Violation } from '../guardrails/types';

// =============================================================================
// compilePlan: the planner's compact draft, expanded into a PlanTree
// =============================================================================
//
// PURE AND DETERMINISTIC, and it makes NO TRAINING DECISION: every block,
// week type, workout, exercise and number comes from the draft. For each
// week `expandDraftWeeks` yields, it copies the named week type with
// program-wide week numbers and the type's deload flag, maps `exerciseKey`
// to the library's exercise id (an unknown key becomes `unknown:<slug>`,
// left for G1 to report and drop), sets `estimatedMinutes` from the duration
// model, and passes every model text through `sanitizeModelText` (E5.4).
//
// Row ids are derived, not random: `uuid v8 = sha256(seed | path)`, so the
// same draft and seed always give the same tree (the seed is the run id and
// the draft round, which keeps them unique across runs).
// =============================================================================

export interface CompileContext {
  library: readonly LibraryExercise[];
  brief: VerifiedEvidenceBrief | null;
  /** Makes the derived row ids unique per run and round (`<runId>:<round>`). */
  seed: string;
}

/** The plan-level text of a draft, sanitised for `programs.name` / `programs.rationale`. */
export interface PlanHeader {
  title: string;
  summary: string;
  rationale: string;
  assumptions: string[];
  safetyNotes: string[];
}

export interface CompiledDraft {
  tree: PlanTree;
  header: PlanHeader;
  /** What the compiler had to fix or flag: draft inconsistencies (G1) and sanitised text (G8). */
  issues: Violation[];
}

/** A version-8 (custom) uuid from `seed` and `path`: stable across runs of the same input. */
export function derivedUuid(seed: string, path: string): string {
  const hex = createHash('sha256').update(`${seed}|${path}`).digest('hex').slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const UNKNOWN_SLUG = /^[a-z0-9][a-z0-9_-]{0,59}$/;

/** The exercise id for a key, or `unknown:<slug>` (a model-invented key is reduced to a safe slug). */
export function exerciseIdFor(key: string, byKey: ReadonlyMap<string, LibraryExercise>): string {
  const found = byKey.get(key);
  if (found) return found.id;
  const slug = key.trim().toLowerCase();
  return `unknown:${UNKNOWN_SLUG.test(slug) ? slug : 'invalid_key'}`;
}

export function compileDraft(draft: PlanDraft, context: CompileContext): CompiledDraft {
  const byKey = new Map(context.library.map((exercise) => [exercise.key, exercise]));
  const verified = briefUrls(context.brief);
  const issues: Violation[] = [];
  let sanitized = 0;

  const text = (value: string, max: number): string | null => {
    const clean = sanitizeModelText(value, max, verified);
    if (clean !== value.trim().replace(/\s+/g, ' ') && clean !== value) sanitized += 1;
    return clean === '' ? null : clean;
  };

  for (const issue of draftIssues(draft)) {
    issues.push({ rule: 'G1', severity: 'repair', code: 'draft_structure', path: 'plan', message: `The draft's week layout was normalised: ${issue}.` });
  }

  const weeks = expandDraftWeeks(draft);
  const blockOrder = [...new Set(weeks.map((w) => w.blockIndex))];

  const tree: PlanTree = {
    blocks: blockOrder.map((blockIndex, position) => {
      const block = draft.blocks[blockIndex];
      const blockPath = `b${position}`;
      return {
        id: derivedUuid(context.seed, blockPath),
        position,
        name: text(block.name, PLAN_LIMITS.nameMax) ?? `Block ${position + 1}`,
        focus: text(block.focus, PLAN_LIMITS.focusMax),
        rationale: text(block.rationale, PLAN_LIMITS.nodeRationaleMax),
        weeks: [] as PlanTree['blocks'][number]['weeks'],
      };
    }),
  };

  weeks.forEach((expanded, index) => {
    const weekNumber = index + 1;
    const target = tree.blocks[blockOrder.indexOf(expanded.blockIndex)];
    const weekPath = `w${weekNumber}`;

    target.weeks.push({
      id: derivedUuid(context.seed, weekPath),
      weekNumber,
      isDeload: expanded.type.isDeload,
      workouts: expanded.type.workouts.map((workout, w) => {
        const workoutPath = `${weekPath}.o${w}`;
        const exercises = workout.exercises.map((exercise, e) => ({
          id: derivedUuid(context.seed, `${workoutPath}.e${e}`),
          exerciseId: exerciseIdFor(exercise.exerciseKey, byKey),
          position: e,
          isPriority: exercise.isPriority,
          targetSets: exercise.sets,
          repMin: exercise.repMin,
          repMax: exercise.repMax,
          targetDurationSeconds: exercise.targetDurationSeconds,
          targetDistanceMeters: exercise.targetDistanceMeters,
          targetLoadKg: exercise.targetLoadKg,
          targetRpe: exercise.targetRpe,
          restSeconds: exercise.restSeconds,
          loadGuidance: exercise.loadGuidance,
          rationale: text(exercise.rationale, PLAN_LIMITS.nodeRationaleMax),
          evidenceRefs: exercise.evidenceRefs.map((ref) => sanitizeModelText(ref, PLAN_LIMITS.evidenceRefMax)).filter((ref) => ref !== ''),
          notes: null,
          equipmentTypeId: null,
        }));
        return {
          id: derivedUuid(context.seed, workoutPath),
          position: w,
          weekday: workout.weekday,
          name: text(workout.name, PLAN_LIMITS.nameMax) ?? `Workout ${w + 1}`,
          estimatedMinutes: Math.min(PLAN_LIMITS.estimatedMinutes.max, Math.max(1, estimateMinutes({ exercises }))),
          rationale: text(workout.rationale, PLAN_LIMITS.nodeRationaleMax),
          exercises,
        };
      }),
    });
  });

  const header: PlanHeader = {
    title: text(draft.title, PLAN_LIMITS.nameMax) ?? 'Training plan',
    summary: text(draft.summary, 600) ?? '',
    rationale: text(draft.rationale, PLAN_LIMITS.planRationaleMax) ?? '',
    assumptions: draft.assumptions.map((a) => text(a, 200)).filter((a): a is string => a !== null),
    safetyNotes: draft.safetyNotes.map((a) => text(a, 200)).filter((a): a is string => a !== null),
  };

  if (sanitized > 0) {
    issues.push({ rule: 'G8', severity: 'repair', code: 'text_sanitized', path: 'plan', message: `Removed links, markup, unverified URLs or instruction-like sentences from ${sanitized} model text${sanitized === 1 ? '' : 's'}.` });
  }
  for (const stat of new Set([...unverifiedStatistics(header.rationale, context.brief), ...unverifiedStatistics(header.summary, context.brief)])) {
    issues.push({ rule: 'G8', severity: 'warn', code: 'unverified_statistic', path: 'plan', message: `The plan rationale states "${stat}", which the evidence brief does not contain.` });
  }

  return { tree, header, issues };
}

/** The compiled tree alone (`compileDraft(...).tree`). */
export function compilePlan(draft: PlanDraft, context: CompileContext): PlanTree {
  return compileDraft(draft, context).tree;
}
