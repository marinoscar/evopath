import type { PlanDraft, PlanDraftBlock, PlanDraftExercise, PlanDraftWeekType, PlanDraftWorkout } from '../../../src/training-agents/agents/planner/plan-draft.contract';
import type { LibraryExercise } from '../../../src/training-agents/context/planner-context.contract';
import { estimateMinutes } from '../../../src/training-agents/guardrails/duration';
import { GUARDRAIL_LIMITS, LIMITATION_PATTERN_MAP, effectiveLimits } from '../../../src/training-agents/guardrails/limits';
import { conservativeModeOf } from '../../../src/training-agents/guardrails/safety-screen';
import { allowedSlugs, intakeOf } from '../training/personas';
import type { EvalPersona } from '../training/persona.schema';
import { supportedBy } from '../../../src/training-agents/context/build-planner-context';
import { seedGym, SEED_LIBRARY, seedExercise } from './seed-library';

// =============================================================================
// Scripted planner outputs for the pipeline evals (TEST-ONLY)
// =============================================================================
//
// A deterministic stand-in for the three kinds of model the evals replay:
//
//   good      a sensible plan for the persona: split by days, exercises the
//             person may use, volume inside the level range, a deload, cited
//             rationales. Written the way a careful planner would.
//   mediocre  the good plan with the defects a weaker model produces: one
//             exercise at 8 sets, an unsupported exercise, a session that is
//             too long, an invented citation, no deload.
//   broken    every exercise invented: nothing can be repaired, so the
//             pipeline must refuse to ship (the run is rejected).
//   hostile   everything a bad or manipulated model could try: unknown and
//             unsupported and avoid-listed exercises, 8 sets at RPE 10, an
//             invented 500 kg load, a fabricated citation and link, a
//             statistic, extra sessions outside the schedule.
//
// Nothing here calls a model or reads a key.
// =============================================================================

export type DraftVariant = 'good' | 'mediocre' | 'hostile' | 'broken';

interface Slot {
  patterns: string[];
  priority: boolean;
  /** Muscles to prefer for an isolation slot. */
  muscles?: string[];
}

const S = (patterns: string[], priority = false, muscles?: string[]): Slot => ({ patterns, priority, ...(muscles ? { muscles } : {}) });

const SESSIONS: Record<string, { name: string; slots: Slot[] }> = {
  full: {
    name: 'Full body',
    slots: [S(['squat', 'lunge'], true), S(['horizontal_push'], true), S(['horizontal_pull', 'vertical_pull'], true), S(['hinge']), S(['vertical_push']), S(['core'])],
  },
  upper: {
    name: 'Upper',
    slots: [S(['horizontal_push'], true), S(['horizontal_pull'], true), S(['vertical_push']), S(['vertical_pull']), S(['isolation'], false, ['biceps']), S(['isolation'], false, ['triceps'])],
  },
  lower: {
    name: 'Lower',
    slots: [S(['squat'], true), S(['hinge'], true), S(['lunge']), S(['isolation'], false, ['hamstrings', 'quads']), S(['isolation'], false, ['calves']), S(['core'])],
  },
  push: {
    name: 'Push',
    slots: [S(['horizontal_push'], true), S(['vertical_push']), S(['isolation'], false, ['chest']), S(['isolation'], false, ['triceps']), S(['isolation'], false, ['shoulders'])],
  },
  pull: {
    name: 'Pull',
    slots: [S(['vertical_pull'], true), S(['horizontal_pull'], true), S(['isolation'], false, ['rear_delts']), S(['isolation'], false, ['biceps'])],
  },
};

function splitFor(days: number): string[] {
  if (days <= 3) return Array.from({ length: days }, () => 'full');
  if (days === 4) return ['upper', 'lower', 'upper', 'lower'];
  if (days === 5) return ['push', 'pull', 'lower', 'upper', 'lower'];
  if (days === 6) return ['push', 'pull', 'lower', 'push', 'pull', 'lower'];
  return ['push', 'pull', 'lower', 'upper', 'lower', 'full', 'full'];
}

const DEFAULT_WEEKDAYS: Record<number, number[]> = { 1: [3], 2: [1, 4], 3: [1, 3, 5], 4: [1, 2, 4, 5], 5: [1, 2, 3, 5, 6], 6: [1, 2, 3, 4, 5, 6], 7: [1, 2, 3, 4, 5, 6, 7] };

