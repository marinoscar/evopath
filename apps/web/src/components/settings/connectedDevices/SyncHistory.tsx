/**
 * A device's sync runs, newest first (#283). A table from `sm` up; below it
 * (the same `sm` boundary every compact gate in the app uses) a list, so a
 * 390px phone never scrolls the page sideways.
 */
import {
  Alert,
  Box,
  Button,
  List,
  ListItem,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import type { Run } from '../../../services/healthSync';
import { useDeviceRuns } from '../../../hooks/useHealthSync';
import { RunStatusChip } from './RunStatusChip';
import { TRIGGER_LABELS, formatDateTime } from './format';

function counts(run: Run): string {
  return `Read ${run.recordsRead} · +${run.created} new · ${run.updated} updated · ${run.deleted} removed`;
}

function runError(run: Run): string | null {
  if (!run.errorMessage && !run.errorCode) return null;
  return [run.errorCode, run.errorMessage].filter(Boolean).join(': ');
}

function RunsList({ runs }: { runs: Run[] }) {
  return (
    <List dense disablePadding aria-label="Sync history">
      {runs.map((run) => {
        const error = runError(run);
        return (
          <ListItem key={run.id} divider disableGutters sx={{ display: 'block' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                {formatDateTime(run.finishedAt)}
              </Typography>
              <RunStatusChip status={run.status} />
            </Box>
            <Typography variant="body2" color="text.secondary">
              {TRIGGER_LABELS[run.trigger]} · {counts(run)}
            </Typography>
            {error && (
              <Typography variant="body2" color="error" sx={{ overflowWrap: 'anywhere' }}>
                {error}
              </Typography>
            )}
          </ListItem>
        );
      })}
    </List>
  );
}

function RunsTable({ runs }: { runs: Run[] }) {
  return (
    <TableContainer>
      <Table size="small" aria-label="Sync history">
        <TableHead>
          <TableRow>
            <TableCell>Time</TableCell>
            <TableCell>Trigger</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Read</TableCell>
            <TableCell align="right">Created</TableCell>
            <TableCell align="right">Updated</TableCell>
            <TableCell align="right">Deleted</TableCell>
            <TableCell>Error</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.id}>
              <TableCell>{formatDateTime(run.finishedAt)}</TableCell>
              <TableCell>{TRIGGER_LABELS[run.trigger]}</TableCell>
              <TableCell>
                <RunStatusChip status={run.status} />
              </TableCell>
              <TableCell align="right">{run.recordsRead}</TableCell>
              <TableCell align="right">{run.created}</TableCell>
              <TableCell align="right">{run.updated}</TableCell>
              <TableCell align="right">{run.deleted}</TableCell>
              <TableCell sx={{ maxWidth: 280, overflowWrap: 'anywhere' }}>{runError(run) ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export function SyncHistory({ deviceId }: { deviceId: string }) {
  const theme = useTheme();
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));
  const { runs, isLoading, error, refresh } = useDeviceRuns(deviceId, true);

  if (isLoading && runs.length === 0) {
    return (
      <Box data-testid="sync-history-loading">
        <Skeleton width="80%" />
        <Skeleton width="60%" />
      </Box>
    );
  }
  if (error && runs.length === 0) {
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void refresh()}>
            Retry
          </Button>
        }
      >
        {error}
      </Alert>
    );
  }
  if (runs.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No syncs yet. The phone reports every sync here, including failed ones.
      </Typography>
    );
  }
  return isCompactWindow ? <RunsList runs={runs} /> : <RunsTable runs={runs} />;
}
