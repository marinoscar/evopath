import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// The equipment vocabulary: the seeded catalog and capabilities (E3.4)
// =============================================================================
//
// What the scan prompt offers the model (catalog slugs, names, aliases, and
// the capability list), and what the mapper and the `gym_equipment` intake
// kind derive a draft's `name`, `capabilitySlugs` and `targetMuscles` from.
//
// Only the SEEDED catalog (`owner_user_id IS NULL`) is vocabulary: a user's
// custom types are never shown to the model. The rows change only when the
// seed runs, so the loaded vocabulary is cached for a minute per process
// (`replaceAiDrafts` normalizes up to 40 items per scan).
// =============================================================================

export interface VocabularyCapability {
  slug: string;
  name: string;
  movementPattern: string;
  primaryMuscles: string[];
}

export interface VocabularyEquipmentType {
  slug: string;
  name: string;
  category: string;
  aliases: string[];
  /** Capability slugs, in capability `sortOrder`. */
  capabilitySlugs: string[];
}

export interface EquipmentVocabulary {
  /** Catalog types in catalog `sortOrder`. */
  equipmentTypes: VocabularyEquipmentType[];
  /** Every capability in `sortOrder`. */
  capabilities: VocabularyCapability[];
}

/** The muscle that means "the whole body"; dropped from a union that has others. */
export const FULL_BODY_MUSCLE = 'full_body';

const VOCABULARY_TTL_MS = 60_000;

/** A catalog type by slug, or undefined. */
export function catalogType(vocab: EquipmentVocabulary, slug: string): VocabularyEquipmentType | undefined {
  return vocab.equipmentTypes.find((type) => type.slug === slug);
}

/**
 * `slugs` kept to known capabilities, deduplicated, in capability
 * `sortOrder` (the order every derived list uses).
 */
export function knownCapabilitySlugs(vocab: EquipmentVocabulary, slugs: readonly string[]): string[] {
  const wanted = new Set(slugs);
  return vocab.capabilities.filter((capability) => wanted.has(capability.slug)).map((capability) => capability.slug);
}

/**
 * The union of the capabilities' `primaryMuscles`, in capability order,
 * without `full_body` when any other muscle is present.
 */
export function targetMusclesFor(vocab: EquipmentVocabulary, capabilitySlugs: readonly string[]): string[] {
  const wanted = new Set(capabilitySlugs);
  const muscles: string[] = [];

  for (const capability of vocab.capabilities) {
    if (!wanted.has(capability.slug)) continue;
    for (const muscle of capability.primaryMuscles) {
      if (!muscles.includes(muscle)) muscles.push(muscle);
    }
  }

  return muscles.length > 1 ? muscles.filter((muscle) => muscle !== FULL_BODY_MUSCLE) : muscles;
}

@Injectable()
export class EquipmentVocabularyService {
  private cached: { at: number; value: Promise<EquipmentVocabulary> } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** The seeded vocabulary, cached for a minute. */
  load(): Promise<EquipmentVocabulary> {
    const now = Date.now();

    if (this.cached && now - this.cached.at < VOCABULARY_TTL_MS) {
      return this.cached.value;
    }

    const value = this.read();
    this.cached = { at: now, value };
    // A failed read is not cached.
    value.catch(() => {
      if (this.cached?.value === value) this.cached = null;
    });

    return value;
  }

  invalidate(): void {
    this.cached = null;
  }

  private async read(): Promise<EquipmentVocabulary> {
    const [capabilities, types] = await Promise.all([
      this.prisma.capability.findMany({
        orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }],
        select: { slug: true, name: true, movementPattern: true, primaryMuscles: true },
      }),
      this.prisma.equipmentType.findMany({
        where: { ownerUserId: null },
        orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }],
        select: {
          slug: true,
          name: true,
          category: true,
          aliases: true,
          capabilities: { select: { capability: { select: { slug: true } } } },
        },
      }),
    ]);

    const vocab: EquipmentVocabulary = {
      capabilities: capabilities.map((c) => ({ ...c, primaryMuscles: [...c.primaryMuscles] })),
      equipmentTypes: [],
    };

    vocab.equipmentTypes = types.map((type) => ({
      slug: type.slug,
      name: type.name,
      category: type.category,
      aliases: [...type.aliases],
      capabilitySlugs: knownCapabilitySlugs(
        vocab,
        type.capabilities.map((link) => link.capability.slug),
      ),
    }));

    return vocab;
  }
}
