import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { addDays, fromDbDate, toDbDate } from '../check-ins/local-date';
import { PrismaService } from '../prisma/prisma.service';
import {
  planChangeCitationsSchema,
  planChangeOperationsSchema,
  planEvidenceSchema,
  type Evidence,
} from './contracts/plan-change.contract';
import { parseSnapshot, snapshotOf, treeFromSnapshot } from './contracts/plan-snapshot.contract';
import {
  PLAN_LIMITS,
  emptyPlanTree,
  exerciseIdsOf,
  planTreeSchema,
  stripIds,
  type PlanTree,
} from './contracts/plan-tree.contract';
import type {
  ChangeLogEntryData,
  ChangeLogQuery,
  CreateProgramInput,
  ProgramListItemData,
  ProgramViewData,
  RevertProgramInput,
  UpdateProgramInput,
  VersionSummaryData,
  VersionViewData,
} from './dto/program.dto';
import { assignIds, diffTree, liveTreeOf, type ProgramRows, type TreeWrites } from './plan-diff';
import { hasLoggedHistory, programHasLoggedHistory } from './program-history';
import {
  PROGRAM_HEADER_SELECT,
  loadProgramRows,
  toChangeLogEntry,
  toProgramListItem,
  toProgramView,
  toTreeView,
  toVersionSummary,
  toVersionView,
  type ExerciseRef,
} from './program-mapper';
import {
  CHANGE_RATIONALE_MAX,
  CHANGE_SUMMARY_MAX,
  PROGRAM_REASONS,
  PROGRAM_TRANSITIONS,
  PROGRAM_TX_TIMEOUT_MS,
  START_DATE_FUTURE_DAYS,
  START_DATE_PAST_DAYS,
  isActiveProgramConflict,
  type ChangeActor,
  type ChangeKind,
  type ChangeOrigin,
  type ProgramAutonomy,
  type ProgramGoal,
  type ProgramSource,
  type ProgramStatus,
} from './programs.constants';

// =============================================================================
// ProgramsService: training plans, their versions and change log (E5.1)
// =============================================================================
//
// THE CHOKEPOINT. Every change to a program's CONTENT (its tree) goes through
// `applyChange`: manual edits, AI adaptations and reverts. Creating a program
// with its first version (manual draft, AI plan, duplicate) goes through
// `createWithTree`. Both validate with the shared contract, write the tree
// through the same diff writer, and append exactly one `program_versions` row
// and one `program_change_log` row in the same transaction. Nothing else in
// the codebase writes those tables or the tree.
//
// OPTIMISTIC CONCURRENCY is a conditional `updateMany` on `currentVersion`
// inside the transaction: the row lock makes a concurrent second writer
// re-check the predicate after the first commits and match zero rows. There
// is deliberately no `findFirst` pre-check (it would let both pass).
//
// NOTIFICATIONS are raised by callers after this returns (after commit,
// outside the transaction), never from here.
//
// Owner-scoped: another user's program is a 404, never a 403.
// =============================================================================

export interface ApplyChangeInput {
  userId: string;
  programId: string;
  /** Optimistic concurrency: the version the caller based its change on. */
  expectedVersion: number;
  origin: ChangeOrigin;
  actor: ChangeActor;
  kind: ChangeKind;
  /** Only `applied`; proposals are recorded elsewhere and never touch the tree. */
  status?: 'applied';
  /** Pure: returns the new tree from a copy of the live one. */
  mutate: (tree: PlanTree) => PlanTree;
  summary: string;
  rationale?: string;
  operations?: unknown[];
  citations?: unknown[];
  evidence?: Evidence[];
  /** Replaces `programs.rationale` when given. */
  planRationale?: string;
  runId?: string;
  revertsLogId?: string;
  /** Provenance stored on the version (models, efforts, rounds, tokens). */
  meta?: Record<string, unknown>;
}

export interface ApplyChangeResult {
  versionNumber: number;
  changeLogId: string;
  warnings: string[];
}

