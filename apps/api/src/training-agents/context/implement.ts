import type { ImplementClass } from './planner-context.contract';

// =============================================================================
// Which implement an exercise mainly uses (for the G2 substitution ladder and
// the G7 progression steps). Derived, deterministic, never stored.
// =============================================================================
//
// The library has no "implement" column; requirement groups name equipment
// types or capabilities. The FIRST requirement group is the exercise's main
// implement (the seed lists it first: `E:barbell + E:flat_bench`). Each
// option of that group votes a class (a capability option votes the classes
// of every equipment type providing it); the most votes wins, ties broken in
// `IMPLEMENT_PRIORITY` order. A bodyweight-flagged exercise, or one with no
// requirements, is `bodyweight`, except that a machine-assisted one
// (`assisted_*`) is `machine`.
// =============================================================================

export interface ImplementOptionEquipment {
  kind: 'equipment';
  slug: string;
  category: string;
}

export interface ImplementOptionCapability {
  kind: 'capability';
  slug: string;
  /** The equipment types that provide the capability. */
  providers: Array<{ slug: string; category: string }>;
}

export type ImplementOption = ImplementOptionEquipment | ImplementOptionCapability;

const IMPLEMENT_PRIORITY: readonly ImplementClass[] = ['barbell', 'dumbbell', 'machine', 'cable', 'band', 'bodyweight'];

const BARBELL_SLUGS = new Set(['barbell', 'ez_bar', 'landmine', 'trap_bar', 'weight_plates']);
const DUMBBELL_SLUGS = new Set(['dumbbells', 'adjustable_dumbbells', 'kettlebells']);

/** The class one equipment type votes for, or `null` for support gear (benches, racks, boxes). */
export function implementOfEquipment(slug: string, category: string): ImplementClass | null {
  if (BARBELL_SLUGS.has(slug)) return 'barbell';
  if (DUMBBELL_SLUGS.has(slug)) return 'dumbbell';
  if (slug.includes('band')) return 'band';
  switch (category) {
    case 'free_weights':
      return 'dumbbell';
    case 'plate_loaded':
    case 'selectorized':
    case 'cardio':
      return 'machine';
    case 'cable':
      return 'cable';
    case 'bodyweight':
      return 'bodyweight';
    default:
      return null;
  }
}

export function implementOf(args: {
  slug: string;
  isBodyweight: boolean;
  /** The options of the first requirement group; empty when the exercise needs nothing. */
  firstGroup: readonly ImplementOption[];
}): ImplementClass {
  if (args.slug.startsWith('assisted_')) return 'machine';
  if (args.isBodyweight || args.firstGroup.length === 0) return 'bodyweight';

  const votes = new Map<ImplementClass, number>();
  const vote = (cls: ImplementClass | null) => {
    if (cls) votes.set(cls, (votes.get(cls) ?? 0) + 1);
  };

  for (const option of args.firstGroup) {
    if (option.kind === 'equipment') {
      vote(implementOfEquipment(option.slug, option.category));
    } else {
      const classes = new Set(option.providers.map((p) => implementOfEquipment(p.slug, p.category)));
      for (const cls of classes) vote(cls);
    }
  }

  let best: ImplementClass = 'bodyweight';
  let bestVotes = 0;
  for (const cls of IMPLEMENT_PRIORITY) {
    const count = votes.get(cls) ?? 0;
    if (count > bestVotes) {
      best = cls;
      bestVotes = count;
    }
  }
  return best;
}

/** Patterns that count as multi-joint for `isCompound` (the library has no such column). */
export const COMPOUND_PATTERNS: ReadonlySet<string> = new Set([
  'squat',
  'hinge',
  'horizontal_push',
  'vertical_push',
  'horizontal_pull',
  'vertical_pull',
  'lunge',
  'carry',
]);

export function isCompoundPattern(movementPattern: string): boolean {
  return COMPOUND_PATTERNS.has(movementPattern);
}
