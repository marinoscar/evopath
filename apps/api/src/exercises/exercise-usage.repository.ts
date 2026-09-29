import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

// =============================================================================
// ExerciseUsageRepository — what still references an exercise (E4.1)
// =============================================================================
//
// `DELETE /api/exercises/:id` refuses with 409 `EXERCISE_IN_USE` while this
// reports any reference; the `workout_exercises` foreign key (Restrict)
// backs it up against a concurrent insert.
// =============================================================================

@Injectable()
export class ExerciseUsageRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** How many logged workout exercises (`workout_exercises` rows, any user) reference `exerciseId`. */
  async countWorkoutReferences(exerciseId: string): Promise<number> {
    return this.prisma.workoutExercise.count({ where: { exerciseId } });
  }
}
