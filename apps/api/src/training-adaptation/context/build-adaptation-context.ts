import { NEVER_SEND_LABELS } from '../../training-agents/context/never-send';
import { relevanceRank, supportedBy } from '../../training-agents/context/build-planner-context';
import type { GymInventoryIds, LibraryExercise } from '../../training-agents/context/planner-context.contract';
import type { SentDataSection, SentDataSummary } from '../../training-agents/context/summarize-context';
import { NONE_USED } from '../../training-agents/context/summarize-context';
import {
  TRAINING_EXPERIENCE_LEVELS,
  TRAINING_GOAL_TYPES,
  type TrainingExperience,
  type TrainingGoalType,
} from '../../training-agents/contracts/training-intake.contract';
import { readinessReasons, screenFreeText } from '../../training-agents/guardrails/safety-screen';
import { ADAPTATION_CONTEXT_LIMITS, ADAPTATION_RULES } from '../adaptation.constants';
import type { AdaptationRequest } from '../dto/adaptation-request.dto';
import {
  ADAPTATION_CONTEXT_VERSION,
  ADAPTATION_SENT_KEYS,
  type AdaptationBase,
  type AdaptationContext,
  AdaptationContextError,
  type AdaptationSafety,
  type AdaptationSentContext,
  type AdaptationSentKey,
  type BaseExercise,
} from './adaptation-context.contract';

// =============================================================================
// buildAdaptationContext: the minimised context, from what the builder read
// =============================================================================
//
// PURE (no Nest, no Prisma, no clock). `AdaptationContextBuilder` reads the
// caller's rows; this copies an ALLOW-LIST of fields into `sent`, field by
// field, and keeps the rest server-side in `facts`. The summary is rendered
// from `sent` itself.
// =============================================================================

/** Everything the builder read for one request, already scoped to the caller. */
export interface AdaptationContextSource {
  now: Date;
  /** The user's local day (Health Profile time zone). */
  today: string;
  request: AdaptationRequest;
  /** The active plan, when there is one (even on a rest day). */
  program: {
    id: string;
    goal: string;
    /** `programs.intake` (the E5 intake snapshot), read loosely. */
    intake: unknown;
    gymId: string | null;
  } | null;
  /** Today's planned workout, when `resolveToday` found one and the request wants it as the base. */
  planned: (Omit<AdaptationBase, 'gymId'> & { weekNumber: number; totalWeeks: number; isDeload: boolean; estimatedMinutes: number | null }) | null;
  /** The chosen gym (owned by the caller), or `null` for none. */
  gym: {
    id: string;
    type: string | null;
    equipment: Array<{ equipmentTypeId: string; name: string; quantity: number }>;
    /** Capabilities each equipment type provides. */
    capabilities: Array<{ equipmentTypeId: string; id: string; slug: string }>;
  } | null;
  library: LibraryExercise[];
  /** Exercises with a pain-flagged set in the last 28 days. */
  painFlagExerciseIds: string[];
  /** Today's check-in scores, when `useReadiness` and there is one. */
  checkIn: { energy: number | null; sleepQuality: number | null; soreness: number | null; stress: number | null } | null;
}