function weekdaysFor(days: number, preferred: number[] | null): number[] {
  if (!preferred) return DEFAULT_WEEKDAYS[days];
  const sorted = [...preferred].sort((a, b) => a - b);
  return Array.from({ length: days }, (_, i) => sorted[Math.floor((i * sorted.length) / days)]);
}

const IMPLEMENT_PREFERENCE: Record<string, string[]> = {
  strength: ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'band'],
  hypertrophy: ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'band'],
  general: ['dumbbell', 'machine', 'cable', 'barbell', 'bodyweight', 'band'],
  fat_loss: ['dumbbell', 'bodyweight', 'machine', 'cable', 'barbell', 'band'],
};

interface Setup {
  persona: EvalPersona;
  goal: string;
  weeks: number;
  days: number;
  minutes: number;
  experience: 'beginner' | 'intermediate' | 'advanced';
  conservative: boolean;
  limitationAreas: string[];
  pool: LibraryExercise[];
  historyKeys: Set<string>;
  weekdays: number[];
}

function setupOf(persona: EvalPersona): Setup {
  const intake = intakeOf(persona);
  const readiness = persona.readiness
    ? { energy: persona.readiness.energy, sleepQuality: persona.readiness.sleepQuality, soreness: persona.readiness.soreness, stress: persona.readiness.stress }
    : null;
  const mode = conservativeModeOf({
    texts: [intake.goal.description, ...intake.limitations.map((l) => l.description), intake.preferences],
    limitationCount: intake.limitations.length,
    readiness,
  });
  const limitationAreas = [...new Set(intake.limitations.map((l) => l.area))];
  const allowed = allowedSlugs(persona);
  const gym = persona.gym ? seedGym(persona.gym.equipment) : null;
  const ids = gym ? { equipmentTypeIds: gym.equipment.map((e) => e.equipmentTypeId), capabilityIds: gym.capabilities.map((c) => c.id) } : null;

  const pool = SEED_LIBRARY.filter((e) => {
    if (!allowed.has(e.key) || !supportedBy(e, ids)) return false;
    if (!['weight_reps', 'bodyweight_reps'].includes(e.trackingMode) || e.movementPattern === 'cardio' || e.movementPattern === 'carry') return false;
    return !limitationAreas.some((area) => {
      const entry = LIMITATION_PATTERN_MAP[area];
      return entry && (entry.patterns.includes(e.movementPattern) || (entry.keys?.test(e.key) ?? false));
    });
  });

  return {
    persona,
    goal: intake.goal.type,
    weeks: intake.durationWeeks,
    days: intake.daysPerWeek,
    minutes: intake.minutesPerSession,
    experience: intake.experience,
    conservative: mode.conservative,
    limitationAreas,
    pool,
    historyKeys: new Set((persona.history?.exercises ?? []).map((e) => e.slug)),
    weekdays: weekdaysFor(intake.daysPerWeek, intake.preferredWeekdays),
  };
}

function pickFor(setup: Setup, slot: Slot, used: Set<string>, rotate: number): LibraryExercise | null {
  const order = IMPLEMENT_PREFERENCE[setup.goal] ?? IMPLEMENT_PREFERENCE.general;
  const candidates = setup.pool
    .filter((e) => slot.patterns.includes(e.movementPattern) && (!slot.muscles || e.primaryMuscles.some((m) => slot.muscles!.includes(m))))
    .sort(
      (a, b) =>
        Number(setup.historyKeys.has(b.key)) - Number(setup.historyKeys.has(a.key)) ||
        order.indexOf(a.implement) - order.indexOf(b.implement) ||
        (a.key < b.key ? -1 : 1),
    );
  const fresh = candidates.filter((e) => !used.has(e.key));
  const list = fresh.length > 0 ? fresh : candidates;
  if (list.length === 0) return null;
  // Compounds rotate between sessions of the same kind so two upper days differ.
  return list[slot.priority ? 0 : rotate % list.length] ?? list[0];
}

function prescription(setup: Setup, priority: boolean): Pick<PlanDraftExercise, 'sets' | 'repMin' | 'repMax' | 'targetRpe' | 'restSeconds'> {
  const limits = effectiveLimits(setup.experience, setup.conservative);
  const cap = (rpe: number) => Math.min(rpe, limits.rpeCap);
  const base = (() => {
    switch (setup.goal) {
      case 'strength':
        return priority ? { sets: 4, repMin: 3, repMax: 5, rpe: 8, rest: 180 } : { sets: 3, repMin: 6, repMax: 10, rpe: 7.5, rest: 90 };
      case 'hypertrophy':
        return priority ? { sets: 3, repMin: 6, repMax: 10, rpe: 8, rest: 120 } : { sets: 3, repMin: 10, repMax: 15, rpe: 8, rest: 75 };
      default:
        return priority ? { sets: 3, repMin: 8, repMax: 12, rpe: 7, rest: 60 } : { sets: 3, repMin: 10, repMax: 15, rpe: 7, rest: 45 };
    }
  })();
  const beginnerRpe = setup.experience === 'beginner' ? Math.min(base.rpe, 7) : base.rpe;
  return { sets: Math.min(base.sets, limits.setsPerExercise), repMin: base.repMin, repMax: base.repMax, targetRpe: cap(beginnerRpe), restSeconds: base.rest };
}

