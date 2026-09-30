import { randomUUID } from 'node:crypto';

import type { TrainingPlanRun } from '@prisma/client';

// =============================================================================
// An in-memory stand-in for the slice of Prisma the training run handler and
// service use on `training_plan_runs` and `audit_events`: `findUnique`,
// `findFirst`, `findMany`, `count`, `create`, `update`, `updateMany`, and
// `$transaction(fn)`; plus `gym.findFirst` and `program.findFirst` over the
// rows a spec seeds with `addGym` / `addProgram` (run start checks them). Where clauses support equality (null included), `{ in }`,
// `{ lt }` and `{ gt }`. Enough for unit specs; the real-Postgres suites
// cover the database's own rules (the partial unique index, CHECKs).
// =============================================================================

type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];

    if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
      const op = expected as { in?: unknown[]; lt?: unknown; gt?: unknown };
      if (op.in && !op.in.includes(actual)) return false;
      if (op.lt !== undefined && !((actual as number | Date) < (op.lt as number | Date))) return false;
      if (op.gt !== undefined && !((actual as number | Date) > (op.gt as number | Date))) return false;
      return true;
    }

    return actual === expected;
  });
}

function apply(row: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object' && 'increment' in (value as object)) {
      row[key] = (row[key] as number) + (value as { increment: number }).increment;
    } else if (value !== null && typeof value === 'object' && (value as { constructor?: { name?: string } }).constructor?.name === 'DbNull') {
      row[key] = null;
    } else {
      row[key] = value;
    }
  }
  row.updatedAt = new Date();
}

function pick(row: Record<string, unknown>, select?: Record<string, boolean>): Record<string, unknown> {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

export function newRunRow(overrides: Partial<TrainingPlanRun> = {}): TrainingPlanRun {
  const now = new Date();

  return {
    id: randomUUID(),
    userId: randomUUID(),
    kind: 'create',
    trigger: 'user',
    status: 'queued',
    stage: null,
    programId: null,
    jobId: null,
    jobIds: [],
    input: { request: {}, maxCriticRounds: 2 },
    contextSnapshot: null,
    roleModels: {},
    tokenCap: 400_000,
    usage: {},
    result: null,
    pendingDecision: null,
    errorCode: null,
    errorMessage: null,
    cancelRequestedAt: null,
    resumeCount: 0,
    eventSeq: 0,
    heartbeatAt: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

export function createInMemoryTrainingPrisma() {
  const runs = new Map<string, TrainingPlanRun>();
  const audits: Array<Record<string, unknown>> = [];
  const gyms: Array<Record<string, unknown>> = [];
  const programs: Array<Record<string, unknown>> = [];
  const finder = (rows: Array<Record<string, unknown>>) =>
    jest.fn(async (args: { where?: Where; select?: Record<string, boolean> } = {}) => {
      const row = rows.find((r) => matches(r, args.where));
      return row ? pick(row, args.select) : null;
    });

  const trainingPlanRun = {
    findUnique: jest.fn(async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
      const row = runs.get(args.where.id);
      return row ? pick(row as unknown as Record<string, unknown>, args.select) : null;
    }),
    findFirst: jest.fn(async (args: { where?: Where; select?: Record<string, boolean> } = {}) => {
      const row = [...runs.values()].find((r) => matches(r as unknown as Record<string, unknown>, args.where));
      return row ? pick(row as unknown as Record<string, unknown>, args.select) : null;
    }),
    findMany: jest.fn(async (args: { where?: Where; take?: number; skip?: number } = {}) =>
      [...runs.values()]
        .filter((r) => matches(r as unknown as Record<string, unknown>, args.where))
        .slice(args.skip ?? 0, args.take === undefined ? undefined : (args.skip ?? 0) + args.take),
    ),
    count: jest.fn(
      async (args: { where?: Where } = {}) =>
        [...runs.values()].filter((r) => matches(r as unknown as Record<string, unknown>, args.where)).length,
    ),
    create: jest.fn(async (args: { data: Partial<TrainingPlanRun> }) => {
      const row = newRunRow(args.data);
      runs.set(row.id, row);
      return { ...row };
    }),
    update: jest.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = runs.get(args.where.id);
      if (!row) throw new Error('trainingPlanRun.update: not found');
      apply(row as unknown as Record<string, unknown>, args.data);
      return { ...row };
    }),
    updateMany: jest.fn(async (args: { where: Where; data: Record<string, unknown> }) => {
      const rows = [...runs.values()].filter((r) => matches(r as unknown as Record<string, unknown>, args.where));
      for (const row of rows) apply(row as unknown as Record<string, unknown>, args.data);
      return { count: rows.length };
    }),
  };

  const prisma: {
    trainingPlanRun: typeof trainingPlanRun;
    gym: { findFirst: jest.Mock };
    program: { findFirst: jest.Mock };
    auditEvent: { create: jest.Mock };
    $transaction: jest.Mock;
  } = {
    trainingPlanRun,
    gym: { findFirst: finder(gyms) },
    program: { findFirst: finder(programs) },
    auditEvent: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        audits.push(args.data);
        return { id: randomUUID(), ...args.data };
      }),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(prisma)),
  };

  return {
    prisma,
    runs,
    audits,
    add(overrides: Partial<TrainingPlanRun> = {}): TrainingPlanRun {
      const row = newRunRow(overrides);
      runs.set(row.id, row);
      return row;
    },
    get(id: string): TrainingPlanRun | undefined {
      return runs.get(id);
    },
    /** A gym row `{ id, userId }` that `gym.findFirst` finds. */
    addGym(userId: string, id: string = randomUUID()): { id: string; userId: string } {
      gyms.push({ id, userId });
      return { id, userId };
    },
    /** A program row `{ id, userId, currentVersion }` that `program.findFirst` finds. */
    addProgram(userId: string, currentVersion = 1, id: string = randomUUID()) {
      const row = { id, userId, currentVersion };
      programs.push(row);
      return row;
    },
  };
}

export type InMemoryTrainingPrisma = ReturnType<typeof createInMemoryTrainingPrisma>;
