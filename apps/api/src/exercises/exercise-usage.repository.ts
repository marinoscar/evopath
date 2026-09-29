import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

// =============================================================================
// ExerciseUsageRepository — what still references an exercise (E4.1)
// =============================================================================
//
// `DELETE /api/exercises/:id` refuses with 409 `EXERCISE_IN_USE` while this
// reports any reference. Keeping the question behind one method lets the
// delete path exist before the tables that reference exercises do.
// =============================================================================

@Injectable()
export class ExerciseUsageRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * How many logged workout exercises reference `exerciseId`.
   *
   * No table references exercises yet, so the answer is always 0. Workout
   * logging (E4.2) adds `workout_exercises` and makes this count its rows;
   * `prisma` is injected now so that change is local to this method.
   */
  async countWorkoutReferences(_exerciseId: string): Promise<number> {
    return 0;
  }
}
