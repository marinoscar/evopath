import { z } from 'zod';

import { planTreeSchema, type PlanTree } from './plan-tree.contract';

// =============================================================================
// PlanSnapshot: the immutable content of one program version (E5.1)
// =============================================================================
//
// Stored in `program_versions.snapshot`. Row ids are preserved, so restoring a
// version writes the same ids back (and un-archives rows kept for history).
// `schemaVersion` guards the format: a snapshot from a newer format is refused
// with a clear error rather than half-parsed.
// =============================================================================

export const PLAN_SNAPSHOT_SCHEMA_VERSION = 1;

export const planSnapshotHeaderSchema = z.object({
  name: z.string(),
  goal: z.string(),
  notes: z.string().nullable(),
  rationale: z.string().nullable(),
  autonomy: z.string(),
  gymId: z.string().nullable(),
});

export type PlanSnapshotHeader = z.output<typeof planSnapshotHeaderSchema>;

export interface PlanSnapshot {
  schemaVersion: typeof PLAN_SNAPSHOT_SCHEMA_VERSION;
  program: PlanSnapshotHeader;
  tree: PlanTree;
}

const planSnapshotSchema = z.object({
  schemaVersion: z.literal(PLAN_SNAPSHOT_SCHEMA_VERSION),
  program: planSnapshotHeaderSchema,
  tree: planTreeSchema,
});

export function snapshotOf(program: PlanSnapshotHeader, tree: PlanTree): PlanSnapshot {
  return {
    schemaVersion: PLAN_SNAPSHOT_SCHEMA_VERSION,
    program: {
      name: program.name,
      goal: program.goal,
      notes: program.notes,
      rationale: program.rationale,
      autonomy: program.autonomy,
      gymId: program.gymId,
    },
    tree,
  };
}

export type ParsedSnapshot =
  | { ok: true; snapshot: PlanSnapshot }
  | { ok: false; reason: 'UNSUPPORTED_SCHEMA_VERSION'; schemaVersion: unknown }
  | { ok: false; reason: 'INVALID_SNAPSHOT'; message: string };

/**
 * Parses a stored snapshot. Never throws: a snapshot written by a newer format
 * (`schemaVersion` above this build's) or a damaged one is reported, so revert
 * can refuse it with a readable 409 instead of crashing.
 */
export function parseSnapshot(value: unknown): ParsedSnapshot {
  const schemaVersion = (value as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (schemaVersion !== PLAN_SNAPSHOT_SCHEMA_VERSION) {
    return { ok: false, reason: 'UNSUPPORTED_SCHEMA_VERSION', schemaVersion };
  }
  const parsed = planSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: 'INVALID_SNAPSHOT', message: parsed.error.issues[0]?.message ?? 'Invalid snapshot' };
  }
  return { ok: true, snapshot: parsed.data as PlanSnapshot };
}

/** The tree of a snapshot, ids included. */
export function treeFromSnapshot(snapshot: PlanSnapshot): PlanTree {
  return structuredClone(snapshot.tree);
}
