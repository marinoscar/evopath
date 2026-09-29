/**
 * Health (`/health`), issue #53 (E2.3): the latest body and vital values and
 * the quick-entry dialog. Replaces the E1 placeholder.
 *
 * `health_data:read` decides whether there is anything to show (the API
 * enforces it on every call; this only avoids asking); `health_data:write`
 * enables the Log buttons. Later stories (E2.4 check-in, E2.5 history and
 * trends) append sections below the tiles in the same plain stack: no tabs.
 */

import { useState } from 'react';
import { Alert, Box, Button, Container, Stack, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { HEALTH_DATA_UNAVAILABLE, type MetricKey } from '../services/health';
import { usePermissions } from '../hooks/usePermissions';
import { useHealthProfile } from '../hooks/useHealthProfile';
import { useLatestMeasurements } from '../hooks/useLatestMeasurements';
import { useMeasurementCatalog } from '../hooks/useMeasurementCatalog';
import {
  LatestMeasurementTiles,
  LatestMeasurementTilesSkeleton,
} from '../components/health/LatestMeasurementTiles';
import { LogMeasurementDialog } from '../components/health/LogMeasurementDialog';
import { LogMeasurementButton } from '../components/health/LogMeasurementButton';
import { CheckInSection } from '../components/health/CheckInSection';

function HealthOverview({ canLog }: { canLog: boolean }) {
  const {
    catalog,
    isLoading: catalogLoading,
    error: catalogError,
    errorStatus,
    refresh: retryCatalog,
  } = useMeasurementCatalog();
  const latest = useLatestMeasurements();
  const { profile, isLoading: profileLoading } = useHealthProfile();
  const [dialog, setDialog] = useState<{ open: boolean; focusMetric?: MetricKey }>({ open: false });

  const openDialog = (focusMetric?: MetricKey) => setDialog({ open: true, focusMetric });
  const forbidden = latest.forbidden || errorStatus === 403;
  // A refetch after a save keeps the tiles on screen; only the first load shows skeletons.
  const loading = catalogLoading || profileLoading || (latest.isLoading && latest.items.length === 0);
  const loadError = latest.error ?? (catalog ? null : catalogError);

  const retry = () => {
    if (!catalog) retryCatalog();
    void latest.refresh();
  };

  return (
    <>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 2, mb: 3 }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="h4" component="h1" gutterBottom>
            Health
          </Typography>
          <Typography color="text.secondary">Your body and how you feel</Typography>
        </Box>
        {!forbidden && (
          <LogMeasurementButton variant="contained" startIcon={<AddIcon />} canLog={canLog} onClick={() => openDialog()}>
            Log measurement
          </LogMeasurementButton>
        )}
      </Box>

      <Stack spacing={4}>
        {forbidden ? (
          <Alert severity="info">{HEALTH_DATA_UNAVAILABLE}</Alert>
        ) : loadError && !loading ? (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={retry}>
                Retry
              </Button>
            }
          >
            Could not load your measurements. {loadError}
          </Alert>
        ) : loading || !catalog ? (
          <LatestMeasurementTilesSkeleton />
        ) : (
          <Box component="section" aria-label="Latest measurements">
            <LatestMeasurementTiles
              catalog={catalog}
              items={latest.items}
              unitSystem={profile?.unitSystem ?? 'metric'}
              heightMm={profile?.heightMm ?? null}
              canLog={canLog}
              onLog={openDialog}
            />
          </Box>
        )}
        {/* E2.4 (#56): today's check-in and the recent ones. */}
        {!forbidden && <CheckInSection canWrite={canLog} />}
      </Stack>

      <LogMeasurementDialog
        open={dialog.open}
        focusMetric={dialog.focusMetric}
        latest={latest.items}
        profile={profile}
        onClose={() => setDialog((prev) => ({ ...prev, open: false }))}
        onSaved={() => void latest.refresh()}
      />
    </>
  );
}

export default function HealthPage() {
  const { hasPermission } = usePermissions();
  const canRead = hasPermission('health_data:read');

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        {canRead ? (
          <HealthOverview canLog={hasPermission('health_data:write')} />
        ) : (
          <>
            <Typography variant="h4" component="h1" gutterBottom>
              Health
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 3 }}>
              Your body and how you feel
            </Typography>
            <Alert severity="info">{HEALTH_DATA_UNAVAILABLE}</Alert>
          </>
        )}
      </Box>
    </Container>
  );
}
