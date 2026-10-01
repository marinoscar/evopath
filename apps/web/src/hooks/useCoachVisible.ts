/**
 * Can this user see the AI Coach? (E7.8, #248.) The same answer the `coach`
 * destination gives the navigation (`isDestinationVisible`: `ai:use` AND the
 * `ai` feature), so Today's hero and card can never disagree with the tab.
 */
import { DESTINATIONS, isDestinationVisible } from '../config/destinations';
import { usePermissions } from './usePermissions';
import { useSettingsFeatures } from './useSettingsFeatures';

const COACH = DESTINATIONS.find((destination) => destination.key === 'coach');

export function useCoachVisible(): boolean {
  const { hasPermission } = usePermissions();
  const features = useSettingsFeatures();
  return COACH ? isDestinationVisible(COACH, hasPermission, features) : false;
}
