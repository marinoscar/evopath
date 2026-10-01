import { labUnitsOf, type LabUnits } from '../utils/labUnits';
import { useHealthProfile } from './useHealthProfile';

export interface UseLabUnitsReturn {
  /** The profile's preference; `conventional` while loading or when it cannot be read. */
  labUnits: LabUnits;
  isLoading: boolean;
}

/**
 * Issue #234. The unit system blood work is shown in, read from the health
 * profile (`GET /api/health-profile`). A load failure is not an error here:
 * the views fall back to US conventional units, their output before #234.
 */
export function useLabUnits(): UseLabUnitsReturn {
  const { profile, isLoading } = useHealthProfile();
  return { labUnits: labUnitsOf(profile), isLoading };
}