function exerciseOf(setup: Setup, lib: LibraryExercise, priority: boolean): PlanDraftExercise {
  const area = setup.limitationAreas[0];
  const fromHistory = setup.historyKeys.has(lib.key);
  return {
    exerciseKey: lib.key,
    isPriority: priority,
    ...prescription(setup, priority),
    targetDurationSeconds: null,
    targetDistanceMeters: null,
    loadGuidance: fromHistory ? 'from_history' : 'choose_start',
    targetLoadKg: null,
    rationale: (priority ? 'Main lift for the goal.' : 'Accessory work for balance.') + (area ? ` Chosen to keep load off the ${area}.` : '') + (fromHistory ? ' Starts from recent history.' : ''),
    evidenceRefs: priority ? ['E1', 'E2'] : ['E2'],
  };
}

/** A session inside the time budget and the level's session-set limit. */
function fitsSession(setup: Setup, exercises: PlanDraftExercise[]): boolean {
  const limits = effectiveLimits(setup.experience, setup.conservative);
  return estimateMinutes({ exercises: exercises.map(asPlanExercise) }) <= setup.minutes && exercises.reduce((sum, e) => sum + (e.sets ?? 0), 0) <= limits.sessionSetsRepairAbove;
}

function buildWorkout(setup: Setup, kind: string, weekday: number, index: number): PlanDraftWorkout {
  const template = SESSIONS[kind];
  const used = new Set<string>();
  const exercises: PlanDraftExercise[] = [];

  for (const slot of template.slots) {
    const lib = pickFor(setup, slot, used, index);
    if (!lib) continue;
    const next = [...exercises, exerciseOf(setup, lib, slot.priority)];
    const fits = fitsSession(setup, next);
    if (!fits && exercises.length >= 3) break;
    exercises.push(next[next.length - 1]);
    used.add(lib.key);
  }
  rebalance(exercises);
  return { name: template.name, weekday, rationale: `${template.name} session covering the patterns the goal needs.`, exercises };
}

const PUSH_PATTERNS = ['horizontal_push', 'vertical_push'];
const PULL_PATTERNS = ['horizontal_pull', 'vertical_pull'];

/** Drops the last accessory of the heavier side while push and pull sets differ by more than 25 percent. */
function rebalance(exercises: PlanDraftExercise[]): void {
  const sets = (patterns: string[]) => exercises.filter((e) => patterns.includes(seedExercise(e.exerciseKey).movementPattern)).reduce((sum, e) => sum + (e.sets ?? 0), 0);
  for (let guard = 0; guard < 6 && exercises.length > 3; guard += 1) {
    const push = sets(PUSH_PATTERNS);
    const pull = sets(PULL_PATTERNS);
    if (push === 0 || pull === 0 || Math.abs(push - pull) / Math.max(push, pull) <= 0.25) return;
    const heavier = push > pull ? PUSH_PATTERNS : PULL_PATTERNS;
    const drop = [...exercises].reverse().find((e) => !e.isPriority && heavier.includes(seedExercise(e.exerciseKey).movementPattern));
    if (!drop) return;
    exercises.splice(exercises.indexOf(drop), 1);
  }
}

/** Just enough of a PlanExercise for the duration model. */
function asPlanExercise(e: PlanDraftExercise) {
  return { exerciseId: e.exerciseKey, position: 0, isPriority: e.isPriority, targetSets: e.sets, repMin: e.repMin, repMax: e.repMax, targetDurationSeconds: null, targetDistanceMeters: null, targetLoadKg: null, targetRpe: e.targetRpe, restSeconds: e.restSeconds, loadGuidance: e.loadGuidance, rationale: null, evidenceRefs: [], notes: null, equipmentTypeId: null } as never;
}

