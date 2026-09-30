import type { AuthedApi } from './api.helper';

/**
 * Health Profile helpers for the workout specs (E4.7).
 *
 * Workouts read in the profile's unit system (`imperial` -> lb, `metric` ->
 * kg) while the API stores kilograms. Every workout test calls `setUnits`
 * first, so the lb/kg it types and asserts do not depend on the default.
 */

export type UnitSystem = 'imperial' | 'metric';

interface HealthProfileBody {
  dateOfBirth: string | null;
  sexAtBirth: string | null;
  heightMm: number | null;
  unitSystem: UnitSystem;
  timeZone: string | null;
  bio: string | null;
}

/**
 * `PUT /api/health-profile` (E2.1) is a full replace, so the stored fields are
 * read first and sent back unchanged; only `unitSystem` moves.
 */
export async function setUnits(api: AuthedApi, unitSystem: UnitSystem): Promise<void> {
  const current = await api.get<HealthProfileBody>('/api/health-profile');
  await api.put('/api/health-profile', {
    dateOfBirth: current.dateOfBirth,
    sexAtBirth: current.sexAtBirth,
    heightMm: current.heightMm,
    timeZone: current.timeZone,
    bio: current.bio,
    unitSystem,
  });
}
