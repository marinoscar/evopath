/** Quick workout adaptation (E6.1) fixtures: views, previews and the run's event stream. */
import type {
  AdaptationPreview,
  AdaptationRoleModel,
  AdaptationView,
  AdaptedExercise,
} from '../../../services/trainingAdaptation';
import type { TrainingRunEvent } from '../../../services/trainingAgents';

export const ADAPTATION_ID = '00000000-0000-4000-8000-e00000000001';
export const ADAPT_RUN_ID = '00000000-0000-4000-8000-e00000000002';
export const ADAPT_WORKOUT_ID = '00000000-0000-4000-8000-e00000000003';
export const ADAPT_PLAN_WORKOUT_ID = '00000000-0000-4000-8000-e00000000004';

export function adaptedExercise(overrides: Partial<AdaptedExercise> = {}): AdaptedExercise {
  return {
    exerciseId: '00000000-0000-4000-8000-e00000000010',
    exerciseKey: 'dumbbell-bench-press',
    name: 'Dumbbell bench press',
    position: 0,
    source: 'kept',
    replacesExerciseId: null,
    replacesExerciseKey: null,
    isPriority: true,
    sets: 3,
    repMin: 8,
    repMax: 10,
    targetRpe: 7,
    restSeconds: 90,
    note: null,
    primaryMuscles: ['chest'],
    trackingMode: 'weight_reps',
    ...overrides,
  };
}

export function mockAdaptation(overrides: Partial<AdaptationView> = {}): AdaptationView {
  return {
    id: ADAPTATION_ID,
    status: 'ready',
    request: { minutes: 30, equipment: { mode: 'only', equipmentTypeIds: ['00000000-0000-4000-8000-000000000d01'] }, useReadiness: true },
    gymId: null,
    baseRef: {
      planId: '00000000-0000-4000-8000-e00000000020',
      planVersionId: '00000000-0000-4000-8000-e00000000021',
      planVersion: 3,
      planWorkoutId: ADAPT_PLAN_WORKOUT_ID,
      date: '2026-09-30',
    },
    proposal: {
      title: 'Upper A, 30 minutes with dumbbells',
      summary: 'Kept the pressing, swapped the barbell row for a dumbbell row and dropped curls to fit 30 minutes.',
      estimatedMinutes: 28,
      exercises: [
        adaptedExercise({ exerciseKey: 'dumbbell-bench-press', name: 'Dumbbell bench press', position: 0 }),
        adaptedExercise({
          exerciseId: '00000000-0000-4000-8000-e00000000011',
          exerciseKey: 'one-arm-dumbbell-row',
          name: 'One-arm dumbbell row',
          position: 1,
          source: 'swapped',
          replacesExerciseKey: 'barbell-row',
          replacesExerciseId: '00000000-0000-4000-8000-e00000000012',
          note: 'No barbell today.',
        }),
        adaptedExercise({
          exerciseId: '00000000-0000-4000-8000-e00000000013',
          exerciseKey: 'push-up',
          name: 'Push-up',
          position: 2,
          source: 'added',
          isPriority: false,
          sets: 2,
          repMin: 10,
          repMax: 15,
          targetRpe: null,
        }),
      ],
      dropped: [{ exerciseId: '00000000-0000-4000-8000-e00000000014', exerciseKey: 'barbell-curl', name: 'Barbell curl', reason: 'time' }],
      rationale: ['Pressing kept as the priority lift.', 'Curls dropped to fit 30 minutes.'],
      uncertainty: ['I assumed the dumbbells go up to 30 kg.'],
    },
    guardrailReport: {
      repairs: [{ code: 'time_sets_trimmed', exerciseKey: 'push-up', message: 'Reduced sets to fit 30 minutes.' }],
      rejected: [],
      estimatedMinutes: 28,
      fitsRequest: true,
      promptVersion: 1,
      warnings: [],
    },
    criticReport: {
      verdict: 'accept',
      checks: { honoursRequest: true, preservesIntent: true, avoidsSoreAreas: true, sensibleOrder: true },
      issues: [],
      rounds: 1,
    },
    safety: { level: 'ok', reasons: [] },
    sentData: null,
    models: { planner: { provider: 'openai', modelId: 'frontier-1' }, critic: { provider: 'openai', modelId: 'frontier-1' } },
    runId: ADAPT_RUN_ID,
    jobId: '00000000-0000-4000-8000-e00000000005',
    stage: null,
    errorCode: null,
    errorMessage: null,
    appliedAs: null,
    appliedWorkoutId: null,
    appliedPlanVersionId: null,
    appliedAt: null,
    expiresAt: '2026-10-30T10:00:00.000Z',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    guidance: null,
    ...overrides,
  };
}

export function roleModel(role: 'planner' | 'critic', overrides: Partial<AdaptationRoleModel> = {}): AdaptationRoleModel {
  return {
    role,
    state: 'ready',
    model: { provider: 'openai', modelId: 'frontier-1', displayName: 'Frontier One' },
    effectiveEffort: 'medium',
    fix: null,
    runnable: true,
    ...overrides,
  };
}

export function mockPreview(overrides: Partial<AdaptationPreview> = {}): AdaptationPreview {
  return {
    baseWorkout: 'planned',
    base: { programWorkoutId: ADAPT_PLAN_WORKOUT_ID, name: 'Upper A', date: '2026-09-30', planVersion: 3 },
    sentData: {
      sections: [
        { key: 'request', title: 'What you asked for', items: ['30 minutes'] },
        { key: 'today', title: "Today's planned exercises", items: ['Barbell bench press', 'Barbell row'], count: 2 },
      ],
      dropped: [],
      excluded: ['Your name', 'Gym name'],
    },
    models: { planner: roleModel('planner'), critic: roleModel('critic') },
    willCallProvider: true,
    safety: { level: 'ok', reasons: [] },
    blocked: null,
    ...overrides,
  };
}

/** An adaptation run: context, adapt, guardrails, critic, finalize. */
export function adaptRunEvents(): TrainingRunEvent[] {
  const list: Array<[string, Record<string, unknown>]> = [
    ['run.queued', { kind: 'adapt' }],
    ['run.started', { kind: 'adapt' }],
    ['stage.started', { node: 'context' }],
    ['workout_adaptation.context', { exercises: 4 }],
    ['stage.completed', { node: 'context' }],
    ['stage.started', { node: 'adapt' }],
    ['agent.usage', { role: 'planner', provider: 'openai', model: 'frontier-1', inputTokens: 1000, outputTokens: 300 }],
    ['stage.completed', { node: 'adapt' }],
    ['stage.started', { node: 'guardrails' }],
    ['stage.completed', { node: 'guardrails' }],
    ['stage.started', { node: 'critic', round: 1 }],
    ['stage.completed', { node: 'critic', round: 1 }],
    ['stage.started', { node: 'finalize' }],
    ['workout_adaptation.ready', { exercises: 3, estimatedMinutes: 28 }],
    ['stage.completed', { node: 'finalize' }],
    ['run.completed', { status: 'succeeded' }],
  ];
  return list.map(([type, data], i) => ({ seq: i + 1, type, data }));
}
