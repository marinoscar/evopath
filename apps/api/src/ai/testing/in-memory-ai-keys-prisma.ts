// =============================================================================
// A tiny in-memory stand-in for the three tables the AI key services touch
// (issue #431). TEST-ONLY.
//
// It implements exactly the `where` / `select` shapes `UserAiKeysService`,
// `UsableModelsService` and `AiKeyResolver` use — not Prisma — so "set, then
// list" means something in a unit test and a scoping bug (a query that forgot
// `userId`) actually returns another user's row instead of agreeing with a
// stub. Unknown shapes throw, so a service change that this fake does not
// understand fails loudly rather than silently matching everything.
// =============================================================================

import { randomUUID } from 'node:crypto';

export interface FakeUserAiKeyRow {
  id: string;
  userId: string;
  provider: string;
  secret: string;
  hint: string | null;
  verifiedAt: Date | null;
  lastErrorCode: string | null;
  reachableModelIds: string[];
  reachableCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeAiModelRow {
  id: string;
  provider: string;
  modelId: string;
  displayName: string | null;
  capabilities: unknown;
  enabled: boolean;
  deprecatedAt: Date | null;
  discoveredAt: Date;
}

type Where = Record<string, any>;

function pick<T extends object>(row: T, select?: Record<string, boolean>): Partial<T> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [key, on] of Object.entries(select)) {
    if (on) out[key] = (row as Record<string, unknown>)[key];
  }
  return out as Partial<T>;
}

function matchValue(actual: unknown, expected: any): boolean {
  if (expected === null) return actual === null;
  if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
  if (typeof expected === 'object' && !Array.isArray(expected)) {
    for (const [op, value] of Object.entries(expected)) {
      switch (op) {
        case 'in':
          if (!(value as unknown[]).includes(actual)) return false;
          break;
        case 'gt':
          if (!(actual !== null && (actual as any) > (value as any))) return false;
          break;
        case 'lt':
          if (!(actual !== null && (actual as any) < (value as any))) return false;
          break;
        default:
          throw new Error(`in-memory prisma: unsupported operator "${op}"`);
      }
    }
    return true;
  }
  return actual === expected;
}

function matches(row: Record<string, unknown>, where: Where = {}): boolean {
  for (const [key, expected] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(expected as Where[]).some((branch) => matches(row, branch))) return false;
      continue;
    }
    if (key === 'userId_provider') {
      if (row.userId !== expected.userId || row.provider !== expected.provider) return false;
      continue;
    }
    if (key === 'provider_modelId') {
      if (row.provider !== expected.provider || row.modelId !== expected.modelId) return false;
      continue;
    }
    if (!matchValue(row[key], expected)) return false;
  }
  return true;
}

function ordered<T extends Record<string, any>>(rows: T[], orderBy?: Record<string, 'asc' | 'desc'>): T[] {
  if (!orderBy) return rows;
  const [[field, dir]] = Object.entries(orderBy);
  return [...rows].sort((a, b) => {
    const cmp = a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0;
    return dir === 'desc' ? -cmp : cmp;
  });
}

export function createInMemoryAiKeysPrisma() {
  const keys: FakeUserAiKeyRow[] = [];
  const models: FakeAiModelRow[] = [];
  const audits: Array<Record<string, unknown>> = [];

  const prisma = {
    userAiKey: {
      findMany: jest.fn(async (args: { where?: Where; select?: any; orderBy?: any; take?: number } = {}) => {
        let rows = ordered(
          keys.filter((row) => matches(row as never, args.where)),
          args.orderBy,
        );
        if (args.take !== undefined) rows = rows.slice(0, args.take);
        return rows.map((row) => pick(row, args.select));
      }),
      findUnique: jest.fn(async (args: { where: Where; select?: any }) => {
        const row = keys.find((candidate) => matches(candidate as never, args.where));
        return row ? pick(row, args.select) : null;
      }),
      count: jest.fn(async (args: { where?: Where } = {}) =>
        keys.filter((row) => matches(row as never, args.where)).length,
      ),
      upsert: jest.fn(async (args: { where: Where; create: any; update: any; select?: any }) => {
        let row = keys.find((candidate) => matches(candidate as never, args.where));
        const now = new Date();
        if (row) {
          Object.assign(row, args.update, { updatedAt: now });
        } else {
          row = {
            id: randomUUID(),
            hint: null,
            verifiedAt: null,
            lastErrorCode: null,
            reachableModelIds: [],
            reachableCheckedAt: null,
            createdAt: now,
            updatedAt: now,
            ...args.create,
          } as FakeUserAiKeyRow;
          keys.push(row);
        }
        return pick(row, args.select);
      }),
      updateMany: jest.fn(async (args: { where: Where; data: any }) => {
        const rows = keys.filter((row) => matches(row as never, args.where));
        for (const row of rows) Object.assign(row, args.data, { updatedAt: new Date() });
        return { count: rows.length };
      }),
      deleteMany: jest.fn(async (args: { where: Where }) => {
        const before = keys.length;
        for (let i = keys.length - 1; i >= 0; i -= 1) {
          if (matches(keys[i] as never, args.where)) keys.splice(i, 1);
        }
        return { count: before - keys.length };
      }),
    },
    aiModel: {
      findMany: jest.fn(async (args: { where?: Where; select?: any; orderBy?: any } = {}) =>
        models.filter((row) => matches(row as never, args.where)).map((row) => pick(row, args.select)),
      ),
      findUnique: jest.fn(async (args: { where: Where; select?: any }) => {
        const row = models.find((candidate) => matches(candidate as never, args.where));
        return row ? pick(row, args.select) : null;
      }),
      findFirst: jest.fn(async (args: { where?: Where; select?: any; orderBy?: any } = {}) => {
        const row = ordered(
          models.filter((candidate) => matches(candidate as never, args.where)),
          args.orderBy,
        )[0];
        return row ? pick(row, args.select) : null;
      }),
    },
    auditEvent: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        audits.push(args.data);
        return { id: randomUUID(), ...args.data };
      }),
    },
  };

  return {
    prisma,
    keys,
    models,
    audits,
    addModel(overrides: Partial<FakeAiModelRow> & { modelId: string }): FakeAiModelRow {
      const row: FakeAiModelRow = {
        id: randomUUID(),
        provider: 'openai',
        displayName: null,
        capabilities: {
          capabilities: ['responses', 'streaming'],
          inputModalities: ['text'],
          outputModalities: ['text'],
        },
        enabled: true,
        deprecatedAt: null,
        discoveredAt: new Date('2026-01-01T00:00:00.000Z'),
        ...overrides,
      };
      models.push(row);
      return row;
    },
  };
}

export type InMemoryAiKeysPrisma = ReturnType<typeof createInMemoryAiKeysPrisma>;
