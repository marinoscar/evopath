import { randomUUID } from 'node:crypto';

// =============================================================================
// In-memory Prisma fake for ProgramsService unit specs (test-only)
// =============================================================================
//
// Covers exactly the calls `ProgramsService` makes, with a small generic
// `where` matcher (equality, `in`, `not`, `lt`/`lte`, `OR`, and the relation
// filters the service uses). `$transaction` snapshots every table and restores
// them when the callback throws, so specs can assert "nothing changed".
// Real-database behaviour (row locks, indexes) is proven in the db spec.
// =============================================================================

type Row = Record<string, any>;

const MODELS = [
  'program',
  'programBlock',
  'programWeek',
  'programWorkout',
  'programExercise',
  'programVersion',
  'programChangeLog',
  'workout',
  'exercise',
  'gym',
] as const;
type Model = (typeof MODELS)[number];

/** Relation name -> (target model, foreign key on this row). */
const RELATIONS: Partial<Record<Model, Record<string, [Model, string]>>> = {
  programWeek: { block: ['programBlock', 'blockId'] },
  programWorkout: { week: ['programWeek', 'weekId'] },
  programExercise: { programWorkout: ['programWorkout', 'programWorkoutId'] },
  workout: { programWorkout: ['programWorkout', 'programWorkoutId'] },
};

const OPERATORS = new Set(['in', 'not', 'lt', 'lte', 'gt', 'gte']);

