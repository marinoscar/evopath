/**
 * A device's sync runs, newest first (#283). A table from `sm` up; below it
 * (the same `sm` boundary every compact gate in the app uses) a list, so a
 * 390px phone never scrolls the page sideways.
 */
import { Fragment, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Collapse,
  IconButton,
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
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import { runTypeStats, type Run } from '../../../services/healthSync';
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

/** `run.details.perType`: what the phone read and sent per data type. */
function PerTypeStats({ run }: { run: Run }) {
  const stats = runTypeStats(run);
  return (
    <List dense disablePadding aria-label="Per data type" data-testid={`run-per-type-${run.id}`}>
      {stats.map((stat) => (
        <ListItem key={stat.dataType} disableGutters sx={{ py: 0 }}>
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            <Box component="span" sx={{ fontWeight: 500 }}>
              {stat.dataType}
            </Box>
            {stat.permission === 'denied' ? ' · permission denied' : ''} · read {stat.read ?? 0} ·
            sent {stat.sent ?? 0}
          </Typography>
        </ListItem>
      ))}
    </List>
  );
}

function PerTypeToggle({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  return (
    <Box>
      <Button size="small" onClick={() => setOpen((v) => !v)} aria-expanded={open} sx={{ px: 0 }}>
        {open ? 'Hide per-type counts' : 'Per-type counts'}
      </Button>
      <Collapse in={open} unmountOnExit>
        <PerTypeStats run={run} />
      </Collapse>
    </Box>
  );
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
            {runTypeStats(run).length > 0 && <PerTypeToggle run={run} />}
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
            <TableCell padding="checkbox" />
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
            <RunRow key={run.id} run={run} />
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

const COLUMN_COUNT = 9;

function RunRow({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  const hasStats = runTypeStats(run).length > 0;
  return (
    <Fragment>
      <TableRow sx={hasStats && open ? { '& > td': { borderBottom: 'unset' } } : undefined}>
        <TableCell padding="checkbox">
          {hasStats && (
            <IconButton
              size="small"
              aria-label={open ? 'Hide per-type counts' : 'Show per-type counts'}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
            </IconButton>
          )}
        </TableCell>
        <TableCell>{formatDateTime(run.finishedAt)}</TableCell>
        <TableCell>{TRIGGER_LABELS[run.trigger]}</TableCell>
        <TableCell>
          <RunStatusChip status={run.status} />
        </TableCell>
        <TableCell align="right">{run.recordsRead}</TableCell>
        <TableCell align="right">{run.created}</TableCell>
        <TableCell align="right">{run.updated}</TableCell>
        <TableCell align="right">{run.deleted}</TableCell>
        <TableCell sx={{ maxWidth: 280, overflowWrap: 'anywhere' }}>
          {runError(run) ?? '—'}
        </TableCell>
      </TableRow>
      {hasStats && (
        <TableRow>
          <TableCell colSpan={COLUMN_COUNT} sx={{ py: 0 }}>
            <Collapse in={open} unmountOnExit>
              <Box sx={{ py: 1, pl: 6 }}>
                <PerTypeStats run={run} />
              </Box>
            </Collapse>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
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
