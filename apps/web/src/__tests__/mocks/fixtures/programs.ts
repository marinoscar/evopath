/**
 * Training plan fixtures (E5.6): programs with a small tree, versions, change
 * log entries and training runs.
 */
import type {
  ChangeLogEntry,
  PlanExerciseView,
  Program,
  ProgramListItem,
  ProgramVersion,
  ProgramVersionSummary,
} from '../../../services/programs';
import type { TrainingRunView } from '../../../services/trainingAgents';

export const PROGRAM_ID = '00000000-0000-4000-8000-c00000000001';
export const RUN_ID = '00000000-0000-4000-8000-c00000000099';
export const GYM_ID = '00000000-0000-4000-8000-c00000000050';

export function planExercise(overrides: Partial<PlanExerciseView> = {}): PlanExerciseView {
  return {
    id: 'pe-bench',
    exerciseId: 'ex-bench',
    position: 0,
    isPriority: true,
    targetSets: 3,
    repMin: 8,
    repMax: 10,
    targetLoadKg: null,
    targetRpe: 8,
    restSeconds: 120,
    loadGuidance: 'choose_start',
    rationale: 'Main press for chest growth.',
    evidenceRefs: ['E1'],
    notes: null,
    equipmentTypeId: null,
    exercise: { id: 'ex-bench', name: 'Bench press', slug: 'bench-press', trackingMode: 'weight_reps' },
    exerciseUnavailable: false,
    ...overrides,
  };
}

export function mockProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: PROGRAM_ID,
    name: 'Muscle gain',
    goal: 'hypertrophy',
    status: 'draft',
    source: 'ai',
    autonomy: 'autonomous',
    startDate: null,
    gymId: GYM_ID,
    currentVersion: 2,
    autonomyPausedAt: null,
    autonomyPausedReason: null,
    lastEvaluatedAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
    notes: null,
    rationale: 'Four upper and lower sessions to build muscle while protecting the knee.',
    intake: null,
    gym: { id: GYM_ID, name: 'Home Gym' },
    version: {
      versionNumber: 2,
      origin: 'ai_create',
      rationale: null,
      evidence: [
        { type: 'brief', summary: 'Brief', cautions: [], searchQueries: [], researchMode: 'single', droppedClaims: 0, droppedSources: 0 },
        {
          type: 'claim',
          id: 'E1',
          topic: 'volume',
          claim: '10 to 20 hard sets per muscle per week support growth.',
          applicability: 'Applies to an intermediate lifter.',
          confidence: 'high',
          sourceIds: ['S1'],
        },
        {
          type: 'source',
          id: 'S1',
          url: 'https://acsm.org/stand',
          title: 'ACSM position stand',
          publisher: 'ACSM',
          kind: 'position_stand',
          year: 2021,
          verified: true,
          domain: 'acsm.org',
          retrievedAt: '2026-09-01T10:00:00.000Z',
        },
      ],
      meta: {
        models: {
          researcher: { provider: 'openai', modelId: 'frontier-1', effort: 'medium' },
          planner: { provider: 'openai', modelId: 'frontier-1', effort: 'high' },
          critic: { provider: 'openai', modelId: 'frontier-1', effort: 'high' },
        },
        criticRounds: 2,
        tokens: { calls: 5, inputTokens: 40000, outputTokens: 9000, reasoningTokens: 1000 },
        warnings: ['critic_open_notes'],
      },
      createdAt: '2026-09-02T10:00:00.000Z',
    },
    tree: {
      blocks: [
        {
          id: 'b1',
          position: 0,
          name: 'Base',
          focus: 'Volume',
          rationale: 'Build a base of volume first.',
          weeks: [
            {
              id: 'w1',
              weekNumber: 1,
              isDeload: false,
              workouts: [
                {
                  id: 'wo1',
                  position: 0,
                  weekday: 1,
                  name: 'Upper A',
                  estimatedMinutes: 45,
                  rationale: 'Pressing focus.',
                  exercises: [
                    planExercise(),
                    planExercise({
                      id: 'pe-row',
                      exerciseId: 'ex-row',
                      position: 1,
                      isPriority: false,
                      repMin: 10,
                      repMax: 12,
                      targetRpe: null,
                      targetLoadKg: 50,
                      loadGuidance: 'fixed',
                      restSeconds: 90,
                      rationale: null,
                      evidenceRefs: [],
                      exercise: { id: 'ex-row', name: 'Cable row', slug: 'cable-row', trackingMode: 'weight_reps' },
                    }),
                  ],
                },
                {
                  id: 'wo2',
                  position: 1,
                  weekday: 4,
                  name: 'Lower A',
                  estimatedMinutes: 50,
                  rationale: null,
                  exercises: [
                    planExercise({
                      id: 'pe-squat',
                      exerciseId: 'ex-squat',
                      position: 0,
                      rationale: null,
                      evidenceRefs: [],
                      loadGuidance: 'from_history',
                      exercise: { id: 'ex-squat', name: 'Goblet squat', slug: 'goblet-squat', trackingMode: 'weight_reps' },
                    }),
                  ],
                },
              ],
            },
            { id: 'w2', weekNumber: 2, isDeload: true, workouts: [] },
          ],
        },
      ],
    },
    ...overrides,
  };
}