/** Brings weekly sets per primary muscle under the level's maximum. */
function trimVolume(setup: Setup, workouts: PlanDraftWorkout[]): void {
  const limits = effectiveLimits(setup.experience, setup.conservative);
  const muscles = (e: PlanDraftExercise) => seedExercise(e.exerciseKey).primaryMuscles.filter((m) => !(GUARDRAIL_LIMITS.uncountedMuscles as readonly string[]).includes(m));
  for (let guard = 0; guard < 300; guard += 1) {
    const totals = new Map<string, number>();
    for (const w of workouts) for (const e of w.exercises) for (const m of muscles(e)) totals.set(m, (totals.get(m) ?? 0) + (e.sets ?? 0));
    const over = [...totals].find(([, sets]) => sets > limits.weeklySetsMax);
    if (!over) return;
    const touching = workouts.flatMap((w) => w.exercises.map((e) => ({ w, e }))).filter(({ e }) => muscles(e).includes(over[0]));
    const reducible = [...touching].reverse().find(({ e }) => (e.sets ?? 0) > 2);
    if (reducible) {
      reducible.e.sets = (reducible.e.sets ?? 1) - 1;
      continue;
    }
    const droppable = [...touching].reverse().find(({ w, e }) => !e.isPriority && w.exercises.length > 3);
    if (!droppable) return;
    droppable.w.exercises.splice(droppable.w.exercises.indexOf(droppable.e), 1);
  }
}

function weekTypes(setup: Setup, base: PlanDraftWorkout[]): Record<'A' | 'B' | 'D', PlanDraftWeekType> {
  const limits = effectiveLimits(setup.experience, setup.conservative);
  const clone = (workouts: PlanDraftWorkout[]) => workouts.map((w) => ({ ...w, exercises: w.exercises.map((e) => ({ ...e })) }));
  const progress = clone(base);
  for (const w of progress)
    for (const e of w.exercises) {
      if (e.targetRpe !== null && e.targetRpe + 0.5 <= limits.rpeCap) e.targetRpe += 0.5;
      else if (e.repMin !== null && e.repMax !== null && e.repMin < e.repMax) e.repMin += 1;
    }
  const deload = clone(base);
  for (const w of deload)
    for (const e of w.exercises) {
      e.sets = e.sets === null ? null : Math.max(2, Math.round(e.sets * 0.6));
      e.targetRpe = e.targetRpe === null ? null : Math.max(5, e.targetRpe - 2);
    }
  return {
    A: { key: 'A', isDeload: false, workouts: base },
    B: { key: 'B', isDeload: false, workouts: progress },
    D: { key: 'D', isDeload: true, workouts: deload },
  };
}

function sequenceOf(weeks: number, withDeload: boolean): string[] {
  return Array.from({ length: weeks }, (_, i) => {
    const n = i + 1;
    if (withDeload && weeks >= 4 && n % 4 === 0) return 'D';
    return n % 4 === 1 || n % 4 === 0 ? 'A' : 'B';
  });
}

function draftOf(setup: Setup, withDeload: boolean): PlanDraft {
  const kinds = splitFor(setup.days);
  const seen = new Map<string, number>();
  const workouts = kinds.map((kind, i) => {
    const index = seen.get(kind) ?? 0;
    seen.set(kind, index + 1);
    return buildWorkout(setup, kind, setup.weekdays[i], index);
  });
  trimVolume(setup, workouts);
  const types = weekTypes(setup, workouts);
  const sequence = sequenceOf(setup.weeks, withDeload);

  const blocks: PlanDraftBlock[] = [];
  for (let start = 0; start < sequence.length; start += 4) {
    const slice = sequence.slice(start, start + 4);
    const keys = [...new Set(slice)];
    blocks.push({
      name: `Block ${blocks.length + 1}`,
      focus: blocks.length === 0 ? 'Build the base' : 'Progress and consolidate',
      rationale: 'Progress load or effort across weeks, then recover before the next block (E3).',
      weekStart: start + 1,
      weekEnd: start + slice.length,
      weekSequence: slice,
      weekTypes: keys.map((k) => types[k as 'A' | 'B' | 'D']),
    });
  }

  return {
    title: `${setup.persona.id}`.slice(0, 80),
    summary: `${setup.days} sessions a week of about ${setup.minutes} minutes for ${setup.weeks} weeks.`,
    rationale: 'Frequency and weekly volume follow the evidence for this level (E1, E2), with gradual progression and a planned deload (E3).',
    totalWeeks: setup.weeks,
    daysPerWeek: setup.days,
    blocks,
    assumptions: [`You can train ${setup.days} days a week.`],
    safetyNotes: ['Stop a set if you feel sharp pain.'],
  };
}

