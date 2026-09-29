/**
 * Gyms (`/gyms`), E3.3: the caller's gyms as cards, default first. Replaces
 * the E1 placeholder. Add gym goes to `/gyms/new`; each card opens
 * `/gyms/:gymId`, sets the default or deletes (after a confirmation).
 *
 * `gyms:read` decides whether there is anything to show and `gyms:write`
 * enables the mutations; the API enforces both on every call, this only
 * avoids offering what would be refused. Everything here works with AI off.
 */
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, Box, Button, Container, Skeleton, Typography } from '@mui/material';
import { Add as AddIcon, Place as PlaceIcon } from '@mui/icons-material';
import { usePermissions } from '../hooks/usePermissions';
import { useGyms } from '../hooks/useGyms';
import { GYMS_UNAVAILABLE, type GymSummary } from '../services/gyms';
import { EmptyState } from '../components/common/EmptyState';
import { GymCard } from '../components/gyms/GymCard';
import { ConfirmDialog } from '../components/gyms/ConfirmDialog';
import { GYMS_SUBTITLE, GYMS_TITLE, deleteGymMessage } from '../components/gyms/gymCopy';

const GRID_SX = {
  display: 'grid',
  gap: 2,
  // One column below `sm`, a grid above.
  gridTemplateColumns: { xs: '1fr', sm: 'repeat(auto-fill, minmax(320px, 1fr))' },
} as const;

function GymList({ canWrite }: { canWrite: boolean }) {
  const { gyms, isLoading, error, forbidden, refresh, setDefault, remove } = useGyms();
  // The target outlives `open` so the dialog keeps its text while it closes.
  const [pendingDelete, setPendingDelete] = useState<GymSummary | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (forbidden) return <Alert severity="info">{GYMS_UNAVAILABLE}</Alert>;

  if (error && gyms.length === 0 && !isLoading) {
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void refresh()}>
            Retry
          </Button>
        }
      >
        Could not load your gyms. {error}
      </Alert>
    );
  }

  if (isLoading && gyms.length === 0) {
    return (
      <Box sx={GRID_SX} data-testid="gyms-skeleton">
        {[0, 1].map((i) => (
          <Skeleton key={i} variant="rounded" height={148} />
        ))}
      </Box>
    );
  }

  if (gyms.length === 0) {
    return (
      <EmptyState
        Icon={PlaceIcon}
        title="No gyms yet"
        description="A gym is anywhere you train: home, a club, the office or a hotel. Add one and list the equipment it has, so workouts can fit what is there."
        action={
          canWrite ? (
            <Button component={RouterLink} to="/gyms/new" variant="contained" startIcon={<AddIcon />}>
              Add gym
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <>
      <Box sx={GRID_SX}>
        {gyms.map((gym) => (
          <GymCard
            key={gym.id}
            gym={gym}
            canWrite={canWrite}
            onSetDefault={(g) => setDefault(g.id)}
            onDelete={(g) => {
              setPendingDelete(g);
              setDeleteOpen(true);
            }}
          />
        ))}
      </Box>
      <ConfirmDialog
        open={deleteOpen}
        title="Delete gym?"
        message={pendingDelete ? deleteGymMessage(pendingDelete.name, pendingDelete.photoCount) : ''}
        confirmLabel="Delete"
        onClose={() => setDeleteOpen(false)}
        onConfirm={async () => {
          if (!pendingDelete) return;
          await remove(pendingDelete.id);
          setDeleteOpen(false);
        }}
      />
    </>
  );
}

export default function GymsPage() {
  const { hasPermission } = usePermissions();
  const canRead = hasPermission('gyms:read');
  const canWrite = hasPermission('gyms:write');

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 2, mb: 3 }}>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="h4" component="h1" gutterBottom>
              {GYMS_TITLE}
            </Typography>
            <Typography color="text.secondary">{GYMS_SUBTITLE}</Typography>
          </Box>
          {canRead && canWrite && (
            <Button component={RouterLink} to="/gyms/new" variant="contained" startIcon={<AddIcon />}>
              Add gym
            </Button>
          )}
        </Box>
        {canRead ? <GymList canWrite={canWrite} /> : <Alert severity="info">{GYMS_UNAVAILABLE}</Alert>}
      </Box>
    </Container>
  );
}
