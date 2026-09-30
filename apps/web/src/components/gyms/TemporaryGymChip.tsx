/**
 * "Save {name}?" on `/train` (E6.2): the most recently changed temporary gym
 * (the hotel flow's), one tap from being saved. The finish summary asks
 * once; this chip and the Temporary section on `/gyms` keep the question
 * reachable until the gym is saved, deleted or purged.
 *
 * Needs `gyms:read` and `gyms:write`; renders nothing without a temporary
 * gym. Presentation only: saving is `PATCH /api/gyms/:id { isTemporary: false }`.
 */
import { useState } from 'react';
import { Box, Chip, type SxProps, type Theme } from '@mui/material';
import { BookmarkAdd as SaveIcon } from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useGyms } from '../../hooks/useGyms';
import type { GymSummary } from '../../services/gyms';
import { SaveGymDialog } from './SaveGymPrompt';

export const temporaryGymChipLabel = (name: string) => `Save ${name}?`;

/** The newest temporary gym by last change, or `null`. */
export function latestTemporaryGym(gyms: readonly GymSummary[]): GymSummary | null {
  let latest: GymSummary | null = null;
  for (const gym of gyms) {
    if (!gym.isTemporary) continue;
    if (!latest || Date.parse(gym.updatedAt) > Date.parse(latest.updatedAt)) latest = gym;
  }
  return latest;
}

export function TemporaryGymChip({ sx }: { sx?: SxProps<Theme> }) {
  const { hasPermission } = usePermissions();
  const allowed = hasPermission('gyms:read') && hasPermission('gyms:write');
  const { gyms, save } = useGyms({ enabled: allowed });
  const [target, setTarget] = useState<GymSummary | null>(null);
  const [open, setOpen] = useState(false);
  const latest = allowed ? latestTemporaryGym(gyms) : null;

  if (!latest && !open) return null;

  return (
    <Box sx={sx}>
      {latest && (
        <Chip
          clickable
          color="secondary"
          variant="outlined"
          icon={<SaveIcon aria-hidden />}
          label={temporaryGymChipLabel(latest.name)}
          onClick={() => {
            setTarget(latest);
            setOpen(true);
          }}
          aria-haspopup="dialog"
          data-testid="temporary-gym-chip"
          sx={{ maxWidth: '100%', minHeight: 36 }}
        />
      )}
      <SaveGymDialog
        open={open}
        gym={target}
        otherGyms={gyms}
        onClose={() => setOpen(false)}
        onSave={async (input) => {
          if (target) await save(target.id, input);
        }}
      />
    </Box>
  );
}

export default TemporaryGymChip;