export interface CreateWithTreeInput {
  userId: string;
  header: {
    name: string;
    goal: ProgramGoal;
    notes?: string | null;
    source: ProgramSource;
    autonomy?: ProgramAutonomy;
    gymId?: string | null;
    intake?: Prisma.InputJsonValue | null;
    rationale?: string | null;
  };
  /** Validated with the shared contract; ids are generated where missing. */
  tree: unknown;
  origin: 'initial' | 'ai_create' | 'duplicate';
  actor: ChangeActor;
  summary: string;
  rationale?: string;
  citations?: unknown[];
  evidence?: Evidence[];
  runId?: string;
  meta?: Record<string, unknown>;
}

export interface CreateWithTreeResult extends ApplyChangeResult {
  programId: string;
}

type Tx = Prisma.TransactionClient;

const changeMetaSchema = z.object({
  summary: z.string().trim().min(1).max(CHANGE_SUMMARY_MAX),
  rationale: z.string().max(CHANGE_RATIONALE_MAX).optional(),
  operations: planChangeOperationsSchema.optional(),
  citations: planChangeCitationsSchema.optional(),
  evidence: planEvidenceSchema.optional(),
  planRationale: z.string().max(PLAN_LIMITS.planRationaleMax).optional(),
  runId: z.uuid().optional(),
  revertsLogId: z.uuid().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const CURSOR_SEPARATOR = '|';

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}${CURSOR_SEPARATOR}${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(CURSOR_SEPARATOR);
  const createdAt = new Date(at ?? '');
  if (!id || !z.uuid().safeParse(id).success || Number.isNaN(createdAt.getTime())) {
    throw new BadRequestException({ message: 'Invalid cursor', details: { issues: [{ path: 'cursor', message: 'Invalid cursor' }] } });
  }
  return { createdAt, id };
}

export function programNotFound(): NotFoundException {
  return new NotFoundException('Program not found');
}

function conflict(reason: string, message: string, extra: Record<string, unknown> = {}): ConflictException {
  return new ConflictException({ message, details: { reason, ...extra } });
}

function badPlan(reason: string, message: string, extra: Record<string, unknown> = {}): BadRequestException {
  return new BadRequestException({ message, details: { reason, ...extra } });
}

@Injectable()
export class ProgramsService {
  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // The chokepoint
  // ===========================================================================

  /**
   * Applies one content change as a new immutable version. Throws 404 for a
   * program the caller does not own, 409 `TRAINING_STALE_PLAN` (with
   * `currentVersion`) when `expectedVersion` is not current, 409
   * `PROGRAM_ARCHIVED` on an archived program, and 400 when the mutated tree
   * breaks the contract. Any failure leaves the tree and version untouched.
   */
  async applyChange(input: ApplyChangeInput): Promise<ApplyChangeResult> {
    this.checkChangeMeta(input);
    return this.prisma.$transaction((tx) => this.applyChangeTx(tx, input), { timeout: PROGRAM_TX_TIMEOUT_MS });
  }

  /** Creates a program with version 1 of its tree. The only other writer of the tree. */
  async createWithTree(input: CreateWithTreeInput): Promise<CreateWithTreeResult> {
    this.checkChangeMeta(input);
    return this.prisma.$transaction(
      async (tx) => {
        const { tree, warnings } = await this.validateTree(tx, input.userId, input.tree);
        assignIds(tree);

        const program = await tx.program.create({
          data: {
            userId: input.userId,
            name: input.header.name,
            goal: input.header.goal,
            notes: input.header.notes ?? null,
            source: input.header.source,
            autonomy: input.header.autonomy ?? 'autonomous',
            gymId: input.header.gymId ?? null,
            intake: input.header.intake ?? Prisma.JsonNull,
            rationale: input.header.rationale ?? null,
            currentVersion: 1,
          },
        });

        await this.writeTree(tx, program.id, { blocks: [], weeks: [], workouts: [], exercises: [] }, tree);

        await tx.programVersion.create({
          data: {
            programId: program.id,
            versionNumber: 1,
            origin: input.origin,
            snapshot: snapshotOf(program, tree) as unknown as Prisma.InputJsonValue,
            rationale: input.rationale ?? null,
            evidence: (input.evidence ?? []) as Prisma.InputJsonValue,
            runId: input.runId ?? null,
            meta: (input.meta ?? {}) as Prisma.InputJsonValue,
          },
        });
        const log = await tx.programChangeLog.create({
          data: {
            programId: program.id,
            userId: input.userId,
            kind: 'created',
            actor: input.actor,
            status: 'applied',
            fromVersion: null,
            toVersion: 1,
            runId: input.runId ?? null,
            summary: input.summary,
            rationale: input.rationale ?? null,
            citations: (input.citations ?? []) as Prisma.InputJsonValue,
          },
          select: { id: true },
        });

        return { programId: program.id, versionNumber: 1, changeLogId: log.id, warnings };
      },
      { timeout: PROGRAM_TX_TIMEOUT_MS },
    );
  }

  /**
   * Restores a version's tree as a NEW version (`origin: revert`). By
   * `changeLogId`, only the latest applied change can be undone (409
   * `NOT_LATEST` with `latestLogId` otherwise); that entry becomes `reverted`.
   */
  async revert(input: {
    userId: string;
    programId: string;
    expectedVersion: number;
    toVersion?: number;
    changeLogId?: string;
  }): Promise<ApplyChangeResult> {
    const { userId, programId, expectedVersion } = input;
    if ((input.toVersion === undefined) === (input.changeLogId === undefined)) {
      throw new BadRequestException('Send exactly one of toVersion or changeLogId');
    }
    await this.assertOwned(userId, programId);

    let targetVersion: number;
    let revertsLogId: string | undefined;
    if (input.changeLogId !== undefined) {
      const entry = await this.prisma.programChangeLog.findFirst({
        where: { id: input.changeLogId, programId },
        select: { id: true, fromVersion: true },
      });
      if (!entry) throw new NotFoundException('Change log entry not found');
      if (entry.fromVersion === null) {
        throw conflict(PROGRAM_REASONS.NOT_REVERTIBLE, 'This change created the plan and cannot be undone; archive the plan instead.');
      }
      targetVersion = entry.fromVersion;
      revertsLogId = entry.id;
    } else {
      targetVersion = input.toVersion!;
    }

    const version = await this.prisma.programVersion.findUnique({
      where: { programId_versionNumber: { programId, versionNumber: targetVersion } },
      select: { snapshot: true },
    });
    if (!version) throw new NotFoundException(`Version ${targetVersion} not found`);
    const parsed = parseSnapshot(version.snapshot);
    if (!parsed.ok) {
      throw conflict(
        PROGRAM_REASONS.SNAPSHOT_UNSUPPORTED,
        parsed.reason === 'UNSUPPORTED_SCHEMA_VERSION'
          ? `Version ${targetVersion} was saved in a format this server cannot restore.`
          : `Version ${targetVersion} cannot be restored: ${parsed.message}`,
        { version: targetVersion },
      );
    }
    const snapshot = parsed.snapshot;

    const change: ApplyChangeInput = {
      userId,
      programId,
      expectedVersion,
      origin: 'revert',
      actor: 'user',
      kind: 'reverted',
      mutate: () => treeFromSnapshot(snapshot),
      summary: revertsLogId ? `Undid a change (restored version ${targetVersion})` : `Restored version ${targetVersion}`,
      planRationale: snapshot.program.rationale ?? undefined,
      revertsLogId,
    };
    this.checkChangeMeta(change);

    return this.prisma.$transaction(
      (tx) =>
        this.applyChangeTx(tx, change, async () => {
          if (!revertsLogId) return;
          // The bump succeeded, so `expectedVersion` is current: the entry must be the change that produced it.
          const reverted = await tx.programChangeLog.updateMany({
            where: { id: revertsLogId, programId, status: 'applied', toVersion: expectedVersion },
            data: { status: 'reverted', decidedAt: new Date() },
          });
          if (reverted.count === 0) {
            const latest = await tx.programChangeLog.findFirst({
              where: { programId, status: 'applied', toVersion: expectedVersion },
              orderBy: { createdAt: 'desc' },
              select: { id: true },
            });
            throw conflict(
              PROGRAM_REASONS.NOT_LATEST,
              'Only the latest change can be undone; restore an earlier version instead.',
              { latestLogId: latest?.id ?? null },
            );
          }
        }),
      { timeout: PROGRAM_TX_TIMEOUT_MS },
    );
  }

  private checkChangeMeta(input: Omit<Partial<ApplyChangeInput>, 'origin'> & { summary: string }): void {
    const parsed = changeMetaSchema.safeParse({
      summary: input.summary,
      rationale: input.rationale,
      operations: input.operations,
      citations: input.citations,
      evidence: input.evidence,
      planRationale: input.planRationale,
      runId: input.runId,
      revertsLogId: input.revertsLogId,
      meta: input.meta,
    });
    if (!parsed.success) {
      throw badPlan(PROGRAM_REASONS.INVALID_PLAN, 'Invalid change', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
      });
    }
  }

  private async applyChangeTx(tx: Tx, input: ApplyChangeInput, afterBump?: () => Promise<void>): Promise<ApplyChangeResult> {
    const { userId, programId, expectedVersion } = input;

    // 1. Conditional bump: the only concurrency check.
    const bumped = await tx.program.updateMany({
      where: { id: programId, userId, currentVersion: expectedVersion, status: { not: 'archived' } },
      data: { currentVersion: { increment: 1 } },
    });
    if (bumped.count === 0) throw await this.bumpRefusal(tx, userId, programId);
    await afterBump?.();

    // 2. Load the live tree, mutate, validate.
    const rows = await loadProgramRows(tx, programId);
    const mutated = input.mutate(structuredClone(liveTreeOf(rows)));
    const { tree, warnings } = await this.validateTree(tx, userId, mutated);
    assignIds(tree);

    // 3. Diff by row id and write (history-preserving deletes).
    await this.writeTree(tx, programId, rows, tree);

    // 4. Version and change log.
    const versionNumber = expectedVersion + 1;
    const program = await tx.program.update({
      where: { id: programId },
      data: input.planRationale !== undefined ? { rationale: input.planRationale } : {},
      select: { name: true, goal: true, notes: true, rationale: true, autonomy: true, gymId: true },
    });
    await tx.programVersion.create({
      data: {
        programId,
        versionNumber,
        origin: input.origin,
        snapshot: snapshotOf(program, tree) as unknown as Prisma.InputJsonValue,
        rationale: input.rationale ?? null,
        evidence: (input.evidence ?? []) as Prisma.InputJsonValue,
        runId: input.runId ?? null,
        meta: (input.meta ?? {}) as Prisma.InputJsonValue,
      },
    });
    const log = await tx.programChangeLog.create({
      data: {
        programId,
        userId,
        kind: input.kind,
        actor: input.actor,
        status: 'applied',
        fromVersion: expectedVersion,
        toVersion: versionNumber,
        runId: input.runId ?? null,
        summary: input.summary,
        rationale: input.rationale ?? null,
        operations: (input.operations ?? []) as Prisma.InputJsonValue,
        citations: (input.citations ?? []) as Prisma.InputJsonValue,
        revertsLogId: input.revertsLogId ?? null,
      },
      select: { id: true },
    });

    return { versionNumber, changeLogId: log.id, warnings };
  }

  /** Why a conditional bump matched nothing: 404, archived, or stale. */
  private async bumpRefusal(tx: Tx, userId: string, programId: string): Promise<Error> {
    const program = await tx.program.findFirst({
      where: { id: programId, userId },
      select: { currentVersion: true, status: true },
    });
    if (!program) return programNotFound();
    if (program.status === 'archived') {
      return conflict(PROGRAM_REASONS.PROGRAM_ARCHIVED, 'This plan is archived; duplicate it to edit a copy.');
    }
    return conflict(PROGRAM_REASONS.STALE_PLAN, 'The plan changed since you loaded it. Reload and try again.', {
      currentVersion: program.currentVersion,
    });
  }

  /**
   * The contract plus the checks that need the database: every `exerciseId`
   * exists and is the caller's to use (one `findMany` for the whole tree).
   */
  private async validateTree(tx: Tx, userId: string, candidate: unknown): Promise<{ tree: PlanTree; warnings: string[] }> {
    const parsed = planTreeSchema.safeParse(candidate);
    if (!parsed.success) {
      throw badPlan(PROGRAM_REASONS.INVALID_PLAN, 'The plan is not valid', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
      });
    }
    const tree = parsed.data;

    const ids = exerciseIdsOf(tree);
    const found = ids.length
      ? await tx.exercise.findMany({
          where: { id: { in: ids }, OR: [{ ownerUserId: null }, { ownerUserId: userId }] },
          select: { id: true, name: true, status: true },
        })
      : [];
    const known = new Set(found.map((exercise) => exercise.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw badPlan(PROGRAM_REASONS.UNKNOWN_EXERCISES, `Unknown exercises: ${unknown.join(', ')}`, {
        exerciseIds: unknown,
        issues: [{ path: 'exerciseId', message: `Unknown exercises: ${unknown.join(', ')}` }],
      });
    }

    const warnings = found
      .filter((exercise) => exercise.status !== 'active')
      .map((exercise) => `"${exercise.name}" is awaiting review and will not show in the plan until approved.`);
    return { tree, warnings };
  }

  /** Executes the diff from `rows` to `tree` (every id assigned). */
  private async writeTree(tx: Tx, programId: string, rows: ProgramRows, tree: PlanTree): Promise<TreeWrites> {
    const withHistory = await hasLoggedHistory(tx, rows.workouts.map((row) => row.id));
    const writes = diffTree(rows, tree, withHistory);
    await this.assertNewIdsFree(tx, writes);

    const { create, update, archive } = writes;
    if (create.blocks.length) {
      await tx.programBlock.createMany({ data: create.blocks.map((row) => ({ ...row, programId })) });
    }
    if (create.weeks.length) {
      await tx.programWeek.createMany({ data: create.weeks.map((row) => ({ ...row, programId })) });
    }
    if (create.workouts.length) await tx.programWorkout.createMany({ data: create.workouts });
    if (create.exercises.length) await tx.programExercise.createMany({ data: create.exercises });

    for (const { id, ...data } of update.blocks) {
      await tx.programBlock.update({ where: { id }, data: { ...data, archivedAt: null } });
    }
    for (const { id, ...data } of update.weeks) {
      await tx.programWeek.update({ where: { id }, data: { ...data, archivedAt: null } });
    }
    for (const { id, ...data } of update.workouts) {
      await tx.programWorkout.update({ where: { id }, data: { ...data, archivedAt: null } });
    }
    for (const { id, ...data } of update.exercises) {
      await tx.programExercise.update({ where: { id }, data });
    }

    const now = new Date();
    if (archive.workouts.length) {
      await tx.programWorkout.updateMany({ where: { id: { in: archive.workouts } }, data: { archivedAt: now } });
    }
    if (archive.weeks.length) {
      await tx.programWeek.updateMany({ where: { id: { in: archive.weeks } }, data: { archivedAt: now } });
    }
    if (archive.blocks.length) {
      await tx.programBlock.updateMany({ where: { id: { in: archive.blocks } }, data: { archivedAt: now } });
    }

    // Bottom-up, after every move above so a moved child is never cascaded.
    if (writes.delete.exercises.length) await tx.programExercise.deleteMany({ where: { id: { in: writes.delete.exercises } } });
    if (writes.delete.workouts.length) await tx.programWorkout.deleteMany({ where: { id: { in: writes.delete.workouts } } });
    if (writes.delete.weeks.length) await tx.programWeek.deleteMany({ where: { id: { in: writes.delete.weeks } } });
    if (writes.delete.blocks.length) await tx.programBlock.deleteMany({ where: { id: { in: writes.delete.blocks } } });

    return writes;
  }

  /** A caller-chosen id for a new row must not already name a row of another program. */
  private async assertNewIdsFree(tx: Tx, writes: TreeWrites): Promise<void> {
    const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
    const { blocks, weeks, workouts, exercises } = writes.create;
    const taken = (
      await Promise.all([
        blocks.length ? tx.programBlock.findMany({ where: { id: { in: ids(blocks) } }, select: { id: true } }) : [],
        weeks.length ? tx.programWeek.findMany({ where: { id: { in: ids(weeks) } }, select: { id: true } }) : [],
        workouts.length ? tx.programWorkout.findMany({ where: { id: { in: ids(workouts) } }, select: { id: true } }) : [],
        exercises.length ? tx.programExercise.findMany({ where: { id: { in: ids(exercises) } }, select: { id: true } }) : [],
      ])
    )
      .flat()
      .map((row) => row.id);
    if (taken.length > 0) {
      throw badPlan(PROGRAM_REASONS.ROW_ID_CONFLICT, 'Some row ids belong to another plan; omit them for new rows.', {
        ids: taken,
      });
    }
  }

  // ===========================================================================
  // Reads
  // ===========================================================================

  async list(userId: string, status?: ProgramStatus): Promise<ProgramListItemData[]> {
    const programs = await this.prisma.program.findMany({
      where: { userId, ...(status ? { status } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        ...PROGRAM_HEADER_SELECT,
        _count: { select: { changes: { where: { actor: 'ai', seenAt: null } } } },
      },
    });
    return programs.map(({ _count, ...program }) => toProgramListItem(program, _count.changes));
  }

  async get(userId: string, programId: string): Promise<ProgramViewData> {
    const program = await this.prisma.program.findFirst({
      where: { id: programId, userId },
      select: {
        ...PROGRAM_HEADER_SELECT,
        notes: true,
        rationale: true,
        intake: true,
        gym: { select: { id: true, name: true } },
      },
    });
    if (!program) throw programNotFound();

    const [rows, version] = await Promise.all([
      loadProgramRows(this.prisma, programId),
      this.prisma.programVersion.findUnique({
        where: { programId_versionNumber: { programId, versionNumber: program.currentVersion } },
        select: { versionNumber: true, origin: true, rationale: true, evidence: true, meta: true, createdAt: true },
      }),
    ]);
    const tree = liveTreeOf(rows);
    const exerciseIds = exerciseIdsOf(tree);
    const exercises: ExerciseRef[] = exerciseIds.length
      ? await this.prisma.exercise.findMany({
          where: { id: { in: exerciseIds } },
          select: { id: true, name: true, slug: true, trackingMode: true, status: true, ownerUserId: true },
        })
      : [];

    return toProgramView(program, version, toTreeView(tree, new Map(exercises.map((row) => [row.id, row])), userId));
  }

  async listVersions(userId: string, programId: string): Promise<VersionSummaryData[]> {
    await this.assertOwned(userId, programId);
    const [versions, logs] = await Promise.all([
      this.prisma.programVersion.findMany({
        where: { programId },
        orderBy: { versionNumber: 'desc' },
        select: { versionNumber: true, origin: true, createdAt: true, runId: true },
      }),
      this.prisma.programChangeLog.findMany({
        where: { programId, toVersion: { not: null }, status: { not: 'proposed' } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, summary: true, toVersion: true },
      }),
    ]);
    const logByVersion = new Map(logs.map((log) => [log.toVersion!, log]));
    return versions.map((version) => toVersionSummary(version, logByVersion.get(version.versionNumber)));
  }

  async getVersion(userId: string, programId: string, versionNumber: number): Promise<VersionViewData> {
    await this.assertOwned(userId, programId);
    const [version, log] = await Promise.all([
      this.prisma.programVersion.findUnique({
        where: { programId_versionNumber: { programId, versionNumber } },
        select: {
          versionNumber: true,
          origin: true,
          createdAt: true,
          runId: true,
          rationale: true,
          evidence: true,
          meta: true,
          snapshot: true,
        },
      }),
      this.prisma.programChangeLog.findFirst({
        where: { programId, toVersion: versionNumber, status: { not: 'proposed' } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, summary: true },
      }),
    ]);
    if (!version) throw new NotFoundException(`Version ${versionNumber} not found`);
    return toVersionView(version, log ?? undefined);
  }

  async listChangeLog(
    userId: string,
    programId: string,
    query: ChangeLogQuery,
  ): Promise<{ items: ChangeLogEntryData[]; nextCursor: string | null }> {
    await this.assertOwned(userId, programId);
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await this.prisma.programChangeLog.findMany({
      where: {
        programId,
        ...(query.status ? { status: query.status } : {}),
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const nextCursor = rows.length > query.limit ? encodeCursor(page[page.length - 1]) : null;
    return { items: page.map(toChangeLogEntry), nextCursor };
  }

  // ===========================================================================
  // Writes outside the tree
  // ===========================================================================

  /** A manual draft with one block and one empty week, version 1 (`origin: initial`). */
  async create(userId: string, dto: CreateProgramInput): Promise<ProgramViewData> {
    const result = await this.createWithTree({
      userId,
      header: { name: dto.name, goal: dto.goal, notes: dto.notes ?? null, source: 'manual' },
      tree: emptyPlanTree(),
      origin: 'initial',
      actor: 'user',
      summary: 'Created by you',
    });
    return this.get(userId, result.programId);
  }

  /** Header fields only; no version bump (a version is tree content). */
  async update(userId: string, programId: string, dto: UpdateProgramInput): Promise<ProgramViewData> {
    if (dto.gymId) {
      const gym = await this.prisma.gym.findFirst({ where: { id: dto.gymId, userId }, select: { id: true } });
      if (!gym) throw new NotFoundException('Gym not found');
    }
    const updated = await this.prisma.program.updateMany({
      where: { id: programId, userId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.goal !== undefined ? { goal: dto.goal } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.autonomy !== undefined ? { autonomy: dto.autonomy } : {}),
        ...(dto.gymId !== undefined ? { gymId: dto.gymId } : {}),
      },
    });
    if (updated.count === 0) throw programNotFound();
    return this.get(userId, programId);
  }

  /** `PUT /structure`: replace the tree as the owner (`origin: manual_edit`). */
  async replaceStructure(userId: string, programId: string, expectedVersion: number, tree: PlanTree): Promise<ProgramViewData> {
    const result = await this.applyChange({
      userId,
      programId,
      expectedVersion,
      origin: 'manual_edit',
      actor: 'user',
      kind: 'edited',
      mutate: () => structuredClone(tree),
      summary: 'Edited by you',
    });
    return { ...(await this.get(userId, programId)), warnings: result.warnings };
  }

  async revertAndRead(userId: string, programId: string, expectedVersion: number, dto: RevertProgramInput): Promise<ProgramViewData> {
    const result = await this.revert({ userId, programId, expectedVersion, ...dto });
    return { ...(await this.get(userId, programId)), warnings: result.warnings };
  }

  /**
   * Makes the program the caller's active one. Any other active program is
   * paused in the same transaction; the partial unique index
   * `programs_one_active_per_user_uniq_idx` is the backstop for a race.
   */
  async activate(userId: string, programId: string, startDate: string, today = new Date()): Promise<ProgramViewData> {
    const todayStr = fromDbDate(today);
    if (startDate < addDays(todayStr, -START_DATE_PAST_DAYS) || startDate > addDays(todayStr, START_DATE_FUTURE_DAYS)) {
      throw badPlan(
        PROGRAM_REASONS.START_DATE_OUT_OF_RANGE,
        `startDate must be within ${START_DATE_PAST_DAYS} days in the past and ${START_DATE_FUTURE_DAYS} days in the future`,
        { issues: [{ path: 'startDate', message: 'Out of range' }] },
      );
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const program = await tx.program.findFirst({ where: { id: programId, userId }, select: { status: true } });
        if (!program) throw programNotFound();
        this.assertTransition('activate', program.status as ProgramStatus);

        const scheduled = await tx.programWorkout.count({
          where: {
            weekday: { not: null },
            archivedAt: null,
            week: { programId, archivedAt: null, block: { archivedAt: null } },
          },
        });
        if (scheduled === 0) {
          throw conflict(PROGRAM_REASONS.NOT_SCHEDULABLE, 'Add at least one workout with a weekday before activating this plan.');
        }

        await tx.program.updateMany({
          where: { userId, status: 'active', id: { not: programId } },
          data: { status: 'paused' },
        });
        const activated = await tx.program.updateMany({
          where: { id: programId, userId, status: { in: [...PROGRAM_TRANSITIONS.activate] } },
          data: { status: 'active', startDate: toDbDate(startDate) },
        });
        if (activated.count === 0) this.assertTransition('activate', 'active');
      });
    } catch (error) {
      if (isActiveProgramConflict(error)) {
        throw conflict(PROGRAM_REASONS.ACTIVE_PROGRAM_CONFLICT, 'Another plan was activated at the same time. Reload and try again.');
      }
      throw error;
    }
    return this.get(userId, programId);
  }

  async pause(userId: string, programId: string): Promise<ProgramViewData> {
    return this.transition(userId, programId, 'pause', 'paused');
  }

  async archive(userId: string, programId: string): Promise<ProgramViewData> {
    return this.transition(userId, programId, 'archive', 'archived');
  }

  /** A deep copy as a draft: new ids, " (copy)" suffix, version 1 (`origin: duplicate`). */
  async duplicate(userId: string, programId: string): Promise<ProgramViewData> {
    const source = await this.prisma.program.findFirst({
      where: { id: programId, userId },
      select: { name: true, goal: true, notes: true, source: true, autonomy: true, gymId: true, intake: true, rationale: true },
    });
    if (!source) throw programNotFound();
    const rows = await loadProgramRows(this.prisma, programId);

    const suffix = ' (copy)';
    const result = await this.createWithTree({
      userId,
      header: {
        name: `${source.name.slice(0, PLAN_LIMITS.nameMax - suffix.length)}${suffix}`,
        goal: source.goal as ProgramGoal,
        notes: source.notes,
        source: source.source as ProgramSource,
        autonomy: source.autonomy as ProgramAutonomy,
        gymId: source.gymId,
        intake: (source.intake ?? null) as Prisma.InputJsonValue | null,
        rationale: source.rationale,
      },
      tree: stripIds(liveTreeOf(rows)),
      origin: 'duplicate',
      actor: 'user',
      summary: `Duplicated from "${source.name}"`.slice(0, CHANGE_SUMMARY_MAX),
    });
    return this.get(userId, result.programId);
  }

  /** Deletes a program nothing was logged against; otherwise 409 (archive it instead). */
  async remove(userId: string, programId: string): Promise<void> {
    await this.assertOwned(userId, programId);
    if (await programHasLoggedHistory(this.prisma, programId)) {
      throw conflict(PROGRAM_REASONS.HAS_HISTORY, 'Workouts were logged from this plan; archive it instead.');
    }
    const deleted = await this.prisma.program.deleteMany({ where: { id: programId, userId } });
    if (deleted.count === 0) throw programNotFound();
  }

  /** Marks `upToId` and every older entry as seen. */
  async markSeen(userId: string, programId: string, upToId: string): Promise<{ updated: number }> {
    await this.assertOwned(userId, programId);
    const entry = await this.prisma.programChangeLog.findFirst({
      where: { id: upToId, programId },
      select: { createdAt: true },
    });
    if (!entry) throw new NotFoundException('Change log entry not found');
    const result = await this.prisma.programChangeLog.updateMany({
      where: { programId, seenAt: null, createdAt: { lte: entry.createdAt } },
      data: { seenAt: new Date() },
    });
    return { updated: result.count };
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private async assertOwned(userId: string, programId: string): Promise<void> {
    const program = await this.prisma.program.findFirst({ where: { id: programId, userId }, select: { id: true } });
    if (!program) throw programNotFound();
  }

  private assertTransition(action: keyof typeof PROGRAM_TRANSITIONS, status: ProgramStatus): void {
    if (!PROGRAM_TRANSITIONS[action].includes(status)) {
      throw conflict(PROGRAM_REASONS.ILLEGAL_TRANSITION, `A ${status} plan cannot be ${action === 'activate' ? 'activated' : action === 'pause' ? 'paused' : 'archived'}.`, {
        status,
      });
    }
  }

  private async transition(
    userId: string,
    programId: string,
    action: 'pause' | 'archive',
    target: ProgramStatus,
  ): Promise<ProgramViewData> {
    const updated = await this.prisma.program.updateMany({
      where: { id: programId, userId, status: { in: [...PROGRAM_TRANSITIONS[action]] } },
      data: { status: target },
    });
    if (updated.count === 0) {
      const program = await this.prisma.program.findFirst({ where: { id: programId, userId }, select: { status: true } });
      if (!program) throw programNotFound();
      this.assertTransition(action, program.status as ProgramStatus);
    }
    return this.get(userId, programId);
  }
}
