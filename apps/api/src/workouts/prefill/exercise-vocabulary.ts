import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// The exercise library as a prompt vocabulary (E4.5)
// =============================================================================
//
// The seeded library (`owner_user_id` null, `status` active): slug, name and
// aliases, in name order. A user's custom exercises are deliberately NOT sent
// to the model: they are personal data, and a custom name is resolved on
// apply instead (an `other` item named like one of the caller's custom
// exercises reuses it).
//
// Read with Prisma directly, not through `ExercisesService`: `ExercisesModule`
// imports `WorkoutsModule`, so this module must never import it back.
// =============================================================================

export interface ExerciseVocabularyEntry {
  slug: string;
  name: string;
  aliases: string[];
}

export interface ExerciseVocabulary {
  exercises: ExerciseVocabularyEntry[];
}

/** The library entry for a slug, or null. */
export function resolveLibraryExercise(vocab: ExerciseVocabulary, slug: string): ExerciseVocabularyEntry | null {
  return vocab.exercises.find((exercise) => exercise.slug === slug) ?? null;
}

@Injectable()
export class ExerciseVocabularyService {
  constructor(private readonly prisma: PrismaService) {}

  async load(): Promise<ExerciseVocabulary> {
    const rows = await this.prisma.exercise.findMany({
      where: { ownerUserId: null, status: 'active' },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { slug: true, name: true, aliases: true },
    });

    return { exercises: rows.map((row) => ({ slug: row.slug, name: row.name, aliases: [...row.aliases] })) };
  }
}
