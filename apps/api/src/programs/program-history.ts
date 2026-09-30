import type { Prisma, PrismaClient } from '@prisma/client';

// =============================================================================
// Logged history of planned workouts (E5.1, E5.7)
// =============================================================================
//
// A planned workout "has history" when something the user logged points at
// it: a `Workout` whose `program_workout_id` references it, or a
// `program_sessions` row (the planned-session link with its snapshot). Such a
// row is archived, never deleted, so the link from logged sessions and
// adherence survive. A later story that adds another link extends these two
// helpers, and every caller follows.
// =============================================================================

type Db = PrismaClient | Prisma.TransactionClient;

/** The subset of `programWorkoutIds` that logged workouts or planned sessions point at. */
export async function hasLoggedHistory(db: Db, programWorkoutIds: readonly string[]): Promise<Set<string>> {
  if (programWorkoutIds.length === 0) return new Set();
  const ids = [...programWorkoutIds];
  const [workouts, sessions] = await Promise.all([
    db.workout.findMany({
      where: { programWorkoutId: { in: ids } },
      select: { programWorkoutId: true },
      distinct: ['programWorkoutId'],
    }),
    db.programSession.findMany({
      where: { programWorkoutId: { in: ids } },
      select: { programWorkoutId: true },
      distinct: ['programWorkoutId'],
    }),
  ]);
  return new Set(
    [...workouts, ...sessions].map((row) => row.programWorkoutId).filter((id): id is string => id !== null),
  );
}

/** Whether any logged workout or planned session points into the program (archived rows included). */
export async function programHasLoggedHistory(db: Db, programId: string): Promise<boolean> {
  const [workout, session] = await Promise.all([
    db.workout.findFirst({
      where: { programWorkout: { week: { programId } } },
      select: { id: true },
    }),
    db.programSession.findFirst({ where: { programId }, select: { id: true } }),
  ]);
  return Boolean(workout) || Boolean(session);
}
