import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import {
  type ApplyChangeInput,
  type ApplyChangeResult,
  type CreateWithTreeInput,
  type CreateWithTreeResult,
  ProgramsService,
} from '../../programs/programs.service';
import type { ProgramsPort, RunProgramVersion } from '../graph/node-context';

/** How many recent AI versions a revise run looks through for a reusable brief. */
export const RECENT_AI_VERSIONS = 5;

/**
 * The `programs` node port: writes delegate to the `ProgramsService`
 * chokepoint (the only writer of plan content); the two reads are
 * owner-scoped and read-only.
 */
@Injectable()
export class TrainingProgramsPort implements ProgramsPort {
  constructor(
    private readonly programs: ProgramsService,
    private readonly prisma: PrismaService,
  ) {}

  createWithTree(input: CreateWithTreeInput): Promise<CreateWithTreeResult> {
    return this.programs.createWithTree(input);
  }

  applyChange(input: ApplyChangeInput): Promise<ApplyChangeResult> {
    return this.programs.applyChange(input);
  }

  async findRunVersion(userId: string, runId: string): Promise<RunProgramVersion | null> {
    const version = await this.prisma.programVersion.findFirst({
      where: { runId, program: { userId } },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true, programId: true, program: { select: { name: true } } },
    });
    if (!version) return null;

    const log = await this.prisma.programChangeLog.findFirst({
      where: { programId: version.programId, runId, toVersion: version.versionNumber },
      select: { id: true },
    });
    return { programId: version.programId, programName: version.program.name, versionNumber: version.versionNumber, changeLogId: log?.id ?? null };
  }

  async recentAiEvidence(userId: string, programId: string): Promise<unknown[]> {
    const versions = await this.prisma.programVersion.findMany({
      where: { programId, program: { userId }, origin: { in: ['ai_create', 'ai_adapt'] } },
      orderBy: { versionNumber: 'desc' },
      take: RECENT_AI_VERSIONS,
      select: { evidence: true },
    });
    return versions.map((version) => version.evidence);
  }
}
