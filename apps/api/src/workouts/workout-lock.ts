import { Prisma } from '@prisma/client';

import { workoutNotFound } from './workout-mapper';

/**
 * Locks the caller's workout row (`SELECT ... FOR UPDATE`) for the rest of the
 * transaction, or throws 404 when `workoutId` is not the caller's.
 *
 * Every write to a workout's exercises or sets takes this lock first, so the
 * per-workout limits (30 exercises, 40 sets per exercise), `setNumber`
 * allocation and the dense renumbering of positions and set numbers are
 * serialized per workout: two concurrent "add set" taps get 1 and 2, never a
 * duplicate or a gap.
 */
export async function lockOwnedWorkout(
  tx: Prisma.TransactionClient,
  userId: string,
  workoutId: string,
): Promise<{ id: string; status: string; startedAt: Date }> {
  const rows = await tx.$queryRaw<Array<{ id: string; status: string; started_at: Date }>>(
    Prisma.sql`SELECT "id", "status", "started_at" FROM "workouts"
               WHERE "id" = ${workoutId}::uuid AND "user_id" = ${userId}::uuid
               FOR UPDATE`,
  );

  const row = rows[0];
  if (!row) {
    throw workoutNotFound();
  }

  return { id: row.id, status: row.status, startedAt: row.started_at };
}
