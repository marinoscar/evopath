import { useEffect } from 'react';
import { weightUnitFor, type WeightUnit } from '../utils/units';
import { useHealthProfile } from './useHealthProfile';

/**
 * E4.3. The weight unit workouts read and are typed in: the Health Profile
 * `unitSystem` (`metric` -> kg, `imperial` -> lb). Kilograms while the profile
 * loads or when it cannot be read.
 *
 * The profile is read again when the window regains focus, so a unit change
 * made on `/settings/health-profile` (another tab, or before returning here)
 * re-renders the values without saving anything.
 */
export function useWeightUnit(): WeightUnit {
  const { profile, refresh } = useHealthProfile();

  useEffect(() => {
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  return weightUnitFor(profile?.unitSystem);
}
