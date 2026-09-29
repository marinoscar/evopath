/**
 * The Today page's "Readiness" card body (issue #56, E2.4): today's check-in
 * scores ("Energy 4", "Sleep quality 3", ...) with an Edit button, or "How are
 * you feeling today? Takes a few seconds." and Check in. Both open the same
 * dialog as the Health page. No combined readiness score is computed; E5
 * decides how the four values shape a workout.
 *
 * Rendered inside `TodayCard`, which keeps the frame, the `h2` and the
 * "Open Health" link.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Box, Button, Skeleton, Typography } from '@mui/material';
import { HEALTH_DATA_UNAVAILABLE } from '../../services/health';
import { usePermissions } from '../../hooks/usePermissions';
import { useCheckIn } from '../../hooks/useCheckIn';
import { useMeasurementCatalog } from '../../hooks/useMeasurementCatalog';
import { CheckInDialog } from '../health/CheckInDialog';
import { CheckInSummary, checkInFieldDefs } from '../health/CheckInSummary';
import { LogMeasurementButton } from '../health/LogMeasurementButton';

function Readiness({ canWrite }: { canWrite: boolean }) {
  const checkIn = useCheckIn();
  const { catalog } = useMeasurementCatalog();
  const defs = useMemo(() => checkInFieldDefs(catalog), [catalog]);
  const [dialog, setDialog] = useState<{ open: boolean; date: string | null }>({ open: false, date: null });

  const open = () => setDialog({ open: true, date: checkIn.date });

  let body: ReactNode;
  if (checkIn.forbidden) {
    body = <Typography color="text.secondary">{HEALTH_DATA_UNAVAILABLE}</Typography>;
  } else if (checkIn.isLoading && checkIn.date === null) {
    body = (
      <Box data-testid="readiness-skeleton">
        <Skeleton width="70%" />
        <Skeleton width="40%" />
      </Box>
    );
  } else if (checkIn.error) {
    body = (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography color="text.secondary">Could not load today&apos;s check-in.</Typography>
        <Button size="small" onClick={() => void checkIn.refresh()}>
          Retry
        </Button>
      </Box>
    );
  } else if (checkIn.checkIn) {
    body = (
      <Box>
        <Box sx={{ mb: 1.5 }}>
          <CheckInSummary checkIn={checkIn.checkIn} defs={defs} />
        </Box>
        <LogMeasurementButton size="small" variant="outlined" canLog={canWrite} onClick={open}>
          Edit check-in
        </LogMeasurementButton>
      </Box>
    );
  } else {
    body = (
      <Box>
        <Typography color="text.secondary" sx={{ mb: 1 }}>
          How are you feeling today? Takes a few seconds.
        </Typography>
        <LogMeasurementButton variant="outlined" canLog={canWrite} onClick={open}>
          Check in
        </LogMeasurementButton>
      </Box>
    );
  }

  return (
    <>
      {body}
      {dialog.date && (
        <CheckInDialog
          open={dialog.open}
          date={dialog.date}
          checkIn={dialog.date === checkIn.date ? checkIn.checkIn : null}
          onClose={() => setDialog((prev) => ({ ...prev, open: false }))}
          onSave={checkIn.save}
          onDelete={checkIn.remove}
          onConflict={() => void checkIn.refresh()}
        />
      )}
    </>
  );
}

export function TodayReadiness() {
  const { hasPermission } = usePermissions();
  if (!hasPermission('health_data:read')) {
    return <Typography color="text.secondary">{HEALTH_DATA_UNAVAILABLE}</Typography>;
  }
  return <Readiness canWrite={hasPermission('health_data:write')} />;
}

export default TodayReadiness;