export function mockProgramListItem(overrides: Partial<ProgramListItem> = {}): ProgramListItem {
  const { tree: _t, version: _v, notes: _n, rationale: _r, intake: _i, gym: _g, ...header } = mockProgram();
  return { ...header, unseenChangeCount: 0, ...overrides };
}

export const mockVersionSummaries: ProgramVersionSummary[] = [
  { versionNumber: 2, origin: 'manual_edit', createdAt: '2026-09-02T10:00:00.000Z', runId: null, changeLogId: 'cl-2', summary: 'Edited by you' },
  { versionNumber: 1, origin: 'ai_create', createdAt: '2026-09-01T10:00:00.000Z', runId: RUN_ID, changeLogId: 'cl-1', summary: 'Created by the planning agent' },
];

export function mockVersion(versionNumber: number): ProgramVersion {
  const program = mockProgram();
  const tree = structuredClone(program.tree);
  if (versionNumber === 1) tree.blocks[0].weeks[0].workouts[0].exercises[0].targetSets = 4;
  const summary = mockVersionSummaries.find((v) => v.versionNumber === versionNumber)!;
  return {
    ...summary,
    rationale: null,
    evidence: [],
    meta: {},
    snapshot: { schemaVersion: 1, program: { name: program.name }, tree },
  };
}

export const mockChangeLog: ChangeLogEntry[] = [
  {
    id: 'cl-2',
    kind: 'edited',
    actor: 'user',
    status: 'applied',
    fromVersion: 1,
    toVersion: 2,
    runId: null,
    summary: 'Edited by you',
    rationale: null,
    operations: [],
    citations: [],
    revertsLogId: null,
    seenAt: null,
    createdAt: '2026-09-02T10:00:00.000Z',
    decidedAt: null,
  },
  {
    id: 'cl-1',
    kind: 'created',
    actor: 'ai',
    status: 'applied',
    fromVersion: null,
    toVersion: 1,
    runId: RUN_ID,
    summary: 'Created by the planning agent',
    rationale: null,
    operations: [],
    citations: [],
    revertsLogId: null,
    seenAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    decidedAt: null,
  },
];

export function mockRun(overrides: Partial<TrainingRunView> = {}): TrainingRunView {
  return {
    id: RUN_ID,
    kind: 'create',
    trigger: 'user',
    status: 'running',
    stage: 'research',
    programId: null,
    roleModels: {
      researcher: { provider: 'openai', modelId: 'frontier-1', effort: 'medium', keySource: 'user' },
      planner: { provider: 'openai', modelId: 'frontier-1', effort: 'high', keySource: 'user' },
      critic: { provider: 'openai', modelId: 'frontier-1', effort: 'high', keySource: 'org' },
    },
    tokenCap: 400000,
    cap: { limitTokens: 400000, usedTokens: 0, reached: false },
    usage: {
      byRole: {},
      byNode: {},
      total: { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    },
    result: null,
    errorCode: null,
    errorMessage: null,
    pendingDecision: null,
    cancelRequested: false,
    resumeCount: 0,
    lastEventSeq: 0,
    heartbeatAt: new Date().toISOString(),
    expiresAt: null,
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
    startedAt: '2026-09-30T10:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}