function clip(text: string | null | undefined, max: number): string {
  return [...(text ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
}

const byName = (a: { name: string; key: string }, b: { name: string; key: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

/** The plan intake's fields the adaptation uses, read loosely (an old snapshot never fails a request). */
export function intakeFacts(intake: unknown, goal: string): {
  experience: TrainingExperience;
  goal: TrainingGoalType;
  avoidKeys: string[];
  limitationAreas: string[];
} {
  const v = (intake && typeof intake === 'object' ? intake : {}) as Record<string, unknown>;
  const experience = (TRAINING_EXPERIENCE_LEVELS as readonly string[]).includes(String(v.experience))
    ? (v.experience as TrainingExperience)
    : 'beginner';
  const goalType = (TRAINING_GOAL_TYPES as readonly string[]).includes(goal) ? (goal as TrainingGoalType) : 'general';
  const avoidKeys = Array.isArray(v.avoidExerciseKeys) ? v.avoidExerciseKeys.filter((k): k is string => typeof k === 'string') : [];
  const limitationAreas = Array.isArray(v.limitations)
    ? v.limitations
        .map((l) => (l && typeof l === 'object' ? (l as { area?: unknown }).area : undefined))
        .filter((a): a is string => typeof a === 'string')
    : [];
  return {
    experience,
    goal: goalType,
    avoidKeys: [...new Set(avoidKeys)].sort(),
    limitationAreas: [...new Set(limitationAreas)].sort(),
  };
}

/** The inventory today's equipment choice allows; throws when an `only` type is not in the gym. */
export function effectiveInventory(
  request: AdaptationRequest,
  gym: AdaptationContextSource['gym'],
): { inventory: GymInventoryIds | null; names: string[] } {
  const mode = request.equipment?.mode ?? 'gym';
  if (!gym && request.equipment?.mode === 'only') {
    throw new AdaptationContextError('ADAPTATION_EQUIPMENT_NOT_IN_GYM', 'There is no gym to choose equipment from.', {
      equipmentTypeIds: request.equipment.equipmentTypeIds,
    });
  }
  if (!gym || mode === 'bodyweight') return { inventory: null, names: [] };

  const all = [...new Set(gym.equipment.map((e) => e.equipmentTypeId))].sort();
  let types = all;

  if (request.equipment?.mode === 'only') {
    const missing = request.equipment.equipmentTypeIds.filter((id) => !all.includes(id));
    if (missing.length > 0) {
      throw new AdaptationContextError(
        'ADAPTATION_EQUIPMENT_NOT_IN_GYM',
        'Some of the chosen equipment is not in this gym.',
        { equipmentTypeIds: missing },
      );
    }
    types = [...request.equipment.equipmentTypeIds].sort();
  }

  const capabilityIds = [...new Set(gym.capabilities.filter((c) => types.includes(c.equipmentTypeId)).map((c) => c.id))].sort();
  const names =
    mode === 'only'
      ? [...new Set(gym.equipment.filter((e) => types.includes(e.equipmentTypeId)).map((e) => e.name))].sort()
      : [];

  return { inventory: { equipmentTypeIds: types, capabilityIds }, names };
}

/** The free-text screen plus today's readiness: `blocked`, `conservative` or `ok`, with rule codes. */
export function adaptationSafetyOf(
  request: Pick<AdaptationRequest, 'freeText'>,
  checkIn: AdaptationContextSource['checkIn'],
  limitationCount: number,
): AdaptationSafety {
  const screen = screenFreeText([request.freeText ?? null]);
  if (screen.level === 'blocked') return { level: 'blocked', reasons: screen.reasons };

  const reasons = new Set<string>(screen.reasons);
  for (const reason of readinessReasons(checkIn)) reasons.add(reason);
  if (limitationCount > 0) reasons.add('limitation_declared');

  const sorted = [...reasons].sort();
  return { level: sorted.length > 0 ? 'conservative' : 'ok', reasons: sorted };
}

/** Whether today counts as a low-energy day: the request says so, or the check-in energy is low. */
export function isLowEnergy(request: Pick<AdaptationRequest, 'lowEnergy'>, checkIn: AdaptationContextSource['checkIn']): boolean {
  return (
    request.lowEnergy === true ||
    (checkIn?.energy != null && checkIn.energy <= ADAPTATION_RULES.lowEnergy.checkInEnergyAtMost)
  );
}

export function buildAdaptationContext(source: AdaptationContextSource): AdaptationContext {
  const { request, now } = source;
  const byId = new Map(source.library.map((e) => [e.id, e]));
  const intake = intakeFacts(source.program?.intake, source.program?.goal ?? 'general');
  const { inventory, names } = effectiveInventory(request, source.gym);

  const painFlagKeys = [...new Set(source.painFlagExerciseIds.map((id) => byId.get(id)?.key).filter((k): k is string => !!k))].sort();
  const checkIn = request.useReadiness ? source.checkIn : null;
  const safety = adaptationSafetyOf(request, checkIn, intake.limitationAreas.length);
  const lowEnergy = isLowEnergy(request, checkIn);
  const conservative = safety.level === 'conservative';

  const base: AdaptationBase | null = source.planned
    ? {
        programId: source.planned.programId,
        planVersion: source.planned.planVersion,
        planVersionId: source.planned.planVersionId,
        programWorkoutId: source.planned.programWorkoutId,
        name: source.planned.name,
        date: source.planned.date,
        gymId: source.program?.gymId ?? null,
        exercises: source.planned.exercises,
      }
    : null;

  const baseKeys = new Set(base?.exercises.map((e) => e.key) ?? []);
  const baseMuscles = new Set(base?.exercises.flatMap((e) => e.primaryMuscles) ?? []);
  const exclude = new Set<string>([...painFlagKeys, ...intake.avoidKeys]);

  const candidates = source.library
    .filter((e) => !baseKeys.has(e.key) && !exclude.has(e.key) && supportedBy(e, inventory))
    .sort(
      (a, b) =>
        (a.primaryMuscles.some((m) => baseMuscles.has(m)) ? 0 : 1) - (b.primaryMuscles.some((m) => baseMuscles.has(m)) ? 0 : 1) ||
        relevanceRank(intake.goal, a.movementPattern) - relevanceRank(intake.goal, b.movementPattern) ||
        byName(a, b),
    )
    .slice(0, ADAPTATION_CONTEXT_LIMITS.maxCandidates);

  const baseLibrary = (base?.exercises ?? [])
    .map((e) => byId.get(e.exerciseId))
    .filter((e): e is LibraryExercise => !!e);
  const library = [...new Map([...baseLibrary, ...candidates].map((e) => [e.id, e])).values()];

  const typeNames = new Map(source.gym?.equipment.map((e) => [e.equipmentTypeId, e.name]) ?? []);
  const gymEquipment =
    source.gym && inventory
      ? inventory.equipmentTypeIds.map((typeId) => ({
          name: typeNames.get(typeId) ?? 'equipment',
          quantity: source.gym!.equipment.filter((e) => e.equipmentTypeId === typeId).reduce((sum, e) => sum + e.quantity, 0),
          capabilities: [...new Set(source.gym!.capabilities.filter((c) => c.equipmentTypeId === typeId).map((c) => c.slug))].sort(),
        }))
      : [];

  const sent: AdaptationSentContext = {
    version: ADAPTATION_CONTEXT_VERSION,
    request: {
      minutes: request.minutes ?? null,
      soreness: request.soreness ? { muscles: [...request.soreness.muscles].sort(), level: request.soreness.level } : null,
      lowEnergy: request.lowEnergy === true,
      equipment: { mode: request.equipment?.mode ?? 'gym', names },
      freeText: request.freeText ? clip(request.freeText, 500) : null,
      baseWorkout: base ? 'planned' : 'none',
    },
    gym: {
      type: source.gym?.type ?? null,
      bodyweightOnly: inventory === null,
      equipment: gymEquipment,
    },
    candidates: candidates.map((e) => ({
      key: e.key,
      name: e.name,
      primaryMuscles: [...e.primaryMuscles],
      movementPattern: e.movementPattern,
      isCompound: e.isCompound,
      trackingMode: e.trackingMode,
    })),
    constraints: {
      experience: intake.experience,
      lowEnergy,
      conservative,
      avoidExerciseKeys: [...new Set([...intake.avoidKeys, ...painFlagKeys])].sort(),
      limitationAreas: intake.limitationAreas,
    },
  };

  if (source.program) {
    sent.plan = {
      goal: intake.goal,
      weekNumber: source.planned?.weekNumber ?? null,
      totalWeeks: source.planned?.totalWeeks ?? null,
      isDeload: source.planned?.isDeload ?? false,
      priorityExerciseKeys: (base?.exercises ?? []).filter((e) => e.isPriority).map((e) => e.key),
    };
  }

  if (base && source.planned) {
    sent.today = {
      estimatedMinutes: source.planned.estimatedMinutes,
      exercises: base.exercises.map((e) => ({
        key: e.key,
        name: e.name,
        primaryMuscles: [...e.primaryMuscles],
        isPriority: e.isPriority,
        sets: e.sets,
        repMin: e.repMin,
        repMax: e.repMax,
        targetRpe: e.targetRpe,
        restSeconds: e.restSeconds,
        availableHere: (() => {
          const lib = byId.get(e.exerciseId);
          return lib ? supportedBy(lib, inventory) : false;
        })(),
      })),
    };
    const lastSessions = base.exercises
      .filter((e) => e.lastTime)
      .map((e) => ({ key: e.key, date: e.lastTime!.performedOn, topSet: e.lastTime!.topSet ? { ...e.lastTime!.topSet } : null }));
    if (lastSessions.length > 0) sent.lastSessions = lastSessions;
  }

  if (checkIn && [checkIn.energy, checkIn.sleepQuality, checkIn.soreness, checkIn.stress].some((v) => v !== null)) {
    sent.readiness = {
      energy: checkIn.energy,
      sleepQuality: checkIn.sleepQuality,
      soreness: checkIn.soreness,
      stress: checkIn.stress,
    };
  }

  return {
    version: ADAPTATION_CONTEXT_VERSION,
    sent,
    safety,
    summary: summarizeAdaptationContext(sent),
    baseRef: base
      ? {
          planId: base.programId,
          planVersionId: base.planVersionId,
          planVersion: base.planVersion,
          planWorkoutId: base.programWorkoutId,
          date: base.date,
        }
      : null,
    facts: {
      today: source.today,
      base,
      gymId: source.gym?.id ?? null,
      gymEquipmentTypeIds: [...new Set(source.gym?.equipment.map((e) => e.equipmentTypeId) ?? [])].sort(),
      inventory,
      library,
      painFlagKeys,
      avoidKeys: intake.avoidKeys,
      limitationAreas: intake.limitationAreas,
      experience: intake.experience,
      goal: intake.goal,
      lowEnergy,
      conservative,
      builtAt: now.toISOString(),
    },
  };
}

// ---- the "what will be sent" summary ------------------------------------------

const TITLES: Record<AdaptationSentKey, string> = {
  request: 'Your request',
  plan: 'Plan',
  today: "Today's planned workout",
  gym: 'Equipment',
  candidates: 'Exercises that fit your equipment',
  lastSessions: 'Last session per exercise',
  readiness: "Today's readiness",
  constraints: 'Limits the coach must respect',
};

function itemsFor(key: AdaptationSentKey, sent: AdaptationSentContext): { items: string[]; count?: number } {
  switch (key) {
    case 'request': {
      const r = sent.request;
      const items = [
        r.baseWorkout === 'planned' ? "Adapt today's planned workout" : 'Build a fresh session (no planned workout)',
        ...(r.minutes !== null ? [`Time: ${r.minutes} minutes`] : []),
        ...(r.soreness ? [`Sore (${r.soreness.level}): ${r.soreness.muscles.join(', ')}`] : []),
        ...(r.lowEnergy ? ['Low energy'] : []),
        r.equipment.mode === 'only'
          ? `Only: ${r.equipment.names.join(', ')}`
          : r.equipment.mode === 'bodyweight'
            ? 'Bodyweight only'
            : 'The gym as it is',
        ...(r.freeText ? [`Your note: "${r.freeText}"`] : []),
      ];
      return { items };
    }
    case 'plan':
      if (!sent.plan) return { items: [NONE_USED] };
      return {
        items: [
          `Goal: ${sent.plan.goal}`,
          ...(sent.plan.weekNumber !== null ? [`Week ${sent.plan.weekNumber} of ${sent.plan.totalWeeks}${sent.plan.isDeload ? ' (deload)' : ''}`] : []),
          `Priority lifts: ${sent.plan.priorityExerciseKeys.length ? sent.plan.priorityExerciseKeys.join(', ') : 'none'}`,
        ],
      };
    case 'today':
      if (!sent.today) return { items: [NONE_USED] };
      return { items: ['Exercises (name and key), sets, reps, RPE and rest'], count: sent.today.exercises.length };
    case 'gym':
      return {
        items: sent.gym.bodyweightOnly
          ? ['Bodyweight only']
          : [`Gym type: ${sent.gym.type ?? 'not set'} (not its name or location)`, 'Equipment names, quantities and capabilities'],
        count: sent.gym.equipment.length,
      };
    case 'candidates':
      return { items: ['Name, key, muscles and movement pattern'], count: sent.candidates.length };
    case 'lastSessions':
      if (!sent.lastSessions) return { items: [NONE_USED] };
      return { items: ['Top set and date of the last session (not your full history)'], count: sent.lastSessions.length };
    case 'readiness':
      if (!sent.readiness) return { items: [NONE_USED] };
      return { items: ['Energy, sleep quality, soreness and stress scores only (no note)'] };
    case 'constraints':
      return {
        items: [
          `Experience: ${sent.constraints.experience}`,
          sent.constraints.lowEnergy ? 'Low energy: lower intensity' : 'Normal energy',
          sent.constraints.conservative ? 'Conservative mode: on' : 'Conservative mode: off',
          `Exercises to avoid: ${sent.constraints.avoidExerciseKeys.length ? sent.constraints.avoidExerciseKeys.join(', ') : 'none'}`,
          ...(sent.constraints.limitationAreas.length ? [`Limitation areas: ${sent.constraints.limitationAreas.join(', ')}`] : []),
        ],
      };
  }
}

/** The sent context as the panel shows it: one section per key, in order. */
export function summarizeAdaptationContext(sent: AdaptationSentContext): SentDataSummary {
  const sections: SentDataSection[] = ADAPTATION_SENT_KEYS.map((key) => ({ key, title: TITLES[key], ...itemsFor(key, sent) }));
  return { sections, dropped: [], excluded: [...NEVER_SEND_LABELS] };
}

export type { BaseExercise };
