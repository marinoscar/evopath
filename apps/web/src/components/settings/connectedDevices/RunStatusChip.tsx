import { Chip } from '@mui/material';
import type { HealthSyncRunStatus } from '../../../services/healthSync';
import { RUN_STATUS_COLORS, RUN_STATUS_LABELS } from './format';

/** A sync run's status (ok / partial / failed / skipped) as a small coloured chip. */
export function RunStatusChip({ status }: { status: HealthSyncRunStatus }) {
  return (
    <Chip
      size="small"
      variant="outlined"
      color={RUN_STATUS_COLORS[status]}
      label={RUN_STATUS_LABELS[status]}
      data-testid={`run-status-${status}`}
    />
  );
}
