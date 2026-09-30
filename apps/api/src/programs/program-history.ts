import type { Prisma, PrismaClient } from '@prisma/client';

// =============================================================================
// Logged history of planned workouts (E5.1)
// =============================================================================
//
// A planned workout "has history" when something the user logged points at
// it: today a `Workout` whose `program_workout_id` references it. Such a row
// is archived, never deleted, so the link from logged sessions and adherence
// survive. Later stories that add another link (planned sessions) extend these
// two helpers, and every caller follows.
// =============================================================================

type Db = PrismaClient | Prisma.TransactionClient;

/** The subset of `programWorkoutIds` that logged workouts point at. */
export async function hasLoggedHistory(db: Db, programWorkoutIds: readonly string[]): Promise<Set<string>> {
  if (programWorkoutIds.length === 0) return new Set();
  const rows = await db.workout.findMany({
    where: { programWorkoutId: { in: [...programWorkoutIds] } },
    select: { programWorkoutId: true },
    distinct: ['programWorkoutId'],
  });
  return new Set(rows.map((row) => row.programWorkoutId).filter((id): id is string => id !== null));
}

/** Whether any logged workout points into the program (any workout, archived or not). */
export async function programHasLoggedHistory(db: Db, programId: string): Promise<boolean> {
  const hit = await db.workout.findFirst({
    where: { programWorkout: { week: { programId } } },
    select: { id: true },
  });
  return hit !== null;
}
