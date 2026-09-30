import { randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { planTreeSchema, type PlanTree } from '../../programs/contracts/plan-tree.contract';
import type { ApplyChangeInput, CreateWithTreeInput } from '../../programs/programs.service';
import type { NotificationsPort, ProgramsPort, RunProgramVersion } from '../graph/node-context';

// =============================================================================
// In-memory stand-ins for the `programs` and `notifications` node ports
// =============================================================================
//
// The programs fake follows the chokepoint's contract where the nodes can
// observe it: the tree must parse, a revise with a stale `expectedVersion` is
// a 409 `TRAINING_STALE_PLAN` that changes nothing, another user's program is
// a 404. Every write and every notification lands in one ordered `log`, so a
// spec can assert that `notify` came after the write returned. The real
// transaction is proven by the Postgres spec.
// =============================================================================

export interface FakeVersion {
  versionNumber: number;
  origin: string;
  runId: string | null;
  rationale: string | null;
  evidence: unknown[];
  meta: Record<string, unknown>;
  tree: PlanTree;
}

export interface FakeProgram {
  id: string;
  userId: string;
  name: string;
  goal: string;
  status: 'draft';
  source: string;
  autonomy: string;
  gymId: string | null;
  intake: unknown;
  rationale: string | null;
  currentVersion: number;
  versions: FakeVersion[];
  changeLog: Array<{ id: string; kind: string; actor: string; runId: string | null; summary: string; citations: unknown[]; toVersion: number }>;
}

export function createFakeProgramsPort() {
  const programs = new Map<string, FakeProgram>();
  const log: string[] = [];
  const notifications: Array<{ eventKey: string; userId: string; data: unknown }> = [];

  const parse = (tree: unknown): PlanTree => {
    const parsed = planTreeSchema.safeParse(tree);
    if (!parsed.success) throw new BadRequestException({ message: 'The plan is not valid', details: { reason: 'INVALID_PLAN' } });
    return parsed.data;
  };

  const port: ProgramsPort = {
    async createWithTree(input: CreateWithTreeInput) {
      const tree = parse(input.tree);
      const id = randomUUID();
      const changeLogId = randomUUID();
      programs.set(id, {
        id,
        userId: input.userId,
        name: input.header.name,
        goal: input.header.goal,
        status: 'draft',
        source: input.header.source,
        autonomy: input.header.autonomy ?? 'autonomous',
        gymId: input.header.gymId ?? null,
        intake: input.header.intake ?? null,
        rationale: input.header.rationale ?? null,
        currentVersion: 1,
        versions: [
          { versionNumber: 1, origin: input.origin, runId: input.runId ?? null, rationale: input.rationale ?? null, evidence: input.evidence ?? [], meta: input.meta ?? {}, tree },
        ],
        changeLog: [
          { id: changeLogId, kind: 'created', actor: input.actor, runId: input.runId ?? null, summary: input.summary, citations: input.citations ?? [], toVersion: 1 },
        ],
      });
      log.push(`create:${id}`);
      return { programId: id, versionNumber: 1, changeLogId, warnings: [] };
    },

    async applyChange(input: ApplyChangeInput) {
      const program = programs.get(input.programId);
      if (!program || program.userId !== input.userId) throw new NotFoundException('Program not found');
      if (program.currentVersion !== input.expectedVersion) {
        throw new ConflictException({
          message: 'The plan changed since you loaded it.',
          details: { reason: 'TRAINING_STALE_PLAN', currentVersion: program.currentVersion },
        });
      }
      const current = program.versions.at(-1)!;
      const tree = parse(input.mutate(structuredClone(current.tree)));
      const versionNumber = program.currentVersion + 1;
      const changeLogId = randomUUID();
      program.currentVersion = versionNumber;
      if (input.planRationale !== undefined) program.rationale = input.planRationale;
      program.versions.push({
        versionNumber,
        origin: input.origin,
        runId: input.runId ?? null,
        rationale: input.rationale ?? null,
        evidence: input.evidence ?? [],
        meta: input.meta ?? {},
        tree,
      });
      program.changeLog.push({ id: changeLogId, kind: input.kind, actor: input.actor, runId: input.runId ?? null, summary: input.summary, citations: input.citations ?? [], toVersion: versionNumber });
      log.push(`apply:${program.id}:${versionNumber}`);
      return { versionNumber, changeLogId, warnings: [] };
    },

    async findRunVersion(userId: string, runId: string): Promise<RunProgramVersion | null> {
      for (const program of programs.values()) {
        if (program.userId !== userId) continue;
        const version = [...program.versions].reverse().find((v) => v.runId === runId);
        if (version) {
          const entry = program.changeLog.find((c) => c.runId === runId && c.toVersion === version.versionNumber);
          return { programId: program.id, programName: program.name, versionNumber: version.versionNumber, changeLogId: entry?.id ?? null };
        }
      }
      return null;
    },

    async recentAiEvidence(userId: string, programId: string): Promise<unknown[]> {
      const program = programs.get(programId);
      if (!program || program.userId !== userId) return [];
      return [...program.versions]
        .reverse()
        .filter((v) => v.origin === 'ai_create' || v.origin === 'ai_adapt')
        .slice(0, 5)
        .map((v) => v.evidence);
    },
  };

  const notify: NotificationsPort = {
    notify(eventKey, userId, data) {
      notifications.push({ eventKey, userId, data });
      log.push(`notify:${eventKey}`);
    },
  };

  /** Seeds a program the user owns, at `currentVersion`, with `tree` and optional stored evidence. */
  function addProgram(userId: string, tree: PlanTree, opts: { currentVersion?: number; evidence?: unknown[]; origin?: string; name?: string } = {}): FakeProgram {
    const id = randomUUID();
    const currentVersion = opts.currentVersion ?? 1;
    const program: FakeProgram = {
      id,
      userId,
      name: opts.name ?? 'Existing plan',
      goal: 'hypertrophy',
      status: 'draft',
      source: 'ai',
      autonomy: 'autonomous',
      gymId: null,
      intake: null,
      rationale: null,
      currentVersion,
      versions: [{ versionNumber: currentVersion, origin: opts.origin ?? 'ai_create', runId: null, rationale: null, evidence: opts.evidence ?? [], meta: {}, tree }],
      changeLog: [],
    };
    programs.set(id, program);
    return program;
  }

  return { port, notify, programs, notifications, log, addProgram };
}

export type FakeProgramsPort = ReturnType<typeof createFakeProgramsPort>;