export function createInMemoryProgramsPrisma() {
  const tables: Record<Model, Row[]> = Object.fromEntries(MODELS.map((m) => [m, []])) as unknown as Record<Model, Row[]>;

  const cmp = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() - b.getTime() : (a as number) - (b as number));
  const eq = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

  function matches(model: Model, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'OR') {
        if (!(cond as Row[]).some((sub) => matches(model, row, sub))) return false;
        continue;
      }
      const relation = RELATIONS[model]?.[key];
      if (relation) {
        const [target, fk] = relation;
        const related = tables[target].find((r) => r.id === row[fk]);
        if (!related || !matches(target, related, cond as Row)) return false;
        continue;
      }
      const value = row[key];
      if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
        const ops = Object.keys(cond);
        if (ops.every((op) => OPERATORS.has(op))) {
          const c = cond as Row;
          if ('in' in c && !c.in.some((v: unknown) => eq(v, value))) return false;
          if ('not' in c && eq(value, c.not)) return false;
          if ('lt' in c && !(cmp(value, c.lt) < 0)) return false;
          if ('lte' in c && !(cmp(value, c.lte) <= 0)) return false;
          if ('gt' in c && !(cmp(value, c.gt) > 0)) return false;
          if ('gte' in c && !(cmp(value, c.gte) >= 0)) return false;
          continue;
        }
      }
      if (!eq(value, cond)) return false;
    }
    return true;
  }

  function applyData(row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && typeof value === 'object' && 'increment' in value) row[key] = (row[key] ?? 0) + value.increment;
      else row[key] = value;
    }
    if ('updatedAt' in row) row.updatedAt = new Date();
  }

  function sortRows(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
    if (!orderBy) return rows;
    const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((a, b) => {
      for (const order of orders) {
        const [key, dir] = Object.entries(order)[0] as [string, 'asc' | 'desc'];
        const x = a[key];
        const y = b[key];
        const c = typeof x === 'string' ? String(x).localeCompare(String(y)) : cmp(x, y);
        if (c !== 0) return dir === 'desc' ? -c : c;
      }
      return 0;
    });
  }

  const defaults: Partial<Record<Model, () => Row>> = {
    program: () => ({
      status: 'draft',
      source: 'manual',
      autonomy: 'autonomous',
      currentVersion: 1,
      startDate: null,
      gymId: null,
      intake: null,
      rationale: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    programBlock: () => ({ archivedAt: null, focus: null, rationale: null }),
    programWeek: () => ({ archivedAt: null, isDeload: false }),
    programWorkout: () => ({ archivedAt: null, weekday: null, estimatedMinutes: null, rationale: null }),
    programExercise: () => ({ equipmentTypeId: null }),
    programVersion: () => ({ createdAt: new Date(), evidence: [], meta: {}, rationale: null, runId: null }),
    programChangeLog: () => ({
      createdAt: new Date(),
      status: 'applied',
      seenAt: null,
      decidedAt: null,
      operations: [],
      citations: [],
      revertsLogId: null,
      runId: null,
      rationale: null,
    }),
  };

  function delegate(model: Model) {
    const table = () => tables[model];
    const make = (data: Row) => ({ ...(defaults[model]?.() ?? {}), id: data.id ?? randomUUID(), ...data });
    return {
      findMany: async (args: Row = {}) => {
        let rows = sortRows(table().filter((row) => matches(model, row, args.where)), args.orderBy);
        if (args.distinct) {
          const seen = new Set<unknown>();
          rows = rows.filter((row) => (seen.has(row[args.distinct[0]]) ? false : (seen.add(row[args.distinct[0]]), true)));
        }
        if (args.take !== undefined) rows = rows.slice(0, args.take);
        return rows.map((row) => ({ ...row }));
      },
      findFirst: async (args: Row = {}) => {
        const rows = sortRows(table().filter((row) => matches(model, row, args.where)), args.orderBy);
        return rows[0] ? { ...rows[0] } : null;
      },
      findUnique: async (args: Row) => {
        const where = args.where.programId_versionNumber ?? args.where;
        const row = table().find((r) => matches(model, r, where));
        return row ? { ...row } : null;
      },
      create: async (args: Row) => {
        const row = make(args.data);
        table().push(row);
        return { ...row };
      },
      createMany: async (args: Row) => {
        for (const data of args.data) table().push(make(data));
        return { count: args.data.length };
      },
      update: async (args: Row) => {
        const row = table().find((r) => matches(model, r, args.where));
        if (!row) throw new Error(`${model}.update: no row`);
        applyData(row, args.data);
        return { ...row };
      },
      updateMany: async (args: Row) => {
        const rows = table().filter((r) => matches(model, r, args.where));
        rows.forEach((row) => applyData(row, args.data));
        return { count: rows.length };
      },
      deleteMany: async (args: Row) => {
        const doomed = new Set(table().filter((r) => matches(model, r, args.where)).map((r) => r.id));
        tables[model] = table().filter((r) => !doomed.has(r.id));
        cascade(model, doomed);
        return { count: doomed.size };
      },
      count: async (args: Row = {}) => table().filter((row) => matches(model, row, args.where)).length,
    };
  }

  /** The cascades the service relies on (tree children; SET NULL from workouts). */
  function cascade(model: Model, ids: Set<string>): void {
    if (ids.size === 0) return;
    const drop = (child: Model, fk: string) => {
      const doomed = new Set(tables[child].filter((r) => ids.has(r[fk])).map((r) => r.id));
      tables[child] = tables[child].filter((r) => !doomed.has(r.id));
      cascade(child, doomed);
    };
    if (model === 'program') {
      drop('programBlock', 'programId');
      drop('programVersion', 'programId');
      drop('programChangeLog', 'programId');
    }
    if (model === 'programBlock') drop('programWeek', 'blockId');
    if (model === 'programWeek') drop('programWorkout', 'weekId');
    if (model === 'programWorkout') {
      drop('programExercise', 'programWorkoutId');
      for (const w of tables.workout) if (ids.has(w.programWorkoutId)) w.programWorkoutId = null;
    }
  }

  const client: Row = Object.fromEntries(MODELS.map((m) => [m, delegate(m)]));
  client.$transaction = async (fn: (tx: Row) => Promise<unknown>) => {
    const saved = structuredClone(tables);
    try {
      return await fn(client);
    } catch (error) {
      for (const m of MODELS) tables[m] = saved[m];
      throw error;
    }
  };

  return { prisma: client, tables };
}
