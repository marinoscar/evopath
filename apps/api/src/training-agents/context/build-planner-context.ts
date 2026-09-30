import { isAvailable } from '../../exercises/exercise-availability.service';
import { buildResearcherContext, type EquipmentClass } from '../agents/researcher/researcher-context';
import type { TrainingIntake } from '../contracts/training-intake.contract';
import type { PlanTree } from '../../programs/contracts/plan-tree.contract';
import { conservativeModeOf, type ReadinessAverages } from '../guardrails/safety-screen';
import { implementOfEquipment } from './implement';
import type {
  CandidateExercise,
  CompactPlan,
  ExerciseHistoryFacts,
  GymInventoryIds,
  HistoryExerciseRow,
  LibraryExercise,
  PlannerContext,
  TrainingRunContext,
} from './planner-context.contract';

// =============================================================================
// buildTrainingRunContext: the minimised context, from what the loader read
// =============================================================================
//
// PURE. The loader (`planner-context.loader.ts`) reads the caller's rows; this
// function copies an ALLOW-LIST of fields, field by field, into the sent
// halves (`planner`, `researcher`). Whatever else a source row carries is
// never copied. Exercises are named by slug; the date of birth becomes an
// integer age; body metrics are the latest weight, the latest body-fat
// percent and an 8-week trend; readiness is the 7-day average of the four
// numeric check-in scores only (never the note); history is summarised per
// exercise. A section with no data is omitted, not null.
// =============================================================================

