/**
 * The Today page's "Your gym" card body (E3.3): the default gym's name and
 * equipment count with an Open link, or "Add your gym" linking to
 * `/gyms/new` when there is none yet.
 *
 * Rendered inside `TodayCard`, which keeps the frame, the `h2` and the
 * "Open Gyms" link.
 */
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Button, Skeleton, Typography } from '@mui/material';
import { usePermissions } from '../../hooks/usePermissions';
import { useGyms } from '../../hooks/useGyms';
import { GYMS_UNAVAILABLE } from '../../services/gyms';

function DefaultGym({ canWrite }: { canWrite: boolean }) {
  const { gyms, isLoading, error, forbidden, refresh } = useGyms();
  const gym = gyms.find((g) => g.isDefault) ?? gyms[0] ?? null;

  let body: ReactNode;
  if (forbidden) {
    body = <Typography color="text.secondary">{GYMS_UNAVAILABLE}</Typography>;
  } else if (isLoading && gyms.length === 0) {
    body = (
      <Box data-testid="today-gym-skeleton">
        <Skeleton width="60%" />
        <Skeleton width="40%" />
      </Box>
    );
  } else if (error && gyms.length === 0) {
    body = (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography color="text.secondary">Could not load your gyms.</Typography>
        <Button size="small" onClick={() => void refresh()}>
          Retry
        </Button>
      </Box>
    );
  } else if (!gym) {
    body = (
      <Box>
        <Typography color="text.secondary" sx={{ mb: 1 }}>
          Tell the app where you train and what is there.
        </Typography>
        {canWrite && (
          <Button component={RouterLink} to="/gyms/new" variant="outlined" size="small">
            Add your gym
          </Button>
        )}
      </Box>
    );
  } else {
    const count = gym.equipmentCount;
    body = (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{gym.name}</Typography>
          <Typography variant="body2" color="text.secondary">
            {count} {count === 1 ? 'piece of equipment' : 'pieces of equipment'}
          </Typography>
        </Box>
        <Button component={RouterLink} to={`/gyms/${gym.id}`} size="small" aria-label={`Open ${gym.name}`}>
          Open
        </Button>
      </Box>
    );
  }
  return <Box sx={{ mb: 1 }}>{body}</Box>;
}

export function TodayGym() {
  const { hasPermission } = usePermissions();
  if (!hasPermission('gyms:read')) {
    return <Typography color="text.secondary">{GYMS_UNAVAILABLE}</Typography>;
  }
  return <DefaultGym canWrite={hasPermission('gyms:write')} />;
}

export default TodayGym;
