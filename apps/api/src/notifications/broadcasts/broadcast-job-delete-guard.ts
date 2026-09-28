// =============================================================================
// Broadcast jobs: who may delete one, and when (issue #480)
// =============================================================================
//
// A broadcast's `scheduled` -> `sending` -> `sent` progress lives in
// `notification_broadcasts`, but the only thing that ADVANCES it is a job:
// the pending `admin.broadcast.start` row (sitting in the queue until its
// `scheduledFor`) advances a `scheduled` broadcast, and the pending
// `admin.broadcast.chunk` row advances a `sending` one. Delete either from the
// admin Jobs page and the broadcast is stranded — nothing is left to move it,
// and because a delete is not a settlement, no `job.settled` fires and #459's
// failure listener never flips it to `failed`, so Resume (which needs
// `failed`) cannot rescue it either. The broadcast's own Cancel action is the
// correct tool; this guard says so instead of letting the delete through.
//
// ONE FUNCTION, BOTH HANDLERS, for the same reason `broadcast-audience.ts`
// exports one predicate: the start and chunk handlers must give the SAME
// answer about the same broadcast, and two hand-written copies agree only on
// the day they are written.
//
// BOTH `scheduled` AND `sending` ARE REFUSED FOR BOTH TYPES, deliberately
// broader than "start guards scheduled, chunk guards sending". A pending start
// job beside a `sending` broadcast is not always redundant — since #469 it is
// how an interrupted hand-off is resumed — and there is no cheap, race-free
// way to prove from here that a given pending row is the redundant one. Cancel
// is always available for an active broadcast, so over-refusing costs an
// operator one different click; under-refusing costs a stranded broadcast.
// =============================================================================

import { Job } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { BROADCAST_SUBJECT_TYPE } from './broadcast-audience';

/** Broadcast statuses a still-runnable job of either broadcast type is load-bearing for. */
const ACTIVE_BROADCAST_STATUSES: ReadonlySet<string> = new Set(['scheduled', 'sending']);

/** Job statuses that are history: deleting such a row never strands anything. */
const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed']);

/**
 * The `JobHandler.canDelete` answer shared by both broadcast job handlers.
 *
 * Returns a refusal reason when `job` is still runnable (not `succeeded` /
 * `failed`) AND names an existing broadcast that is `scheduled` or `sending`;
 * otherwise `null`. A job whose subject is not a broadcast, or names one that
 * no longer exists or has reached a terminal status, may be deleted freely.
 *
 * One indexed primary-key read, no writes — per the `canDelete` contract. A
 * database error propagates; the admin service turns it into a refusal.
 */
export async function broadcastJobDeleteRefusal(
  prisma: PrismaService,
  job: Pick<Job, 'status' | 'subjectType' | 'subjectId'>
): Promise<string | null> {
  if (TERMINAL_JOB_STATUSES.has(job.status)) return null;
  if (job.subjectType !== BROADCAST_SUBJECT_TYPE || !job.subjectId) return null;

  const broadcast = await prisma.notificationBroadcast.findUnique({
    where: { id: job.subjectId },
    select: { id: true, status: true },
  });

  if (!broadcast || !ACTIVE_BROADCAST_STATUSES.has(broadcast.status)) return null;

  return (
    `Broadcast ${broadcast.id} is '${broadcast.status}'; deleting this job would leave it ` +
    `stuck with nothing to advance it. Cancel the broadcast instead of deleting its job.`
  );
}
