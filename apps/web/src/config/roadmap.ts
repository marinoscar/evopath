/**
 * Single source for "which epic delivers which feature area".
 *
 * The numbering is a product-planning assumption. When an epic is renumbered,
 * change it here only; every "Coming in E<n>" label derives from this map.
 */
export type EpicId = 'E2' | 'E3' | 'E4' | 'E5';

export const ROADMAP = {
  health: 'E2', // health profile, body metrics, readiness check-in
  gyms: 'E3', // gyms, equipment, photo intake foundation
  programs: 'E5', // programs and Today's workout
} as const satisfies Record<string, EpicId>;

export type RoadmapArea = keyof typeof ROADMAP;

export function comingInLabel(area: RoadmapArea): string {
  return `Coming in ${ROADMAP[area]}`;
}