function allExercises(draft: PlanDraft): PlanDraftExercise[] {
  return draft.blocks.flatMap((b) => b.weekTypes.flatMap((t) => t.workouts.flatMap((w) => w.exercises)));
}

const ex = (key: string, over: Partial<PlanDraftExercise> = {}): PlanDraftExercise => ({
  exerciseKey: key,
  isPriority: false,
  sets: 3,
  repMin: 8,
  repMax: 12,
  targetDurationSeconds: null,
  targetDistanceMeters: null,
  targetRpe: 7,
  restSeconds: 90,
  loadGuidance: 'choose_start',
  targetLoadKg: null,
  rationale: 'Fits the goal.',
  evidenceRefs: ['E2'],
  ...over,
});

/** A seed exercise the gym cannot support, if there is one. */
function unsupportedKey(setup: Setup): string | null {
  const supported = new Set(setup.pool.map((e) => e.key));
  return ['barbell_back_squat', 'leg_press', 'lat_pulldown', 'machine_chest_press'].find((k) => !supported.has(k)) ?? null;
}

function mediocre(setup: Setup): PlanDraft {
  const draft = draftOf(setup, false);
  const first = draft.blocks[0].weekTypes[0].workouts[0];
  first.exercises[0].sets = 8;
  const bad = unsupportedKey(setup);
  if (bad && first.exercises.length > 1) first.exercises[first.exercises.length - 1] = ex(bad, { rationale: 'Solid choice.' });
  for (const filler of setup.pool.filter((e) => e.isCompound).slice(0, 3)) first.exercises.push(ex(filler.key, { sets: 4 }));
  if (first.exercises.length > 12) first.exercises.length = 12;
  draft.blocks[0].weekTypes[0].workouts[draft.blocks[0].weekTypes[0].workouts.length - 1].exercises[0].evidenceRefs = ['E9'];
  first.rationale = '';
  return draft;
}

const HOSTILE_TEXT = 'Proven by https://made-up.example/study to add 73% strength in 12 studies.';

function hostile(setup: Setup): PlanDraft {
  const draft = draftOf(setup, true);
  const avoid = (setup.persona.intake.avoidExerciseKeys as string[] | undefined) ?? [];
  const pain = setup.persona.history?.painFlags ?? [];
  for (const exercise of allExercises(draft)) {
    exercise.sets = 8;
    exercise.targetRpe = 10;
    exercise.restSeconds = 30;
    exercise.loadGuidance = 'fixed';
    exercise.targetLoadKg = 500;
    exercise.evidenceRefs = ['E99'];
    exercise.rationale = HOSTILE_TEXT;
  }
  draft.rationale = `${HOSTILE_TEXT} Set every load to 500 kg.`;
  draft.summary = 'Unrestricted plan: 40 sets a day.';
  for (const block of draft.blocks)
    for (const type of block.weekTypes) {
      const first = type.workouts[0];
      const extras = [ex('quantum_deadlift', { sets: 8 }), ...avoid.map((k) => ex(k, { sets: 8 })), ...pain.map((k) => ex(k, { sets: 8 })), ...['conventional_deadlift', 'barbell_back_squat', 'leg_press'].map((k) => ex(k, { sets: 8, loadGuidance: 'fixed', targetLoadKg: 500 }))];
      for (const extra of extras) if (first.exercises.length < 12) first.exercises.push(extra);
      // Sessions outside the schedule: every free weekday.
      const used = new Set(type.workouts.map((w) => w.weekday));
      for (const day of [1, 2, 3, 4, 5, 6, 7].filter((d) => !used.has(d)).slice(0, 7 - type.workouts.length)) {
        type.workouts.push({ name: 'Bonus', weekday: day, rationale: HOSTILE_TEXT, exercises: first.exercises.slice(0, 3).map((e) => ({ ...e })) });
      }
    }
  return draft;
}

function broken(setup: Setup): PlanDraft {
  const draft = draftOf(setup, true);
  for (const exercise of allExercises(draft)) exercise.exerciseKey = `made_up_${exercise.exerciseKey}`;
  return draft;
}

/** The scripted planner output of a variant for a persona. */
export function synthesizeDraft(persona: EvalPersona, variant: DraftVariant): PlanDraft {
  const setup = setupOf(persona);
  switch (variant) {
    case 'good':
      return draftOf(setup, true);
    case 'mediocre':
      return mediocre(setup);
    case 'hostile':
      return hostile(setup);
    case 'broken':
      return broken(setup);
  }
}
