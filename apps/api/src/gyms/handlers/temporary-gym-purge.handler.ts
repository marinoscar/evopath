// =============================================================================
// `gyms.temporary.purge`: deletes abandoned temporary gyms (E6.2)
// =============================================================================
//
// Enqueued once a day by `TemporaryGymPurgeTask`, which only enqueues
// (CLAUDE.md, "Every Long-Running Activity Is a Queue Job"). The hotel flow
// creates a temporary gym before it scans the room; a gym the user never saved
// and no longer uses would otherwise stay in their list (50-gym cap) with its
// photos in object storage.
//
// A temporary gym is purgeable when ALL hold:
//   - `is_temporary` and `updated_at` older than TEMPORARY_GYM_RETENTION_DAYS
//     (a code constant: no env var, no setting);
//   - no workout references it (any status);
//   - no workout adaptation in `queued`, `running` or `ready` references it;
//   - no draft, active or paused program references it (a plan built for the
//     trip; archived and completed plans do not hold it: the FK is SET NULL);
//   - no photo intake targeting it (`subject_type = 'gym'`) is `scanning`.
//
// REFERENCE-SAFE. Candidates are read in batches of 200 (by id, so a gym that
// is skipped is never read twice in one run), then each is deleted through
// `GymsService.removeTemporary`, the `DELETE /api/gyms/{id}` path: ONE
// transaction per gym that re-applies every condition above in the delete's own
// WHERE (plus the intake check), so a gym referenced after it was selected is
// left alone and retried the next day; then its photos' storage objects are
// deleted through `ObjectsService` (objects another row still holds are kept).
// Never raw SQL; never a permanent gym (`isTemporary: true` is always in the
// delete's WHERE).
//
// SERVER-ONLY (no `nodeResultSchema`/`persistNodeResult`), deliberately: it
// writes as it goes (one delete per gym, each followed by storage deletes),
// reads several tables mid-computation to decide, and deleting objects from
// this deployment's storage provider is a privilege a remote machine must never
// hold (CLAUDE.md queue rule 2). Takes the global default execution profile.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job, Prisma } from '@prisma/client';

import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import {
  TEMPORARY_GYM_LIVE_ADAPTATION_STATUSES,
  TEMPORARY_GYM_LIVE_INTAKE_STATUSES,
  TEMPORARY_GYM_PURGE_BATCH_SIZE,
  TEMPORARY_GYM_PURGE_JOB_TYPE,
  TEMPORARY_GYM_PURGE_MAX_BATCHES,
  TEMPORARY_GYM_RETENTION_MS,
} from '../gyms.constants';
import { GymsService, type TemporaryGymRemoval } from '../gyms.service';
import { GYM_INTAKE_SUBJECT_TYPE } from '../intake/gym-equipment.intake-kind';

/** Program statuses whose plan still points at its gym. */
const HOLDING_PROGRAM_STATUSES = ['draft', 'active', 'paused'] as const;

/** The row conditions a temporary gym must meet to be purged (the delete's WHERE re-applies them). */
export function purgeableTemporaryGymWhere(cutoff: Date): Prisma.GymWhereInput {
  return {
    isTemporary: true,
    updatedAt: { lt: cutoff },
    workouts: { none: {} },
    workoutAdaptations: { none: { status: { in: [...TEMPORARY_GYM_LIVE_ADAPTATION_STATUSES] } } },
    programs: { none: { status: { in: [...HOLDING_PROGRAM_STATUSES] } } },
  };
}

/** True while a photo intake on this gym is being analysed (not a relation, so checked apart). */
export async function isHeldByScanningIntake(tx: Prisma.TransactionClient, gymId: string): Promise<boolean> {
  const scanning = await tx.photoIntake.count({
    where: {
      subjectType: GYM_INTAKE_SUBJECT_TYPE,
      subjectId: gymId,
      status: { in: [...TEMPORARY_GYM_LIVE_INTAKE_STATUSES] },
    },
  });
  return scanning > 0;
}

export interface TemporaryGymPurgeResult {
  deleted: number;
  /** Selected but referenced (or changed) by the time its transaction ran. */
  skipped: number;
  failed: number;
}

@Injectable()
export class TemporaryGymPurgeHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(TemporaryGymPurgeHandler.name);

  /** PERMANENT once jobs of this type exist. */
  readonly type = TEMPORARY_GYM_PURGE_JOB_TYPE;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly gyms: GymsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** No payload. Throws when any gym could not be deleted, so the run is visible and retried (idempotent). */
  async process(job: Job): Promise<void> {
    const result = await this.purge(new Date(), job.id);

    if (result.failed > 0) {
      throw new Error(`Temporary gym purge could not delete ${result.failed} gym(s); see the log`);
    }
  }

  async purge(now: Date, jobId = 'direct'): Promise<TemporaryGymPurgeResult> {
    const where = purgeableTemporaryGymWhere(new Date(now.getTime() - TEMPORARY_GYM_RETENTION_MS));
    const removal: TemporaryGymRemoval = { where, isHeld: isHeldByScanningIntake };
    const result: TemporaryGymPurgeResult = { deleted: 0, skipped: 0, failed: 0 };
    let cursor: string | null = null;
    let batches = 0;

    for (; batches < TEMPORARY_GYM_PURGE_MAX_BATCHES; batches += 1) {
      const rows: Array<{ id: string; userId: string }> = await this.prisma.gym.findMany({
        where: cursor ? { ...where, id: { gt: cursor } } : where,
        select: { id: true, userId: true },
        orderBy: { id: 'asc' },
        take: TEMPORARY_GYM_PURGE_BATCH_SIZE,
      });
      if (rows.length === 0) break;

      for (const row of rows) {
        try {
          if (await this.gyms.removeTemporary(row.userId, row.id, removal)) {
            result.deleted += 1;
          } else {
            result.skipped += 1;
          }
        } catch (error) {
          result.failed += 1;
          this.logger.warn(
            `Temporary gym purge could not delete gym ${row.id}: ` +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }

      cursor = rows[rows.length - 1].id;
      if (rows.length < TEMPORARY_GYM_PURGE_BATCH_SIZE) {
        batches += 1;
        break;
      }
    }

    if (batches >= TEMPORARY_GYM_PURGE_MAX_BATCHES) {
      this.logger.warn(
        `Temporary gym purge stopped at its ${TEMPORARY_GYM_PURGE_MAX_BATCHES}-batch safety limit; the next run continues.`,
      );
    }

    this.logger.log(
      `Temporary gym purge removed ${result.deleted} gym(s), skipped ${result.skipped}, failed ${result.failed} ` +
        `in ${batches} batch(es) (job ${jobId})`,
    );
    return result;
  }
}
