import { createCoachChatTools, type CoachChatToolDeps } from './tools';
import { COACH_WORKOUT_HISTORY_LIMIT_MAX } from './tools/get-workout-history.tool';
import { COACH_USER_TEXT_MAX, resolveRange } from './tools/user-context';

// =============================================================================
// The coach chat's data tools (#338): get_now, get_about_me,
// get_workout_history, get_workout, get_plan_week, get_exercise_history,
// get_activity. Bound to the caller, full detail, the user's own text
// included (capped), secrets never.
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-01T18:05:00.000Z'); // 12:05 in Costa Rica (UTC-6)
const W1 = '0a000000-0000-4000-8000-0000000000a1';
const W2 = '0a000000-0000-4000-8000-0000000000a2';
const EX_BENCH = '0e000000-0000-4000-8000-0000000000b1';
const EX_ROW = '0e000000-0000-4000-8000-0000000000b2';
const PW1 = '0c000000-0000-4000-8000-0000000000c1';
const PW2 = '0c000000-0000-4000-8000-0000000000c2';
const PW3 = '0c000000-0000-4000-8000-0000000000c3';
const PROGRAM = '0d000000-0000-4000-8000-0000000000d1';
const DEVICE = '9c0ffee0-0000-4000-8000-00000000de71';

function set(over: Record<string, unknown>) {
  return {
    id: `set-${Math.random()}`,
    setNumber: 1,
    weightKg: null,
    reps: null,
    durationSeconds: null,
    distanceMeters: null,
    rpe: null,
    rir: null,
    restSeconds: null,
    isWarmup: false,
    completed: true,
    painFlag: false,
    painNote: null,
    notes: null,
    ...over,
  };
}

function benchWorkout(over: Record<string, unknown> = {}, sets: unknown[] = []) {
  return {
    id: W1,
    name: 'Upper A',
    date: new Date('2026-09-29T00:00:00.000Z'),
    status: 'completed',
    startedAt: new Date('2026-09-29T23:30:00.000Z'),
    endedAt: new Date('2026-09-30T00:35:00.000Z'),
    durationSeconds: null,
    notes: '  Felt   strong today ',
    gym: {
      name: 'Iron Temple',
      type: 'club',
      equipment: [
        { equipmentTypeId: 'eq-bench', quantity: 2, brand: 'Hammer Strength', model: 'Flat Bench', notes: 'Seat at 4' },
        { equipmentTypeId: 'eq-other', quantity: 1, brand: 'Rogue', model: 'Rack', notes: null },
      ],
    },
    programWorkout: null,
    programSession: {
      plannedFor: new Date('2026-09-29T00:00:00.000Z'),
      plannedSnapshot: [
        { exerciseId: EX_BENCH, slug: 'bench-press', sets: 4, repMin: 5, repMax: 8, targetRpe: 8, targetLoadKg: 100, loadGuidance: 'from_history', isPriority: true },
        { exerciseId: EX_ROW, slug: 'barbell-row', sets: 3, repMin: 8, repMax: 10, targetRpe: null, targetLoadKg: null, loadGuidance: 'choose_start', isPriority: false },
      ],
      programWorkout: { name: 'Upper A', week: { weekNumber: 2 } },
    },
    exercises: [
      {
        id: 'we-1',
        exerciseId: EX_BENCH,
        position: 0,
        notes: 'Elbows tucked',
        equipmentTypeId: 'eq-bench',
        equipmentType: { name: 'Flat bench', category: 'benches_racks', description: null },
        exercise: {
          name: 'Bench press',
          trackingMode: 'weight_reps',
          primaryMuscles: ['chest'],
          secondaryMuscles: ['triceps', 'front_delts'],
          movementPattern: 'horizontal_push',
          isUnilateral: false,
          isBodyweight: false,
          aliases: ['bench'],
          notes: null,
          ownerUserId: null,
          requirements: [
            { groupIndex: 0, equipmentType: { name: 'Barbell' }, capability: null },
            { groupIndex: 0, equipmentType: { name: 'Flat bench' }, capability: null },
            { groupIndex: 1, equipmentType: null, capability: { name: 'Chest press' } },
          ],
        },
        sets: sets.length
          ? sets
          : [
              set({ id: 's1', setNumber: 1, weightKg: 60, reps: 8, isWarmup: true }),
              set({ id: 's2', setNumber: 2, weightKg: 100, reps: 5, rpe: 8.5, rir: 1, restSeconds: 180, painFlag: true, painNote: 'Left shoulder pinch', notes: 'Grindy' }),
              set({ id: 's3', setNumber: 3, weightKg: 100, reps: 4, completed: false }),
            ],
      },
    ],
    ...over,
  };
}

