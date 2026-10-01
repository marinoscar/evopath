/**
 * The "Health Connect" source label (#283, epic #276). Activity the Android
 * app imported arrives with `source: 'integration'`; wherever entries are
 * shown, this chip says where they came from. Display only.
 */
import { Chip } from '@mui/material';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import type { ActivityEntry } from '../../services/goals';

export const HEALTH_CONNECT_LABEL = 'Health Connect';

/** True for an entry the Android app imported from Health Connect. */
export function isHealthConnectEntry(entry: Pick<ActivityEntry, 'source'>): boolean {
  return entry.source === 'integration';
}

/** True when any entry that still counts (not superseded) came from Health Connect. */
export function countsHealthConnect(entries: Array<Pick<ActivityEntry, 'source'> & { superseded?: boolean }>): boolean {
  return entries.some((entry) => !entry.superseded && isHealthConnectEntry(entry));
}

export function HealthConnectChip() {
  return (
    <Chip
      size="small"
      variant="outlined"
      icon={<FavoriteBorderIcon />}
      label={HEALTH_CONNECT_LABEL}
      data-testid="health-connect-chip"
    />
  );
}
