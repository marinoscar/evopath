import type { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service';

// Audit rows for training runs (`audit_events`). The meta carries ids,
// statuses, codes, token totals and role names only: never the request, a
// note, a prompt or model output. A failed audit write is logged, not raised.

export const TRAINING_RUN_AUDIT_ACTIONS = {
  START: 'training_run:start',
  CANCEL: 'training_run:cancel',
  RESUME: 'training_run:resume',
  DECISION: 'training_run:decision',
  COMPLETE: 'training_run:complete',
} as const;

export type TrainingRunAuditAction = (typeof TRAINING_RUN_AUDIT_ACTIONS)[keyof typeof TRAINING_RUN_AUDIT_ACTIONS];

export interface TrainingRunAuditMeta {
  runId: string;
  kind: string;
  status: string;
  errorCode?: string | null;
  tokens?: number;
  roles?: string[];
  decision?: 'approve' | 'reject';
}

export async function auditTrainingRun(
  prisma: Pick<PrismaService, 'auditEvent'>,
  logger: Logger,
  actorUserId: string | null,
  action: TrainingRunAuditAction,
  meta: TrainingRunAuditMeta,
): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        actorUserId,
        action,
        targetType: 'training_run',
        targetId: meta.runId,
        meta: meta as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    logger.warn(
      `Could not audit ${action} for training run ${meta.runId}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}
