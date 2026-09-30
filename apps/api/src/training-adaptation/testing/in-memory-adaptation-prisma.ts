import { randomUUID } from 'node:crypto';

import { Prisma, type WorkoutAdaptation } from '@prisma/client';

import { createInMemoryTrainingPrisma } from '../../training-agents/testing/in-memory-training-prisma';
import { ACTIVE_ADAPTATION_INDEX_NAME, ACTIVE_ADAPTATION_STATUSES, ADAPTATION_TTL_MS } from '../adaptation.constants';

// =============================================================================
// An in-memory stand-in for `workout_adaptations` (plus the kit's run table)
// =============================================================================
//
// Built on `createInMemoryTrainingPrisma()` (runs, audits, `$transaction`), it
// adds `workoutAdaptation` with `create`, `findUnique`, `findFirst`,
// `findMany`, `count`, `update`, `updateMany` and `deleteMany`. Where clauses
// support equality (null included), `in`, `notIn`, `lt` and `gt`.
//
// It ENFORCES the partial unique index the way Postgres does (a second
// `queued` or `running` row for a user is `P2002` naming
// `workout_adaptations_active_per_user_uniq_idx`), so the create route's
// `409 ADAPTATION_IN_PROGRESS` is decided by the index and not by a pre-check.
// The real-Postgres suites (`*.db.spec.ts`) prove the index itself.
// =============================================================================

type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];

    if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
      const op = expected as { in?: unknown[]; notIn?: unknown[]; lt?: unknown; gt?: unknown };
      if (op.in && !op.in.includes(actual)) return false;
      if (op.notIn && op.notIn.includes(actual)) return false;
      if (op.lt !== undefined && !((actual as number | Date) < (op.lt as number | Date))) return false;
      if (op.gt !== undefined && !((actual as number | Date) > (op.gt as number | Date))) return false;
      return true;
    }

    return actual === expected;
  });
}

const isDbNull = (value: unknown) => value !== null && typeof value === 'object' && (value as { constructor?: { name?: string } }).constructor?.name === 'DbNull';

function apply(row: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    row[key] = isDbNull(value) ? null : value;
  }
  row.updatedAt = new Date();
}

function pick(row: Record<string, unknown>, select?: Record<string, boolean>): Record<string, unknown> {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

export function newAdaptationRow(overrides: Partial<WorkoutAdaptation> = {}): WorkoutAdaptation {
  const now = new Date();

  return {
    id: randomUUID(),
    userId: randomUUID(),
    status: 'queued',
    request: {},
    gymId: null,
    baseRef: null,
    contextSnapshot: {},
    proposal: null,
    guardrailReport: {},
    criticReport: null,
    safety: {},
    models: {},
    runId: null,
    jobId: null,
    errorCode: null,
    errorMessage: null,
    appliedAs: null,
    appliedWorkoutId: null,
    appliedPlanVersionId: null,
    appliedAt: null,
    expiresAt: new Date(now.getTime() + ADAPTATION_TTL_MS),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as WorkoutAdaptation;
}

export function activeIndexViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ACTIVE_ADAPTATION_INDEX_NAME },
  });
}

export function createInMemoryAdaptationPrisma() {
  const base = createInMemoryTrainingPrisma();
  const adaptations = new Map<string, WorkoutAdaptation>();
  const asRecord = (row: WorkoutAdaptation) => row as unknown as Record<string, unknown>;

  const workoutAdaptation = {
    create: jest.fn(async (args: { data: Partial<WorkoutAdaptation> & Record<string, unknown>; select?: Record<string, boolean> }) => {
      const data = Object.fromEntries(Object.entries(args.data).map(([k, v]) => [k, isDbNull(v) ? null : v])) as Partial<WorkoutAdaptation>;
      const row = newAdaptationRow(data);

      const active = ACTIVE_ADAPTATION_STATUSES.includes(row.status as never);
      if (active && [...adaptations.values()].some((r) => r.userId === row.userId && ACTIVE_ADAPTATION_STATUSES.includes(r.status as never))) {
        throw activeIndexViolation();
      }

      adaptations.set(row.id, row);
      return pick(asRecord(row), args.select);
    }),
    findUnique: jest.fn(async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
      const row = adaptations.get(args.where.id);
      return row ? pick(asRecord(row), args.select) : null;
    }),
    findFirst: jest.fn(async (args: { where?: Where; select?: Record<string, boolean> } = {}) => {
      const row = [...adaptations.values()].find((r) => matches(asRecord(r), args.where));
      return row ? pick(asRecord(row), args.select) : null;
    }),
    findMany: jest.fn(async (args: { where?: Where; take?: number; select?: Record<string, boolean> } = {}) =>
      [...adaptations.values()]
        .filter((r) => matches(asRecord(r), args.where))
        .slice(0, args.take)
        .map((r) => pick(asRecord(r), args.select)),
    ),
    count: jest.fn(async (args: { where?: Where } = {}) => [...adaptations.values()].filter((r) => matches(asRecord(r), args.where)).length),
    update: jest.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = adaptations.get(args.where.id);
      if (!row) throw new Error('workoutAdaptation.update: not found');
      apply(asRecord(row), args.data);
      return { ...row };
    }),
    updateMany: jest.fn(async (args: { where: Where; data: Record<string, unknown> }) => {
      const rows = [...adaptations.values()].filter((r) => matches(asRecord(r), args.where));
      for (const row of rows) apply(asRecord(row), args.data);
      return { count: rows.length };
    }),
    deleteMany: jest.fn(async (args: { where: Where }) => {
      const rows = [...adaptations.values()].filter((r) => matches(asRecord(r), args.where));
      for (const row of rows) adaptations.delete(row.id);
      return { count: rows.length };
    }),
  };

  (base.prisma as unknown as Record<string, unknown>).workoutAdaptation = workoutAdaptation;

  return {
    ...base,
    workoutAdaptation,
    adaptations,
    addAdaptation(overrides: Partial<WorkoutAdaptation> = {}): WorkoutAdaptation {
      const row = newAdaptationRow(overrides);
      adaptations.set(row.id, row);
      return row;
    },
    getAdaptation(id: string): WorkoutAdaptation | undefined {
      return adaptations.get(id);
    },
  };
}

export type InMemoryAdaptationPrisma = ReturnType<typeof createInMemoryAdaptationPrisma>;