export const CONTEXT_LIMITS = {
  maxCandidates: 150,
  historyWeeks: 6,
  painFlagDays: 28,
  weightTrendWeeks: 8,
  readinessDays: 7,
  bioChars: 500,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One logged set as the loader reads it (working-set rules from `workout-records.ts`). */
export interface SourceSet {
  weightKg: number | null;
  reps: number | null;
  completed: boolean;
  isWarmup: boolean;
  painFlag: boolean;
}

export interface SourceWorkout {
  /** Local calendar date `YYYY-MM-DD`. */
  date: string;
  startedAt: Date;
  completed: boolean;
  exercises: Array<{ exerciseId: string; sets: SourceSet[] }>;
}

/** Everything the loader read for one run, already scoped to the caller. */
export interface PlannerContextSource {
  now: Date;
  kind: 'create' | 'revise';
  intake: TrainingIntake;
  /** `revise` only. */
  revise?: { programId: string; basedOnVersion: number; instruction: string; currentPlan: PlanTree } | null;
  profile: {
    /** `YYYY-MM-DD`; turned into an integer age here and never copied. */
    dateOfBirth: string | null;
    sexAtBirth: string | null;
    heightMm: number | null;
    unitSystem: string;
    bio: string | null;
  } | null;
  /** Weight measurements in kg, any order. */
  weights: Array<{ measuredAt: Date; valueKg: number }>;
  latestBodyFatPercent: number | null;
  /** The intake's gym inventory; `null` when the intake names no gym. */
  gym: {
    equipment: Array<{ equipmentTypeId: string; slug: string; category: string }>;
    capabilities: Array<{ id: string; slug: string }>;
  } | null;
  library: LibraryExercise[];
  /** The caller's workouts of the last 6 weeks (completed and in progress). */
  workouts: SourceWorkout[];
  /** Check-ins of the last 7 local days. */
  checkIns: Array<{ date: string; energy: number | null; sleepQuality: number | null; soreness: number | null; stress: number | null }>;
}

// ---- relevance ----------------------------------------------------------------

const COMPOUND = ['squat', 'hinge', 'horizontal_push', 'vertical_push', 'horizontal_pull', 'vertical_pull'];

/** Lower is more relevant. Patterns not listed rank last. */
const GOAL_PATTERN_RANK: Record<TrainingIntake['goal']['type'], Record<string, number>> = {
  strength: { ...rank(COMPOUND, 0), lunge: 1, carry: 1, core: 2, isolation: 2, cardio: 3 },
  hypertrophy: { ...rank(COMPOUND, 0), lunge: 0, isolation: 1, core: 2, carry: 2, cardio: 3 },
  fat_loss: { ...rank(COMPOUND, 0), lunge: 0, cardio: 1, core: 1, carry: 1, isolation: 2 },
  endurance: { cardio: 0, squat: 1, hinge: 1, lunge: 1, core: 1, carry: 1, horizontal_push: 2, vertical_push: 2, horizontal_pull: 2, vertical_pull: 2, isolation: 2 },
  general: { ...rank(COMPOUND, 0), lunge: 1, core: 1, carry: 1, isolation: 1, cardio: 1 },
  custom: { ...rank(COMPOUND, 0), lunge: 1, core: 1, carry: 1, isolation: 1, cardio: 1 },
};

function rank(patterns: string[], value: number): Record<string, number> {
  return Object.fromEntries(patterns.map((p) => [p, value]));
}

export function relevanceRank(goal: TrainingIntake['goal']['type'], movementPattern: string): number {
  return GOAL_PATTERN_RANK[goal]?.[movementPattern] ?? 9;
}

const byName = (a: { name: string; key: string }, b: { name: string; key: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

// ---- helpers ------------------------------------------------------------------

const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;

function clip(text: string | null | undefined, max: number): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, max).join('').trim();
}

/** Whole years between a `YYYY-MM-DD` birth date and `now` (UTC calendar), or `null`. */
export function ageInYears(dateOfBirth: string | null, now: Date): number | null {
  if (!dateOfBirth || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return null;
  const [y, m, d] = dateOfBirth.split('-').map(Number);
  let age = now.getUTCFullYear() - y;
  const month = now.getUTCMonth() + 1;
  if (month < m || (month === m && now.getUTCDate() < d)) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/** Least-squares slope of weight over time, kg per week; `null` with fewer than two points or one day. */
export function weightTrend(points: Array<{ measuredAt: Date; valueKg: number }>): { kgPerWeek: number; points: number } | null {
  if (points.length < 2) return null;
  const xs = points.map((p) => p.measuredAt.getTime() / (7 * DAY_MS));
  const ys = points.map((p) => p.valueKg);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return null;
  return { kgPerWeek: round2(num / den), points: points.length };
}

/** The researcher's equipment class for a gym inventory (`null` = no gym). */
export function equipmentClassOf(gym: PlannerContextSource['gym']): EquipmentClass {
  if (!gym || gym.equipment.length === 0) return 'bodyweight';
  const classes = new Set(gym.equipment.map((e) => implementOfEquipment(e.slug, e.category)));
  const hasBarbell = classes.has('barbell');
  const hasMachines = classes.has('machine') || classes.has('cable');
  if (hasBarbell && hasMachines) return 'full_gym';
  if (hasBarbell || classes.has('dumbbell')) return 'home_basic';
  return 'minimal';
}

function averages(checkIns: PlannerContextSource['checkIns']): ReadinessAverages & { days: number } {
  const avg = (field: 'energy' | 'sleepQuality' | 'soreness' | 'stress') => {
    const values = checkIns.map((c) => c[field]).filter((v): v is number => typeof v === 'number');
    return values.length === 0 ? null : round1(values.reduce((a, b) => a + b, 0) / values.length);
  };
  return {
    energy: avg('energy'),
    sleepQuality: avg('sleepQuality'),
    soreness: avg('soreness'),
    stress: avg('stress'),
    days: new Set(checkIns.map((c) => c.date)).size,
  };
}

function workingSetsOf(sets: SourceSet[], trackingMode: string): Array<{ weightKg: number; reps: number }> {
  if (trackingMode !== 'weight_reps' && trackingMode !== 'bodyweight_reps') return [];
  const out: Array<{ weightKg: number; reps: number }> = [];
  for (const set of sets) {
    if (!set.completed || set.isWarmup || set.reps === null || set.reps < 1) continue;
    const weight = set.weightKg ?? (trackingMode === 'bodyweight_reps' ? 0 : null);
    if (weight === null) continue;
    out.push({ weightKg: Math.round(weight * 1000) / 1000, reps: set.reps });
  }
  return out;
}

const topSet = (sets: Array<{ weightKg: number; reps: number }>) =>
  sets.reduce<{ weightKg: number; reps: number } | null>(
    (best, s) => (!best || s.weightKg > best.weightKg || (s.weightKg === best.weightKg && s.reps > best.reps) ? s : best),
    null,
  );

/** History: the planner's summary rows and the server's per-exercise facts. */
export function summarizeHistory(
  source: Pick<PlannerContextSource, 'workouts' | 'now'>,
  library: ReadonlyMap<string, LibraryExercise>,
): { sessionsPerWeek: number[]; rows: HistoryExerciseRow[]; facts: ExerciseHistoryFacts[]; painFlagKeys: string[] } {
  const now = source.now.getTime();
  const windowStart = now - CONTEXT_LIMITS.historyWeeks * 7 * DAY_MS;
  const painStart = now - CONTEXT_LIMITS.painFlagDays * DAY_MS;

  const inWindow = source.workouts.filter((w) => w.startedAt.getTime() >= windowStart && w.startedAt.getTime() <= now);
  const completed = inWindow
    .filter((w) => w.completed)
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || (a.date < b.date ? 1 : -1));

  const sessionsPerWeek = Array.from({ length: CONTEXT_LIMITS.historyWeeks }, () => 0);
  for (const workout of completed) {
    const weeksAgo = Math.floor((now - workout.startedAt.getTime()) / (7 * DAY_MS));
    if (weeksAgo >= 0 && weeksAgo < CONTEXT_LIMITS.historyWeeks) sessionsPerWeek[CONTEXT_LIMITS.historyWeeks - 1 - weeksAgo] += 1;
  }

  const painKeys = new Set<string>();
  for (const workout of inWindow) {
    if (workout.startedAt.getTime() < painStart) continue;
    for (const exercise of workout.exercises) {
      const lib = library.get(exercise.exerciseId);
      if (lib && exercise.sets.some((s) => s.painFlag)) painKeys.add(lib.key);
    }
  }

  const rows = new Map<string, HistoryExerciseRow>();
  const facts = new Map<string, ExerciseHistoryFacts>();
  completed.forEach((workout, index) => {
    for (const exercise of workout.exercises) {
      const lib = library.get(exercise.exerciseId);
      if (!lib) continue;
      const working = workingSetsOf(exercise.sets, lib.trackingMode);
      if (working.length === 0) continue;
      const top = topSet(working)!;
      const best = Math.max(...working.map((s) => s.weightKg));

      const row = rows.get(lib.key);
      if (!row) {
        rows.set(lib.key, {
          key: lib.key,
          lastTopSet: { weightKg: top.weightKg, reps: top.reps },
          sessionsAgo: index + 1,
          bestRecentWorkingLoadKg: best,
        });
        facts.set(lib.id, {
          exerciseId: lib.id,
          key: lib.key,
          lastLoadKg: top.weightKg,
          lastDate: workout.date,
          lastMinReps: Math.min(...working.map((s) => s.reps)),
          bestRecentLoadKg: best,
          painFlagged: false,
        });
      } else {
        row.bestRecentWorkingLoadKg = Math.max(row.bestRecentWorkingLoadKg ?? 0, best);
        const fact = facts.get(lib.id)!;
        fact.bestRecentLoadKg = Math.max(fact.bestRecentLoadKg ?? 0, best);
      }
    }
  });

  for (const fact of facts.values()) fact.painFlagged = painKeys.has(fact.key);
  // A pain-flagged exercise with no working set still needs its fact for the guardrails.
  for (const key of painKeys) {
    const lib = [...library.values()].find((l) => l.key === key);
    if (lib && !facts.has(lib.id)) {
      facts.set(lib.id, { exerciseId: lib.id, key, lastLoadKg: null, lastDate: '', lastMinReps: null, bestRecentLoadKg: null, painFlagged: true });
    }
  }

  const sortedRows = [...rows.values()].sort((a, b) => a.sessionsAgo - b.sessionsAgo || (a.key < b.key ? -1 : 1));
  const sortedFacts = [...facts.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return { sessionsPerWeek, rows: sortedRows, facts: sortedFacts, painFlagKeys: [...painKeys].sort() };
}

/** Whether a gym (or no gym: needs nothing) supports an exercise. */
export function supportedBy(exercise: LibraryExercise, gym: GymInventoryIds | null): boolean {
  if (!gym) return exercise.requirements.length === 0;
  return isAvailable(exercise.requirements, gym);
}

/** Up to 150 candidates the gym supports, minus the avoid list and pain flags, by goal relevance then name. */
export function candidateExercises(args: {
  library: readonly LibraryExercise[];
  gym: GymInventoryIds | null;
  goal: TrainingIntake['goal']['type'];
  exclude: ReadonlySet<string>;
}): CandidateExercise[] {
  return args.library
    .filter((exercise) => !args.exclude.has(exercise.key) && supportedBy(exercise, args.gym))
    .sort((a, b) => relevanceRank(args.goal, a.movementPattern) - relevanceRank(args.goal, b.movementPattern) || byName(a, b))
    .slice(0, CONTEXT_LIMITS.maxCandidates)
    .map((exercise) => ({
      key: exercise.key,
      name: exercise.name,
      primaryMuscles: [...exercise.primaryMuscles],
      secondaryMuscles: [...exercise.secondaryMuscles],
      movementPattern: exercise.movementPattern,
      trackingMode: exercise.trackingMode,
      isCompound: exercise.isCompound,
      isUnilateral: exercise.isUnilateral,
    }));
}

/** A plan tree compacted like a draft: identical week contents once, keyed `W1`, `W2`, ... */
export function compactPlan(tree: PlanTree, library: ReadonlyMap<string, LibraryExercise>): CompactPlan {
  const types = new Map<string, string>();
  const weekTypes: CompactPlan['weekTypes'] = [];
  const weeks: CompactPlan['weeks'] = [];

  const blocks = [...tree.blocks].sort((a, b) => a.position - b.position);
  for (const block of blocks) {
    for (const week of [...block.weeks].sort((a, b) => a.weekNumber - b.weekNumber)) {
      const workouts = [...week.workouts]
        .sort((a, b) => a.position - b.position)
        .map((workout) => ({
          name: workout.name,
          weekday: workout.weekday ?? null,
          exercises: [...workout.exercises]
            .sort((a, b) => a.position - b.position)
            .map((exercise) => ({
              key: library.get(exercise.exerciseId)?.key ?? 'unknown',
              isPriority: exercise.isPriority,
              sets: exercise.targetSets,
              repMin: exercise.repMin,
              repMax: exercise.repMax,
              targetRpe: exercise.targetRpe ?? null,
              restSeconds: exercise.restSeconds,
              targetLoadKg: exercise.targetLoadKg ?? null,
            })),
        }));
      const signature = JSON.stringify(workouts);
      let key = types.get(signature);
      if (!key) {
        key = `W${weekTypes.length + 1}`;
        types.set(signature, key);
        weekTypes.push({ key, workouts });
      }
      weeks.push({ weekNumber: week.weekNumber, weekType: key, isDeload: week.isDeload, block: block.name });
    }
  }

  return { weekTypes, weeks };
}

/** The run context: the sent halves copied field by field, plus the server-only facts. */
export function buildTrainingRunContext(source: PlannerContextSource): TrainingRunContext {
  const { intake, now } = source;
  const libraryById = new Map(source.library.map((exercise) => [exercise.id, exercise]));
  const gym: GymInventoryIds | null = source.gym
    ? {
        equipmentTypeIds: [...new Set(source.gym.equipment.map((e) => e.equipmentTypeId))].sort(),
        capabilityIds: [...new Set(source.gym.capabilities.map((c) => c.id))].sort(),
      }
    : null;

  const history = summarizeHistory(source, libraryById);
  const readiness = averages(source.checkIns);
  const instruction = source.kind === 'revise' ? (source.revise?.instruction ?? null) : null;
  const mode = conservativeModeOf({
    texts: [intake.goal.description, ...intake.limitations.map((l) => l.description), intake.preferences, instruction],
    limitationCount: intake.limitations.length,
    readiness: readiness.days > 0 ? readiness : null,
  });

  const ageYears = ageInYears(source.profile?.dateOfBirth ?? null, now);
  const sexAtBirth =
    source.profile?.sexAtBirth === 'female' || source.profile?.sexAtBirth === 'male' ? source.profile.sexAtBirth : null;
  const equipmentClass = equipmentClassOf(source.gym);

  const exclude = new Set<string>([...intake.avoidExerciseKeys, ...history.painFlagKeys]);

  const planner: PlannerContext = {
    request: { kind: source.kind, instruction: instruction === null ? null : clip(instruction, 500) },
    goal: { type: intake.goal.type, description: clip(intake.goal.description, 300) },
    experience: intake.experience,
    daysPerWeek: intake.daysPerWeek,
    preferredWeekdays: intake.preferredWeekdays ? [...intake.preferredWeekdays].sort((a, b) => a - b) : null,
    minutesPerSession: intake.minutesPerSession,
    durationWeeks: intake.durationWeeks,
    limitations: intake.limitations.map((l) => ({ area: l.area, description: clip(l.description, 200) })),
    avoidExerciseKeys: [...intake.avoidExerciseKeys].sort(),
    preferences: clip(intake.preferences, 300),
    conservative: mode.conservative,
    equipment: {
      hasGym: source.gym !== null,
      equipmentClass,
      capabilityKeys: source.gym ? [...new Set(source.gym.capabilities.map((c) => c.slug))].sort() : [],
    },
    candidateExercises: candidateExercises({ library: source.library, gym, goal: intake.goal.type, exclude }),
  };

  if (source.profile) {
    planner.profile = {
      ageYears,
      sexAtBirth,
      heightCm: typeof source.profile.heightMm === 'number' ? round1(source.profile.heightMm / 10) : null,
      unitPreference: source.profile.unitSystem === 'imperial' ? 'imperial' : 'metric',
    };
  }

  const weights = [...source.weights].sort((a, b) => b.measuredAt.getTime() - a.measuredAt.getTime());
  if (weights.length > 0 || source.latestBodyFatPercent !== null) {
    const trendStart = now.getTime() - CONTEXT_LIMITS.weightTrendWeeks * 7 * DAY_MS;
    planner.bodyMetrics = {
      weightKg: weights.length > 0 ? round1(weights[0].valueKg) : null,
      bodyFatPercent: source.latestBodyFatPercent === null ? null : round1(source.latestBodyFatPercent),
      weightTrend: weightTrend(weights.filter((w) => w.measuredAt.getTime() >= trendStart)),
    };
  }

  if (history.rows.length > 0 || history.sessionsPerWeek.some((n) => n > 0) || history.painFlagKeys.length > 0) {
    planner.history = {
      sessionsPerWeek: history.sessionsPerWeek,
      exercises: history.rows,
      painFlagExerciseKeys: history.painFlagKeys,
    };
  }

  if (readiness.days > 0) {
    planner.readiness = {
      energy: readiness.energy,
      sleepQuality: readiness.sleepQuality,
      soreness: readiness.soreness,
      stress: readiness.stress,
      days: readiness.days,
    };
  }

  if (intake.includeBio && source.profile?.bio) {
    const bio = clip(source.profile.bio, CONTEXT_LIMITS.bioChars);
    if (bio) planner.bio = bio;
  }

  if (source.kind === 'revise' && source.revise) {
    planner.currentPlan = compactPlan(source.revise.currentPlan, libraryById);
  }

  const researcher = buildResearcherContext({
    goal: intake.goal,
    experience: intake.experience,
    daysPerWeek: intake.daysPerWeek,
    minutesPerSession: intake.minutesPerSession,
    equipmentClass,
    limitations: intake.limitations,
    preferences: intake.preferences,
    tailorResearch: intake.tailorResearch,
    ageYears,
    sexAtBirth,
  });

  return {
    version: 1,
    kind: source.kind,
    mode,
    researcher,
    planner,
    intake,
    library: source.library,
    gym,
    history: history.facts,
    revise:
      source.kind === 'revise' && source.revise
        ? { programId: source.revise.programId, basedOnVersion: source.revise.basedOnVersion }
        : null,
    builtAt: now.toISOString(),
  };
}
