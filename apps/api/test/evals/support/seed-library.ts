import { CAPABILITY_CATALOG, EQUIPMENT_CATALOG, EXERCISE_CATALOG } from '../../../prisma/seed-data';
import { derivedUuid } from '../../../src/training-agents/compile/compile-plan';
import { implementOf, isCompoundPattern, type ImplementOption } from '../../../src/training-agents/context/implement';
import type { LibraryExercise } from '../../../src/training-agents/context/planner-context.contract';
import type { PlannerContextSource } from '../../../src/training-agents/context/build-planner-context';

// =============================================================================
// The E4 seed catalog as the planner's library (TEST-ONLY)
// =============================================================================
//
// Persona exercises and gyms are named by SEED slug. This turns the seed's
// exercise, equipment and capability catalogs into the `LibraryExercise` rows
// and gym inventory the context builder and guardrails read, with ids derived
// from the slug (stable, so a report can be compared run to run). A slug that
// is not in the seed throws: a renamed or removed seed row fails fast.
// =============================================================================

const idOf = (kind: string, slug: string) => derivedUuid(`eval-seed:${kind}`, slug);

const equipmentBySlug = new Map(EQUIPMENT_CATALOG.map((e) => [e.slug, e]));
const capabilitySlugs = new Set(CAPABILITY_CATALOG.map((c) => c.slug));

function optionsOf(kind: 'equipment' | 'capability', slugs: string[]): ImplementOption[] {
  return slugs.map((slug) => {
    if (kind === 'equipment') {
      const equipment = equipmentBySlug.get(slug);
      if (!equipment) throw new Error(`Seed exercise names unknown equipment "${slug}"`);
      return { kind: 'equipment', slug, category: equipment.category };
    }
    if (!capabilitySlugs.has(slug)) throw new Error(`Seed exercise names unknown capability "${slug}"`);
    return {
      kind: 'capability',
      slug,
      providers: EQUIPMENT_CATALOG.filter((e) => e.capabilities.includes(slug)).map((e) => ({ slug: e.slug, category: e.category })),
    };
  });
}

/** Every seeded exercise as a library row. */
export const SEED_LIBRARY: LibraryExercise[] = EXERCISE_CATALOG.map((seed) => ({
  id: idOf('exercise', seed.slug),
  key: seed.slug,
  name: seed.name,
  primaryMuscles: [...seed.primaryMuscles],
  secondaryMuscles: [...seed.secondaryMuscles],
  movementPattern: seed.movementPattern,
  trackingMode: seed.trackingMode,
  isCompound: isCompoundPattern(seed.movementPattern),
  isUnilateral: seed.isUnilateral,
  isBodyweight: seed.isBodyweight,
  implement: implementOf({ slug: seed.slug, isBodyweight: seed.isBodyweight, firstGroup: seed.requirements[0] ? optionsOf(seed.requirements[0].kind, seed.requirements[0].slugs) : [] }),
  requirements: seed.requirements.flatMap((group, groupIndex) =>
    group.slugs.map((slug) => ({
      groupIndex,
      equipmentTypeId: group.kind === 'equipment' ? idOf('equipment', slug) : null,
      capabilityId: group.kind === 'capability' ? idOf('capability', slug) : null,
    })),
  ),
}));

export const SEED_LIBRARY_BY_KEY: ReadonlyMap<string, LibraryExercise> = new Map(SEED_LIBRARY.map((e) => [e.key, e]));

/** The library row for a seed slug; throws on a slug the seed does not hold. */
export function seedExercise(slug: string): LibraryExercise {
  const found = SEED_LIBRARY_BY_KEY.get(slug);
  if (!found) throw new Error(`Exercise slug "${slug}" is not in the seed catalog`);
  return found;
}

/** A gym from equipment slugs: the equipment plus every capability those types provide. */
export function seedGym(equipmentSlugs: readonly string[]): NonNullable<PlannerContextSource['gym']> {
  const capabilities = new Set<string>();
  const equipment = equipmentSlugs.map((slug) => {
    const seed = equipmentBySlug.get(slug);
    if (!seed) throw new Error(`Equipment slug "${slug}" is not in the seed catalog`);
    for (const capability of seed.capabilities) capabilities.add(capability);
    return { equipmentTypeId: idOf('equipment', slug), slug, category: seed.category };
  });
  return { equipment, capabilities: [...capabilities].sort().map((slug) => ({ id: idOf('capability', slug), slug })) };
}