function makeDeps() {
  return {
    prisma: {
      user: { findUnique: jest.fn().mockResolvedValue({ displayName: 'Oscar', providerDisplayName: null }) },
      workout: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
      workoutExercise: { groupBy: jest.fn().mockResolvedValue([]) },
      exercise: { findMany: jest.fn().mockResolvedValue([]) },
      program: { findFirst: jest.fn().mockResolvedValue(null) },
      programBlock: { findMany: jest.fn().mockResolvedValue([]) },
      programWeek: { findMany: jest.fn().mockResolvedValue([]), aggregate: jest.fn().mockResolvedValue({ _max: { weekNumber: null } }) },
      programWorkout: { findMany: jest.fn().mockResolvedValue([]) },
      programExercise: { findMany: jest.fn().mockResolvedValue([]) },
      activityEntry: { findMany: jest.fn().mockResolvedValue([]) },
      measurement: { findMany: jest.fn().mockResolvedValue([]) },
      gym: { findFirst: jest.fn().mockResolvedValue(null) },
      coachState: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
      coachMessage: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    signals: { forUser: jest.fn() },
    today: { today: jest.fn().mockResolvedValue({ kind: 'no_program', date: '2026-10-01' }) },
    checkIns: { today: jest.fn().mockResolvedValue('2026-10-01'), list: jest.fn() },
    photos: { summarize: jest.fn() },
    now: () => NOW,
    goals: { progressForUser: jest.fn().mockResolvedValue([]) },
    profile: {
      healthProfile: {
        get: jest.fn().mockResolvedValue({
          dateOfBirth: '1990-10-02',
          sexAtBirth: 'male',
          heightMm: 1805,
          unitSystem: 'imperial',
          timeZone: 'America/Costa_Rica',
          bio: 'Dad of two.',
        }),
      },
      userSettings: {
        getSettings: jest.fn().mockResolvedValue({
          onboarding: { goal: 'strength' },
          coach: { personaId: 'drill_sergeant', why: 'Keep up with my kids', preferredTime: '06:30' },
        }),
        patchSettings: jest.fn(),
      },
    },
    history: {
      priorBuckets: jest.fn().mockResolvedValue(new Map()),
      prsForWorkout: jest.fn().mockResolvedValue(new Map()),
      history: jest.fn().mockResolvedValue({ records: { maxWeightKg: null, maxReps: null, bestE1rmKg: null } }),
    },
  };
}

type Deps = ReturnType<typeof makeDeps>;

async function run(deps: Deps | Record<string, unknown>, name: string, args: unknown = {}) {
  const tool = createCoachChatTools(deps as unknown as CoachChatToolDeps, { pausedUntil: null }).find((t) => t.tool.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const parsed = tool.parseArguments(JSON.stringify(args));
  if (!parsed.success) throw new Error(parsed.error);
  return tool.execute(parsed.data, { userId: USER }) as Promise<any>;
}

describe('resolveRange', () => {
  it('defaults, validates and clamps local date ranges', () => {
    expect(resolveRange({ from: null, to: null }, '2026-10-01', 28, 120)).toEqual({ from: '2026-09-04', to: '2026-10-01', clamped: false });
    expect(resolveRange({ from: '2026-01-01', to: '2026-10-01' }, '2026-10-01', 28, 120)).toEqual({
      from: '2026-06-04',
      to: '2026-10-01',
      clamped: true,
    });
    expect(resolveRange({ from: '2026-02-30', to: null }, '2026-10-01', 28, 120)).toMatchObject({ error: 'invalid_arguments' });
    expect(resolveRange({ from: '2026-10-02', to: '2026-10-01' }, '2026-10-01', 28, 120)).toMatchObject({ error: 'invalid_arguments' });
  });
});

describe('get_now (#338)', () => {
  it("answers the caller's local date, weekday, time, zone and plan status", async () => {
    const deps = makeDeps();
    deps.today.today.mockResolvedValue({
      kind: 'workout',
      date: '2026-10-01',
      program: { id: PROGRAM, name: 'Strong 8' },
      programWorkout: { id: PW2, name: 'Lower A', weekday: 4, estimatedMinutes: 50 },
      weekNumber: 2,
      totalWeeks: 8,
      isDeload: false,
      done: false,
      completedWorkoutId: null,
      inProgressWorkoutId: null,
      session: {},
      week: [],
    });
    const result = await run(deps, 'get_now');
    expect(deps.checkIns.today).toHaveBeenCalledWith(USER, NOW);
    expect(deps.today.today).toHaveBeenCalledWith(USER, '2026-10-01', NOW);
    expect(result).toEqual({
      localDate: '2026-10-01',
      weekday: 'Thursday',
      localTime: '12:05',
      timeZone: 'America/Costa_Rica',
      plan: { status: 'workout_planned', program: 'Strong 8', weekNumber: 2, totalWeeks: 8, isDeload: false, workout: 'Lower A', workoutId: null },
    });
  });

  it('falls back to UTC and says so when no zone is set', async () => {
    const deps = makeDeps();
    deps.profile.healthProfile.get.mockResolvedValue({ unitSystem: 'metric', timeZone: null } as never);
    const result = await run(deps, 'get_now');
    expect(result).toMatchObject({ localTime: '18:05', timeZone: 'UTC', plan: { status: 'no_plan' } });
    expect(result.timeZoneNote).toMatch(/UTC/);
  });
});

describe('get_workout_history (#338)', () => {
  it('reads the caller\'s workouts of the last 28 days in full: notes, pain notes, gym, plan link, sets, totals', async () => {
    const deps = makeDeps();
    deps.prisma.workout.findMany.mockResolvedValue([benchWorkout()]);
    const result = await run(deps, 'get_workout_history', { from: null, to: null, limit: null });

    const query = deps.prisma.workout.findMany.mock.calls[0][0];
    expect(query.where).toEqual({
      userId: USER,
      date: { gte: new Date('2026-09-04T00:00:00.000Z'), lte: new Date('2026-10-01T00:00:00.000Z') },
    });
    expect(query.take).toBe(COACH_WORKOUT_HISTORY_LIMIT_MAX);
    const selected = JSON.stringify(query.select);
    for (const forbidden of ['photos', 'readinessSnapshot', 'latitude', 'longitude', 'gymId', 'userId']) {
      expect(selected).not.toContain(forbidden);
    }

    expect(result.from).toBe('2026-09-04');
    expect(result.units).toMatchObject({ weight: 'kg', preferredWeight: 'lb', unitSystem: 'imperial' });
    const [workout] = result.workouts;
    expect(workout).toMatchObject({
      workoutId: W1,
      date: '2026-09-29',
      weekday: 'Tuesday',
      startTime: '17:30',
      endTime: '18:35',
      durationMinutes: 65,
      status: 'completed',
      name: 'Upper A',
      gym: 'Iron Temple',
      notes: 'Felt strong today',
      plan: { session: 'Upper A', weekNumber: 2, plannedFor: '2026-09-29' },
      totals: { workingSets: 1, volumeKg: 500 },
    });
    expect(workout.exercises).toEqual([
      {
        name: 'Bench press',
        notes: 'Elbows tucked',
        equipment: {
          name: 'Flat bench',
          category: 'benches_racks',
          gymItems: [{ brand: 'Hammer Strength', model: 'Flat Bench', notes: 'Seat at 4', quantity: 2 }],
        },
        exercise: {
          trackingMode: 'weight_reps',
          movementPattern: 'horizontal_push',
          primaryMuscles: ['chest'],
          secondaryMuscles: ['triceps', 'front_delts'],
          aliases: ['bench'],
          needsOneOf: [['Barbell', 'Flat bench'], ['Chest press']],
        },
        sets: [
          { set: 1, warmup: true, weightKg: 60, reps: 8, completed: true },
          {
            set: 2,
            weightKg: 100,
            reps: 5,
            rpe: 8.5,
            rir: 1,
            restSeconds: 180,
            completed: true,
            painFlag: true,
            painNote: 'Left shoulder pinch',
            notes: 'Grindy',
          },
          { set: 3, weightKg: 100, reps: 4, completed: false },
        ],
      },
    ]);
  });

  it('computes PRs for the batch from ONE prior-history read, folding older workouts into newer ones', async () => {
    const deps = makeDeps();
    const older = benchWorkout({}, [set({ id: 'a1', setNumber: 1, weightKg: 100, reps: 5 })]);
    const newer = benchWorkout(
      { id: W2, date: new Date('2026-10-01T00:00:00.000Z'), startedAt: new Date('2026-10-01T12:00:00.000Z'), endedAt: null, durationSeconds: 3000 },
      [set({ id: 'b1', setNumber: 1, weightKg: 100, reps: 6 })],
    );
    deps.prisma.workout.findMany.mockResolvedValue([newer, older]);
    deps.history.priorBuckets.mockResolvedValue(new Map([[EX_BENCH, [{ weightKg: 90, maxReps: 5, maxRepsForE1rm: 5 }]]]));

    const result = await run(deps, 'get_workout_history', { from: null, to: null, limit: 10 });

    expect(deps.history.priorBuckets).toHaveBeenCalledTimes(1);
    expect(deps.history.priorBuckets).toHaveBeenCalledWith(USER, [EX_BENCH], {
      kind: 'beforeWorkout',
      workoutId: W1,
      date: older.date,
      startedAt: older.startedAt,
    });
    const [n, o] = result.workouts;
    expect(o.prs).toEqual([
      { exercise: 'Bench press', setNumber: 1, type: 'weight', value: 100, previous: 90 },
      { exercise: 'Bench press', setNumber: 1, type: 'e1rm', value: 116.7, previous: 105 },
    ]);
    expect(n.prs).toEqual([
      { exercise: 'Bench press', setNumber: 1, type: 'reps', value: 6, previous: 5 },
      { exercise: 'Bench press', setNumber: 1, type: 'e1rm', value: 120, previous: 116.7 },
    ]);
    expect(n.durationMinutes).toBe(50);
  });

  it('clamps a long range to 365 days, caps the limit at 200 and rejects a bad date', async () => {
    const deps = makeDeps();
    const result = await run(deps, 'get_workout_history', { from: '2024-01-01', to: '2026-10-01', limit: 999 });
    expect(result).toMatchObject({ from: '2025-10-02', to: '2026-10-01', clampedTo: '365 days', count: 0 });
    expect(deps.prisma.workout.findMany.mock.calls[0][0].take).toBe(COACH_WORKOUT_HISTORY_LIMIT_MAX);

    expect(await run(deps, 'get_workout_history', { from: 'last week', to: null, limit: null })).toMatchObject({
      error: 'invalid_arguments',
    });
  });

  it('caps each free-text value and answers unavailable on a failed read', async () => {
    const deps = makeDeps();
    deps.prisma.workout.findMany.mockResolvedValue([benchWorkout({ notes: 'n'.repeat(5000) })]);
    const result = await run(deps, 'get_workout_history', { from: null, to: null, limit: null });
    expect(result.workouts[0].notes).toHaveLength(COACH_USER_TEXT_MAX);

    deps.prisma.workout.findMany.mockRejectedValue(new Error('db at 10.0.0.5'));
    const failed = await run(deps, 'get_workout_history', { from: null, to: null, limit: null });
    expect(failed).toMatchObject({ error: 'unavailable' });
    expect(JSON.stringify(failed)).not.toContain('10.0.0.5');
  });
});

describe('get_workout (#338)', () => {
  it('reads one of the caller\'s workouts by id, with PRs and the planned prescription by name', async () => {
    const deps = makeDeps();
    deps.prisma.workout.findFirst.mockResolvedValue(benchWorkout({ status: 'in_progress', endedAt: null }));
    deps.prisma.exercise.findMany.mockResolvedValue([{ id: EX_ROW, name: 'Barbell row' }]);
    deps.history.prsForWorkout.mockResolvedValue(new Map([['s2', [{ type: 'weight', value: 100, previous: 95 }]]]));

    const result = await run(deps, 'get_workout', { workoutId: W1 });

    expect(deps.prisma.workout.findFirst.mock.calls[0][0].where).toEqual({ id: W1, userId: USER });
    expect(deps.prisma.exercise.findMany).toHaveBeenCalledWith({
      where: { id: { in: [EX_ROW] }, OR: [{ ownerUserId: null }, { ownerUserId: USER }] },
      select: { id: true, name: true },
    });
    expect(result.workout).toMatchObject({ workoutId: W1, status: 'in_progress', endTime: null });
    expect(result.workout.prs).toEqual([{ exercise: 'Bench press', setNumber: 2, type: 'weight', value: 100, previous: 95 }]);
    expect(result.planned).toEqual([
      { exercise: 'Bench press', priority: true, sets: 4, repMin: 5, repMax: 8, targetRpe: 8, targetLoadKg: 100, loadGuidance: 'from_history' },
      { exercise: 'Barbell row', sets: 3, repMin: 8, repMax: 10, loadGuidance: 'choose_start' },
    ]);
  });

  it('answers not_found for an id that is not the caller\'s, and invalid_arguments for a non-id', async () => {
    const deps = makeDeps();
    expect(await run(deps, 'get_workout', { workoutId: W2 })).toMatchObject({ error: 'not_found' });
    expect(await run(deps, 'get_workout', { workoutId: 'yesterday' })).toMatchObject({ error: 'invalid_arguments' });
    expect(deps.prisma.workout.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('get_plan_week (#338)', () => {
  function withPlan(deps: Deps) {
    deps.prisma.program.findFirst.mockResolvedValue({
      id: PROGRAM,
      name: 'Strong 8',
      goal: 'strength',
      status: 'active',
      startDate: new Date('2026-09-21T00:00:00.000Z'),
      rationale: 'Three full-body days to build a base.',
      notes: null,
      currentVersion: 3,
      gym: {
        name: 'Iron Temple',
        type: 'club',
        description: null,
        equipment: [{ equipmentTypeId: 'eq-bench', quantity: 1, brand: 'Eleiko', model: null, notes: 'Bench by the window' }],
      },
    } as never);
    deps.prisma.programBlock.findMany.mockResolvedValue([
      { id: 'b1', position: 0, name: 'Base', focus: 'Strength base', rationale: null, archivedAt: null },
    ]);
    deps.prisma.programWeek.findMany.mockResolvedValue(
      [1, 2, 3, 4].map((n) => ({ id: `wk${n}`, blockId: 'b1', weekNumber: n, isDeload: n === 4, archivedAt: null })),
    );
    deps.prisma.programWorkout.findMany.mockResolvedValue([
      { id: PW1, weekId: 'wk2', position: 0, weekday: 1, name: 'Upper A', estimatedMinutes: 60, rationale: 'Push focus', archivedAt: null },
      { id: PW2, weekId: 'wk2', position: 1, weekday: 4, name: 'Lower A', estimatedMinutes: 55, rationale: null, archivedAt: null },
      { id: PW3, weekId: 'wk2', position: 2, weekday: 6, name: 'Upper B', estimatedMinutes: 60, rationale: null, archivedAt: null },
    ]);
    deps.prisma.programExercise.findMany.mockResolvedValue([
      {
        id: 'pe1',
        programWorkoutId: PW1,
        exerciseId: EX_BENCH,
        position: 0,
        isPriority: true,
        targetSets: 4,
        repMin: 5,
        repMax: 8,
        targetDurationSeconds: null,
        targetDistanceMeters: null,
        targetLoadKg: 100,
        targetRpe: 8,
        restSeconds: 180,
        loadGuidance: 'from_history',
        rationale: null,
        evidenceRefs: [],
        notes: 'Pause on the chest',
        equipmentTypeId: 'eq-bench',
      },
    ]);
    (deps.prisma as any).equipmentType = {
      findMany: jest.fn().mockResolvedValue([{ id: 'eq-bench', name: 'Flat bench', category: 'benches_racks', description: null }]),
    };
    deps.prisma.workout.findMany.mockResolvedValue([{ id: W1, status: 'completed', programWorkoutId: PW1, programSession: null }]);
    deps.prisma.exercise.findMany.mockResolvedValue([
      {
        id: EX_BENCH,
        name: 'Bench press',
        trackingMode: 'weight_reps',
        primaryMuscles: ['chest'],
        secondaryMuscles: [],
        movementPattern: 'horizontal_push',
        isUnilateral: false,
        isBodyweight: false,
        aliases: [],
        notes: null,
        ownerUserId: null,
        requirements: [],
      },
    ]);
  }

  it('answers the current week with dates, statuses, the logged workout id and full prescriptions, plus the overview', async () => {
    const deps = makeDeps();
    withPlan(deps);
    const result = await run(deps, 'get_plan_week', { weekNumber: null });

    expect(deps.prisma.program.findFirst.mock.calls[0][0].where).toEqual({ userId: USER, status: 'active' });
    expect(deps.prisma.workout.findMany.mock.calls[0][0].where.userId).toBe(USER);
    expect(result.week).toMatchObject({ weekNumber: 2, isCurrent: true, isDeload: false, from: '2026-09-28', to: '2026-10-04' });
    expect(result.week.sessions.map((s: any) => [s.date, s.weekday, s.name, s.status, s.workoutId])).toEqual([
      ['2026-09-28', 'Monday', 'Upper A', 'done', W1],
      ['2026-10-01', 'Thursday', 'Lower A', 'today', null],
      ['2026-10-03', 'Saturday', 'Upper B', 'upcoming', null],
    ]);
    expect(result.week.sessions[0].exercises).toEqual([
      {
        name: 'Bench press',
        exercise: { trackingMode: 'weight_reps', movementPattern: 'horizontal_push', primaryMuscles: ['chest'] },
        equipment: { name: 'Flat bench', category: 'benches_racks', gymItems: [{ brand: 'Eleiko', notes: 'Bench by the window', quantity: 1 }] },
        priority: true,
        sets: 4,
        repMin: 5,
        repMax: 8,
        targetRpe: 8,
        restSeconds: 180,
        loadGuidance: 'from_history',
        targetLoadKg: 100,
        notes: 'Pause on the chest',
      },
    ]);
    expect(result.program).toMatchObject({
      name: 'Strong 8',
      startDate: '2026-09-21',
      currentWeek: 2,
      totalWeeks: 4,
      gym: 'Iron Temple',
      rationale: 'Three full-body days to build a base.',
      blocks: [{ name: 'Base', focus: 'Strength base', weeks: { from: 1, to: 4 }, deloadWeeks: [4] }],
    });
  });

  it('answers another week, refuses one outside the plan, and program null without an active plan', async () => {
    const deps = makeDeps();
    withPlan(deps);
    const week4 = await run(deps, 'get_plan_week', { weekNumber: 4 });
    expect(week4.week).toMatchObject({ weekNumber: 4, isCurrent: false, isDeload: true, sessions: [] });
    expect(await run(deps, 'get_plan_week', { weekNumber: 9 })).toMatchObject({ error: 'invalid_arguments' });

    const none = makeDeps();
    expect(await run(none, 'get_plan_week', { weekNumber: null })).toEqual({ today: '2026-10-01', program: null });
  });
});

describe('get_exercise_history (#338)', () => {
  it('matches by name within the library and the caller\'s own exercises, and answers sets, top sets and records', async () => {
    const deps = makeDeps();
    deps.prisma.exercise.findMany.mockResolvedValue([
      { id: EX_BENCH, name: 'Bench press', slug: 'bench-press', trackingMode: 'weight_reps', aliases: ['bench'] },
      { id: EX_ROW, name: 'Close-grip bench press', slug: 'close-grip-bench-press', trackingMode: 'weight_reps', aliases: [] },
    ]);
    deps.prisma.workout.findMany.mockResolvedValue([
      {
        id: W1,
        date: new Date('2026-09-29T00:00:00.000Z'),
        name: 'Upper A',
        gym: { name: 'Iron Temple' },
        exercises: [
          {
            notes: 'Elbows tucked',
            sets: [
              set({ setNumber: 1, weightKg: 60, reps: 8, isWarmup: true }),
              set({ setNumber: 2, weightKg: 100, reps: 5, painFlag: true, painNote: 'Shoulder pinch' }),
            ],
          },
        ],
      },
    ]);
    const records = { maxWeightKg: { value: 100, reps: 5, date: '2026-09-29' }, maxReps: null, bestE1rmKg: null };
    deps.history.history.mockResolvedValue({ records });

    const result = await run(deps, 'get_exercise_history', { exercise: 'Bench Press', limit: null });

    const where = deps.prisma.exercise.findMany.mock.calls[0][0].where;
    expect(where.AND[0]).toEqual({ OR: [{ ownerUserId: null }, { ownerUserId: USER }] });
    expect(deps.prisma.workoutExercise.groupBy).not.toHaveBeenCalled();
    const sessionsQuery = deps.prisma.workout.findMany.mock.calls[0][0];
    expect(sessionsQuery.where).toEqual({ userId: USER, status: 'completed', exercises: { some: { exerciseId: EX_BENCH } } });
    expect(sessionsQuery.take).toBe(10);
    expect(deps.history.history).toHaveBeenCalledWith(USER, EX_BENCH, { limit: 1 }, NOW);

    expect(result).toMatchObject({
      found: true,
      exercise: { name: 'Bench press', trackingMode: 'weight_reps' },
      otherMatches: ['Close-grip bench press'],
      records,
    });
    expect(result.sessions[0]).toMatchObject({
      workoutId: W1,
      date: '2026-09-29',
      weekday: 'Tuesday',
      gym: 'Iron Temple',
      notes: ['Elbows tucked'],
      topSet: { weightKg: 100, reps: 5 },
      e1rmKg: 116.7,
    });
    expect(result.sessions[0].sets[1]).toMatchObject({ painFlag: true, painNote: 'Shoulder pinch' });
  });

  it('prefers the exercise the user logged most when no name matches exactly; found false when nothing matches', async () => {
    const deps = makeDeps();
    deps.prisma.exercise.findMany.mockResolvedValue([
      { id: EX_BENCH, name: 'Bench press', slug: 'bench-press', trackingMode: 'weight_reps', aliases: [] },
      { id: EX_ROW, name: 'Incline bench press', slug: 'incline-bench-press', trackingMode: 'weight_reps', aliases: [] },
    ]);
    deps.prisma.workoutExercise.groupBy.mockResolvedValue([{ exerciseId: EX_ROW, _count: { _all: 7 } }]);
    const result = await run(deps, 'get_exercise_history', { exercise: 'bench', limit: 3 });
    expect(deps.prisma.workoutExercise.groupBy.mock.calls[0][0].where.workout).toEqual({ userId: USER });
    expect(result.exercise.name).toBe('Incline bench press');

    deps.prisma.exercise.findMany.mockResolvedValue([]);
    expect(await run(deps, 'get_exercise_history', { exercise: 'zercher', limit: null })).toMatchObject({ found: false });
  });
});

describe('get_activity (#338)', () => {
  it('reads the caller\'s entries with notes and totals, never the device or external id', async () => {
    const deps = makeDeps();
    deps.prisma.activityEntry.findMany.mockResolvedValue([
      {
        occurredOn: new Date('2026-09-30T00:00:00.000Z'),
        occurredAt: new Date('2026-09-30T13:00:00.000Z'),
        activityKind: 'walk',
        completed: true,
        durationSeconds: 2700,
        steps: 5200,
        distanceMeters: 3800.5,
        source: 'integration',
        provider: `health_connect:${DEVICE}`,
        note: 'Walked the dog',
        workoutId: null,
      },
      {
        occurredOn: new Date('2026-09-29T00:00:00.000Z'),
        occurredAt: null,
        activityKind: 'run',
        completed: true,
        durationSeconds: 1800,
        steps: null,
        distanceMeters: 5000,
        source: 'manual',
        provider: null,
        note: null,
        workoutId: null,
      },
    ]);
    const result = await run(deps, 'get_activity', { from: null, to: null });

    const query = deps.prisma.activityEntry.findMany.mock.calls[0][0];
    expect(query.where).toEqual({
      userId: USER,
      occurredOn: { gte: new Date('2026-09-04T00:00:00.000Z'), lte: new Date('2026-10-01T00:00:00.000Z') },
    });
    expect(Object.keys(query.select)).not.toEqual(expect.arrayContaining(['externalId']));
    expect(result.entries[0]).toEqual({
      date: '2026-09-30',
      weekday: 'Wednesday',
      time: '07:00',
      kind: 'walk',
      completed: true,
      durationMinutes: 45,
      distanceMeters: 3800.5,
      steps: 5200,
      source: 'integration',
      provider: 'health_connect',
      note: 'Walked the dog',
    });
    expect(result.totals).toEqual({
      walk: { entries: 1, minutes: 45, distanceMeters: 3801, steps: 5200 },
      run: { entries: 1, minutes: 30, distanceMeters: 5000, steps: 0 },
    });
    expect(JSON.stringify(result)).not.toContain(DEVICE);
  });
});

describe('get_about_me (#338)', () => {
  it('answers profile, training goal and intake, plan today and this week, goals, coach settings and the last 7 days', async () => {
    const deps = makeDeps();
    deps.prisma.program.findFirst.mockResolvedValue({
      id: PROGRAM,
      name: 'Strong 8',
      goal: 'strength',
      intake: {
        goal: { type: 'strength', description: 'Deadlift 200 kg' },
        experience: 'intermediate',
        daysPerWeek: 3,
        minutesPerSession: 60,
        limitations: [{ area: 'knee', description: 'Old ACL repair' }],
        preferences: 'Short rests',
      },
      status: 'active',
      source: 'ai',
      autonomy: 'autonomous',
      startDate: new Date('2026-09-21T00:00:00.000Z'),
      rationale: 'Base first.',
      gym: { name: 'Iron Temple' },
    } as never);
    deps.prisma.programWeek.aggregate.mockResolvedValue({ _max: { weekNumber: 8 } });
    deps.prisma.measurement.findMany.mockResolvedValue([
      { metricKey: 'weight', value: 92.345, unit: 'kg', measuredAt: new Date('2026-09-30T12:00:00Z'), localDate: new Date('2026-09-30T00:00:00Z') },
    ]);
    deps.prisma.coachState.findUnique.mockResolvedValue({ pausedUntil: null, weeklyStreak: 3 });
    deps.prisma.workout.findMany.mockResolvedValue([
      { id: W1, date: new Date('2026-09-29T00:00:00.000Z'), name: 'Upper A', durationSeconds: 3900 },
    ]);
    deps.today.today.mockResolvedValue({
      kind: 'rest_day',
      date: '2026-10-01',
      program: { id: PROGRAM, name: 'Strong 8' },
      weekNumber: 2,
      totalWeeks: 8,
      next: { date: '2026-10-03', weekNumber: 2, programWorkout: { id: PW3, name: 'Upper B', weekday: 6, estimatedMinutes: 60 } },
      week: [
        { date: '2026-09-29', status: 'done', suggested: false, completedWorkoutId: W1, inProgressWorkoutId: null, programWorkout: { name: 'Upper A' } },
        { date: '2026-10-03', status: 'upcoming', suggested: true, completedWorkoutId: null, inProgressWorkoutId: null, programWorkout: { name: 'Upper B' } },
      ],
    });

    const result = await run(deps, 'get_about_me');

    expect(result.now).toEqual({ localDate: '2026-10-01', weekday: 'Thursday', localTime: '12:05', timeZone: 'America/Costa_Rica' });
    expect(result.profile).toMatchObject({
      name: 'Oscar',
      ageYears: 35,
      heightCm: 180.5,
      unitSystem: 'imperial',
      bio: 'Dad of two.',
      onboardingGoal: 'strength',
      latestBody: { weight: { value: 92.35, unit: 'kg', date: '2026-09-30' } },
    });
    expect(result.training.program).toMatchObject({
      name: 'Strong 8',
      goal: { type: 'strength', description: 'Deadlift 200 kg' },
      startDate: '2026-09-21',
      currentWeek: 2,
      totalWeeks: 8,
      rationale: 'Base first.',
      intake: { daysPerWeek: 3, minutesPerSession: 60, limitations: [{ area: 'knee', description: 'Old ACL repair' }] },
    });
    expect(result.plan.today).toMatchObject({ status: 'rest_day', next: { date: '2026-10-03', weekday: 'Saturday', workout: 'Upper B' } });
    expect(result.plan.thisWeek).toEqual([
      { date: '2026-09-29', weekday: 'Tuesday', workout: 'Upper A', status: 'done', workoutId: W1 },
      { date: '2026-10-03', weekday: 'Saturday', workout: 'Upper B', status: 'upcoming', workoutId: null },
    ]);
    expect(result.coach).toMatchObject({ why: 'Keep up with my kids', preferredTime: '06:30', pausedUntil: null, weeklyStreak: 3 });
    expect(result.coach.persona).not.toBe('drill_sergeant');
    expect(result.last7Days).toEqual({
      completedWorkouts: 1,
      workouts: [{ workoutId: W1, date: '2026-09-29', weekday: 'Tuesday', name: 'Upper A', durationMinutes: 65 }],
    });
    expect(deps.prisma.workout.findMany.mock.calls[0][0].where).toMatchObject({ userId: USER, status: 'completed' });
    expect(deps.prisma.coachState.findUnique.mock.calls[0][0].where).toEqual({ userId: USER });
  });

  it('a part that fails is null; the rest still answers', async () => {
    const deps = makeDeps();
    deps.prisma.program.findFirst.mockRejectedValue(new Error('boom'));
    const result = await run(deps, 'get_about_me');
    expect(result.training).toBeNull();
    expect(result.profile).toMatchObject({ name: 'Oscar' });
    expect(result.plan.today).toEqual({ status: 'no_plan' });
  });
});

// -----------------------------------------------------------------------------
// Full coverage (#338 follow-up): gyms, measurements, PRs, plans, history, records
// -----------------------------------------------------------------------------

describe('get_gyms (#338)', () => {
  it('answers every gym of the caller with its full inventory, photo captions and location, never a storage object', async () => {
    const deps = makeDeps();
    (deps.prisma.gym as any).findMany = jest.fn().mockResolvedValue([
      {
        name: 'Home garage',
        type: 'home',
        description: 'Two-car garage',
        notes: 'Cold in winter',
        latitude: 9.93,
        longitude: -84.08,
        isDefault: true,
        isTemporary: false,
        createdAt: new Date('2026-01-10T00:00:00Z'),
        equipment: [
          {
            quantity: 1,
            brand: 'Rogue',
            model: 'R-3',
            notes: 'J-cups at hole 9',
            origin: 'ai',
            confidence: 'high',
            userVerified: true,
            originalAiValue: { equipmentTypeSlug: 'power-rack', sourcePhotoIds: ['9c0ffee0-0000-4000-8000-0000000000f0'] },
            equipmentType: { name: 'Power rack', category: 'benches_racks', description: null, ownerUserId: null },
          },
        ],
        photos: [
          {
            caption: 'Rack corner',
            takenAt: null,
            createdAt: new Date('2026-01-11T00:00:00Z'),
            equipment: [{ gymEquipment: { equipmentType: { name: 'Power rack' } } }],
          },
        ],
      },
    ]);
    const result = await run(deps, 'get_gyms');
    const query = (deps.prisma.gym as any).findMany.mock.calls[0][0];
    expect(query.where).toEqual({ userId: USER });
    expect(JSON.stringify(query.select)).not.toMatch(/storageObject/);
    expect(result.gyms[0]).toEqual({
      name: 'Home garage',
      type: 'home',
      default: true,
      temporary: false,
      description: 'Two-car garage',
      notes: 'Cold in winter',
      location: { latitude: 9.93, longitude: -84.08 },
      addedOn: '2026-01-10',
      equipment: [
        {
          name: 'Power rack',
          category: 'benches_racks',
          quantity: 1,
          brand: 'Rogue',
          model: 'R-3',
          notes: 'J-cups at hole 9',
          origin: 'ai',
          aiConfidence: 'high',
          userVerified: true,
          aiOriginallyRead: { equipmentTypeSlug: 'power-rack' },
        },
      ],
      photos: [{ caption: 'Rack corner', takenOn: '2026-01-11', shows: ['Power rack'] }],
    });
  });
});

describe('get_measurements (#338)', () => {
  const rows = [
    {
      metricKey: 'weight',
      value: 92.4,
      unit: 'kg',
      measuredAt: new Date('2026-09-30T13:00:00Z'),
      localDate: new Date('2026-09-30T00:00:00Z'),
      method: 'smart_scale',
      origin: 'device',
      notes: 'After breakfast',
      referenceLow: null,
      referenceHigh: null,
      referenceText: null,
      flag: null,
    },
    {
      metricKey: 'weight',
      value: 93.1,
      unit: 'kg',
      measuredAt: new Date('2026-09-01T13:00:00Z'),
      localDate: new Date('2026-09-01T00:00:00Z'),
      method: 'unspecified',
      origin: 'manual',
      notes: null,
      referenceLow: null,
      referenceHigh: null,
      referenceText: null,
      flag: null,
    },
  ];

  it('answers the caller\'s history with notes and a per-metric summary; labs are left out while consent is off', async () => {
    const deps = makeDeps();
    deps.prisma.measurement.findMany.mockResolvedValue(rows);
    (deps as any).healthSummary = { consentOn: jest.fn().mockResolvedValue(false), forTraining: jest.fn() };
    const result = await run(deps, 'get_measurements', { metricKey: null, category: null, from: null, to: null });

    const query = deps.prisma.measurement.findMany.mock.calls[0][0];
    expect(query.where).toMatchObject({ userId: USER, supersededAt: null, deletedAt: null });
    expect(query.where.metricKey.in).toContain('weight');
    expect(query.where.metricKey.in).not.toContain('ldl_cholesterol');
    expect(Object.keys(query.select)).not.toEqual(expect.arrayContaining(['sourceRef']));
    expect(result.labs).toMatch(/setting is off/);
    expect(result.readings[0]).toMatchObject({ metricKey: 'weight', value: 92.4, date: '2026-09-30', method: 'smart_scale', note: 'After breakfast' });
    expect(result.summary.weight).toEqual({
      count: 2,
      first: { value: 93.1, date: '2026-09-01' },
      latest: { value: 92.4, date: '2026-09-30' },
      min: 92.4,
      max: 93.1,
      change: -0.7,
    });
  });

  it('includes labs while consent is on, filters by key or category, and refuses an unknown key', async () => {
    const deps = makeDeps();
    (deps as any).healthSummary = { consentOn: jest.fn().mockResolvedValue(true), forTraining: jest.fn() };
    const all = await run(deps, 'get_measurements', { metricKey: null, category: null, from: null, to: null });
    expect(all.labs).toBeUndefined();
    expect(deps.prisma.measurement.findMany.mock.calls[0][0].where.metricKey).toBeUndefined();

    await run(deps, 'get_measurements', { metricKey: null, category: 'vital', from: null, to: null });
    expect(deps.prisma.measurement.findMany.mock.calls[1][0].where.metricKey.in).toContain('resting_hr');

    expect(await run(deps, 'get_measurements', { metricKey: 'bogus', category: null, from: null, to: null })).toMatchObject({
      error: 'invalid_arguments',
    });
  });
});

describe('get_personal_records (#338)', () => {
  it('reads every exercise\'s records in one scoped SQL read, strongest first', async () => {
    const deps = makeDeps();
    (deps.prisma as any).$queryRaw = jest.fn().mockResolvedValue([
      { kind: 'weight', exercise_id: EX_BENCH, name: 'Bench press', weight_kg: 100, reps: 5, date: new Date('2026-09-29T00:00:00Z'), e1rm: null, sessions: null, working_sets: null },
      { kind: 'reps', exercise_id: EX_BENCH, name: 'Bench press', weight_kg: 60, reps: 15, date: new Date('2026-08-01T00:00:00Z'), e1rm: null, sessions: null, working_sets: null },
      { kind: 'e1rm', exercise_id: EX_BENCH, name: 'Bench press', weight_kg: 100, reps: 5, date: new Date('2026-09-29T00:00:00Z'), e1rm: 116.7, sessions: null, working_sets: null },
      { kind: 'stats', exercise_id: EX_BENCH, name: 'Bench press', weight_kg: null, reps: null, date: new Date('2026-09-29T00:00:00Z'), e1rm: null, sessions: BigInt(12), working_sets: BigInt(40) },
      { kind: 'stats', exercise_id: EX_ROW, name: 'Pull-up', weight_kg: null, reps: null, date: new Date('2026-09-20T00:00:00Z'), e1rm: null, sessions: 3, working_sets: 9 },
    ]);
    const result = await run(deps, 'get_personal_records');

    const sql = (deps.prisma as any).$queryRaw.mock.calls[0][0];
    expect(sql.values).toContain(USER);
    expect(result.records).toEqual([
      {
        name: 'Bench press',
        maxWeight: { kg: 100, reps: 5, date: '2026-09-29' },
        maxReps: { reps: 15, kg: 60, date: '2026-08-01' },
        bestE1rm: { kg: 116.7, fromKg: 100, fromReps: 5, date: '2026-09-29' },
        sessions: 12,
        workingSets: 40,
        lastDone: '2026-09-29',
      },
      { name: 'Pull-up', maxWeight: null, maxReps: null, bestE1rm: null, sessions: 3, workingSets: 9, lastDone: '2026-09-20' },
    ]);
  });
});

describe('get_programs and get_plan_history (#338)', () => {
  it('get_programs answers every plan of the caller, past ones included, with intake and counts', async () => {
    const deps = makeDeps();
    (deps.prisma.program as any).findMany = jest.fn().mockResolvedValue([
      {
        name: 'Strong 8',
        goal: 'strength',
        status: 'archived',
        source: 'ai',
        startDate: new Date('2026-05-04T00:00:00Z'),
        autonomy: 'autonomous',
        autonomyPausedAt: new Date('2026-06-01T00:00:00Z'),
        autonomyPausedReason: 'pain_pattern',
        currentVersion: 4,
        rationale: 'Base block.',
        notes: 'Felt stale by week 6',
        intake: { goal: { type: 'strength', description: 'Bench 120' }, experience: 'intermediate', daysPerWeek: 3, minutesPerSession: 60, gymId: '9c0ffee0-0000-4000-8000-0000000000f1' },
        createdAt: new Date('2026-05-01T00:00:00Z'),
        updatedAt: new Date('2026-07-01T00:00:00Z'),
        lastEvaluatedAt: null,
        gym: { name: 'Iron Temple' },
        weeks: [{ weekNumber: 1 }, { weekNumber: 8 }],
        _count: { sessions: 21 },
      },
    ]);
    const result = await run(deps, 'get_programs');
    expect((deps.prisma.program as any).findMany.mock.calls[0][0].where).toEqual({ userId: USER });
    expect(result.programs[0]).toMatchObject({
      name: 'Strong 8',
      status: 'archived',
      startDate: '2026-05-04',
      totalWeeks: 8,
      version: 4,
      autonomyPaused: { reason: 'pain_pattern' },
      notes: 'Felt stale by week 6',
      intake: { goal: { description: 'Bench 120' }, daysPerWeek: 3 },
      workoutsLogged: 21,
    });
    expect(JSON.stringify(result)).not.toContain('9c0ffee0-0000-4000-8000-0000000000f1');
  });

  it('get_plan_history answers changes, versions, adaptations and runs for the caller, without ids', async () => {
    const deps = makeDeps();
    const at = new Date('2026-09-20T10:00:00Z');
    (deps.prisma as any).programChangeLog = {
      findMany: jest.fn().mockResolvedValue([
        {
          kind: 'adapted',
          actor: 'ai',
          status: 'applied',
          fromVersion: 2,
          toVersion: 3,
          summary: 'Swapped squat for leg press',
          rationale: 'Knee pain flagged twice',
          operations: [{ op: 'swap', exerciseId: EX_BENCH, to: 'leg-press' }],
          citations: [],
          createdAt: at,
          decidedAt: null,
          program: { name: 'Strong 8' },
        },
      ]),
    };
    (deps.prisma as any).programVersion = {
      findMany: jest.fn().mockResolvedValue([{ versionNumber: 3, origin: 'ai_adapt', rationale: 'Knee', createdAt: at, program: { name: 'Strong 8' } }]),
    };
    (deps.prisma as any).workoutAdaptation = {
      findMany: jest.fn().mockResolvedValue([
        {
          status: 'applied',
          request: { reason: 'Only 30 minutes today' },
          proposal: { summary: 'Shortened session' },
          safety: {},
          appliedAs: 'one_off',
          appliedAt: at,
          errorCode: null,
          createdAt: at,
          gym: null,
        },
      ]),
    };
    (deps.prisma as any).trainingPlanRun = {
      findMany: jest.fn().mockResolvedValue([
        { kind: 'evaluate', trigger: 'weekly', status: 'succeeded', input: { trigger: 'weekly' }, result: { verdict: 'adapt' }, errorCode: null, createdAt: at, completedAt: at },
      ]),
    };
    const result = await run(deps, 'get_plan_history', { limit: null });
    expect((deps.prisma as any).programChangeLog.findMany.mock.calls[0][0]).toMatchObject({ where: { userId: USER }, take: 50 });
    expect((deps.prisma as any).programVersion.findMany.mock.calls[0][0].where).toEqual({ program: { userId: USER } });
    expect((deps.prisma as any).workoutAdaptation.findMany.mock.calls[0][0].where).toEqual({ userId: USER });
    expect((deps.prisma as any).trainingPlanRun.findMany.mock.calls[0][0].where).toEqual({ userId: USER });
    expect(result.changes[0]).toMatchObject({ plan: 'Strong 8', by: 'ai', summary: 'Swapped squat for leg press', rationale: 'Knee pain flagged twice' });
    expect(result.changes[0].operations).toEqual([{ op: 'swap', to: 'leg-press' }]);
    expect(result.adaptations[0]).toMatchObject({ request: { reason: 'Only 30 minutes today' }, appliedAs: 'one_off' });
    expect(result.planRuns[0]).toMatchObject({ kind: 'evaluate', trigger: 'weekly', result: { verdict: 'adapt' } });
    expect(JSON.stringify(result)).not.toContain(EX_BENCH);
  });

  it('get_plan_week reads a past plan by name, and answers not_found for an unknown one', async () => {
    const deps = makeDeps();
    expect(await run(deps, 'get_plan_week', { weekNumber: null, plan: 'Old plan' })).toMatchObject({ error: 'not_found' });
    expect(deps.prisma.program.findFirst.mock.calls[0][0].where).toEqual({
      userId: USER,
      name: { equals: 'Old plan', mode: 'insensitive' },
    });
  });
});

describe('get_health_documents (#338)', () => {
  it('lists the caller\'s health records while the health-data setting is on; consent_off otherwise', async () => {
    const deps = makeDeps();
    (deps as any).healthSummary = { consentOn: jest.fn().mockResolvedValue(false), forTraining: jest.fn() };
    (deps.prisma as any).healthDocument = {
      findMany: jest.fn().mockResolvedValue([
        {
          kind: 'lab_report',
          originalName: 'labs-sept.pdf',
          mimeType: 'application/pdf',
          sizeBytes: BigInt(204800),
          retention: 'keep',
          documentDate: new Date('2026-09-15T00:00:00Z'),
          fileDeletedAt: null,
          createdAt: new Date('2026-09-16T00:00:00Z'),
        },
      ]),
    };
    expect(await run(deps, 'get_health_documents')).toMatchObject({ error: 'consent_off' });
    expect((deps.prisma as any).healthDocument.findMany).not.toHaveBeenCalled();

    (deps as any).healthSummary.consentOn.mockResolvedValue(true);
    const result = await run(deps, 'get_health_documents');
    const query = (deps.prisma as any).healthDocument.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ userId: USER });
    expect(Object.keys(query.select)).not.toEqual(expect.arrayContaining(['storageObjectId']));
    expect(result.documents).toEqual([
      { kind: 'lab_report', fileName: 'labs-sept.pdf', documentDate: '2026-09-15', fileType: 'application/pdf', sizeKb: 200, fileKept: true, retention: 'keep', addedOn: '2026-09-16' },
    ]);
  });
});

describe('get_goals otherGoals and get_profile devices (#338)', () => {
  it('get_goals adds the paused, completed and archived goals', async () => {
    const deps = makeDeps();
    (deps.prisma as any).activityGoal = {
      findMany: jest.fn().mockResolvedValue([
        { title: 'Run 10k', activityKind: 'run', customLabel: null, metric: 'distance_m', target: 10000, period: 'week', status: 'completed', startsOn: new Date('2026-03-02T00:00:00Z'), updatedAt: new Date('2026-06-01T00:00:00Z') },
      ]),
    };
    const result = await run(deps, 'get_goals');
    expect((deps.prisma as any).activityGoal.findMany.mock.calls[0][0].where).toEqual({ userId: USER, status: { not: 'active' } });
    expect(result.otherGoals).toEqual([
      { title: 'Run 10k', activityKind: 'run', customLabel: null, metric: 'distance_m', target: 10000, period: 'week', status: 'completed', startsOn: '2026-03-02', lastChanged: '2026-06-01' },
    ]);
  });

  it('get_profile lists the syncing devices, never their install or token ids', async () => {
    const deps = makeDeps();
    (deps.prisma as any).healthSyncDevice = {
      findMany: jest.fn().mockResolvedValue([
        { name: 'Pixel 9', manufacturer: 'Google', model: 'Pixel 9', status: 'active', lastSyncAt: new Date('2026-10-01T10:00:00Z'), timezone: 'America/Costa_Rica' },
      ]),
    };
    const result = await run(deps, 'get_profile');
    const query = (deps.prisma as any).healthSyncDevice.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ userId: USER });
    expect(Object.keys(query.select)).not.toEqual(expect.arrayContaining(['installationId']));
    expect(Object.keys(query.select)).not.toEqual(expect.arrayContaining(['patId']));
    expect(result.devices).toEqual([
      { name: 'Pixel 9', manufacturer: 'Google', model: 'Pixel 9', status: 'active', lastSyncAt: '2026-10-01T10:00:00.000Z', timeZone: 'America/Costa_Rica' },
    ]);
  });
});
