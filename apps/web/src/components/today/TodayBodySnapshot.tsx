/**
 * The Today page's "Body snapshot" card body (issue #53, E2.3): the latest
 * weight, body fat and waist with their dates, and a Log button; or, with
 * nothing logged yet, "Log your first weight". Both open the same quick-entry
 * dialog as the Health page, and a save refetches the latest values.
 *
 * Rendered inside `TodayCard`, which keeps the frame, the `h2` and the
 * "Open Health" link.
 */

import { useState, type ReactNode } from 'react';
import { Box, Button, Skeleton, Typography } from '@mui/material';
import { HEALTH_DATA_UNAVAILABLE, type MetricKey } from '../../services/health';
import { usePermissions } from '../../hooks/usePermissions';
import { useHealthProfile } from '../../hooks/useHealthProfile';
import { useLatestMeasurements } from '../../hooks/useLatestMeasurements';
import { useMeasurementCatalog } from '../../hooks/useMeasurementCatalog';
import { formatMeasurement } from '../../utils/measurementUnits';
import { formatTakenAt } from '../../utils/measurementDates';
import { LogMeasurementDialog } from '../health/LogMeasurementDialog';
import { LogMeasurementButton } from '../health/LogMeasurementButton';

const ROWS: ReadonlyArray<{ key: MetricKey; label: string }> = [
  { key: 'weight', label: 'Weight' },
  { key: 'body_fat_pct', label: 'Body fat' },
  { key: 'waist_circumference', label: 'Waist' },
];

function Snapshot({ canLog }: { canLog: boolean }) {
  const {
    catalog,
    isLoading: catalogLoading,
    error: catalogError,
    errorStatus,
    refresh: retryCatalog,
  } = useMeasurementCatalog();
  const latest = useLatestMeasurements();
  const { profile, isLoading: profileLoading } = useHealthProfile();
  const [dialogOpen, setDialogOpen] = useState(false);

  const unitSystem = profile?.unitSystem ?? 'metric';
  const loading = catalogLoading || profileLoading || (latest.isLoading && latest.items.length === 0);

  const retry = () => {
    if (!catalog) retryCatalog();
    void latest.refresh();
  };

  let body: ReactNode;
  if (latest.forbidden || errorStatus === 403) {
    body = <Typography color="text.secondary">{HEALTH_DATA_UNAVAILABLE}</Typography>;
  } else if (loading) {
    body = (
      <Box data-testid="body-snapshot-skeleton">
        {ROWS.map((row) => (
          <Skeleton key={row.key} width="70%" />
        ))}
      </Box>
    );
  } else if (latest.error || (!catalog && catalogError)) {
    body = (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography color="text.secondary">Could not load your measurements.</Typography>
        <Button size="small" onClick={retry}>
          Retry
        </Button>
      </Box>
    );
  } else {
    const byKey = new Map(latest.items.map((item) => [item.metricKey, item.latest]));
    const metrics = new Map((catalog?.metrics ?? []).map((metric) => [metric.key, metric]));
    const rows = ROWS.flatMap((row) => {
      const reading = byKey.get(row.key);
      const metric = metrics.get(row.key);
      return reading && metric ? [{ ...row, reading, metric }] : [];
    });

    body =
      rows.length === 0 ? (
        <Box>
          <Typography color="text.secondary" sx={{ mb: 1 }}>
            Your latest weight, body fat and waist appear here.
          </Typography>
          <LogMeasurementButton variant="outlined" canLog={canLog} onClick={() => setDialogOpen(true)}>
            Log your first weight
          </LogMeasurementButton>
        </Box>
      ) : (
        <Box>
          <Box component="dl" sx={{ m: 0, mb: 1 }}>
            {rows.map(({ key, label, reading, metric }) => (
              <Box
                key={key}
                sx={{ display: 'flex', alignItems: 'baseline', gap: 1, py: 0.5, flexWrap: 'wrap' }}
              >
                <Typography component="dt" color="text.secondary" sx={{ minWidth: 80 }}>
                  {label}
                </Typography>
                <Typography component="dd" sx={{ m: 0, fontWeight: 600 }}>
                  {formatMeasurement(metric, reading.value, unitSystem)}
                </Typography>
                <Typography component="dd" variant="body2" color="text.secondary" sx={{ m: 0 }}>
                  {formatTakenAt(reading.measuredAt)}
                </Typography>
              </Box>
            ))}
          </Box>
          <LogMeasurementButton
            size="small"
            variant="outlined"
            canLog={canLog}
            onClick={() => setDialogOpen(true)}
            aria-label="Log measurement"
          >
            Log
          </LogMeasurementButton>
        </Box>
      );
  }

  return (
    <>
      {body}
      <LogMeasurementDialog
        open={dialogOpen}
        latest={latest.items}
        profile={profile}
        onClose={() => setDialogOpen(false)}
        onSaved={() => void latest.refresh()}
      />
    </>
  );
}

export function TodayBodySnapshot() {
  const { hasPermission } = usePermissions();
  if (!hasPermission('health_data:read')) {
    return <Typography color="text.secondary">{HEALTH_DATA_UNAVAILABLE}</Typography>;
  }
  return <Snapshot canLog={hasPermission('health_data:write')} />;
}

export default TodayBodySnapshot;
