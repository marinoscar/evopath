/**
 * The Temporary section of `/gyms` (E6.2): gyms made for a trip (the hotel
 * flow of the adjust-workout sheet) that are not saved yet. Each says when
 * the daily purge deletes it ("Expires in N days": its last change plus
 * {@link TEMPORARY_GYM_RETENTION_DAYS} days) and offers Save or Delete; none
 * offers Set default (a temporary gym is never the default).
 *
 * Renders nothing without temporary gyms. Presentation only: the list, the
 * mutations and the purge are the API's.
 */
import { Box, Typography } from '@mui/material';
import {
  TEMPORARY_GYM_RETENTION_DAYS,
  temporaryGymExpiryText,
  type GymSummary,
} from '../../services/gyms';
import { GymCard } from './GymCard';

export const TEMPORARY_GYMS_TITLE = 'Temporary';

export interface TemporaryGymsSectionProps {
  gyms: readonly GymSummary[];
  canWrite: boolean;
  onSave: (gym: GymSummary) => void;
  onDelete: (gym: GymSummary) => void;
  /** Never offered for a temporary gym; kept for the card's contract. */
  onSetDefault: (gym: GymSummary) => Promise<void>;
  /** For tests: "now". */
  now?: number;
  gridSx?: object;
}

export function TemporaryGymsSection({ gyms, canWrite, onSave, onDelete, onSetDefault, now, gridSx }: TemporaryGymsSectionProps) {
  const temporary = gyms.filter((gym) => gym.isTemporary);
  if (temporary.length === 0) return null;

  return (
    <Box component="section" aria-labelledby="temporary-gyms-heading" data-testid="temporary-gyms" sx={{ mt: 4 }}>
      <Typography id="temporary-gyms-heading" variant="h5" component="h2" gutterBottom>
        {TEMPORARY_GYMS_TITLE}
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Gyms from a trip. Each is deleted {TEMPORARY_GYM_RETENTION_DAYS} days after its last change unless you save it
        or a workout used it.
      </Typography>
      <Box sx={gridSx}>
        {temporary.map((gym) => (
          <GymCard
            key={gym.id}
            gym={gym}
            canWrite={canWrite}
            onSetDefault={onSetDefault}
            onDelete={onDelete}
            onSave={onSave}
            expiryText={temporaryGymExpiryText(gym.updatedAt, now)}
            headingComponent="h3"
          />
        ))}
      </Box>
    </Box>
  );
}

export default TemporaryGymsSection;
