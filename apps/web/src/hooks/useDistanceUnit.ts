import { useWeightUnit } from './useWeightUnit';
import type { DistanceUnit } from '../utils/goalFormat';

/**
 * #268. The distance unit goals are shown and typed in, from the same Health
 * Profile `unitSystem` the weight unit follows: imperial (lb) -> miles,
 * metric (kg) -> kilometres. The API always speaks meters.
 */
export function useDistanceUnit(): DistanceUnit {
  return useWeightUnit() === 'lb' ? 'mi' : 'km';
}
