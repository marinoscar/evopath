/**
 * A worker node's full vitals snapshot (issue #131) — the detail behind the
 * fleet table's compact "Vitals" cell.
 *
 * Opened from the "View vitals" row action on `pages/Admin/WorkersPage.tsx`,
 * so it is reachable from the desktop grid, the tablet expander and the phone
 * card from one declaration, for every `nodes:read` holder (reading vitals is
 * not a write).
 *
 * The page hands this dialog the CURRENT row on every render, not a copy taken
 * when it opened, so the fleet poll keeps it live: an operator watching a node
 * drain sees its slots fall without closing and reopening anything.
 *
 * ACCESSIBILITY: every bar is a `progressbar` with an accessible name and an
 * `aria-valuetext` that states the reading in words, and the same reading is
 * printed beside it — no value is carried by bar length or colour alone.
 * Stale vitals are said in words (an `Alert`), not just greyed.
 */

import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import type { ReactNode } from 'react';
import { useId } from 'react';
import type { NodeVitalsCounters, WorkerNode } from '../../services/nodes';
import { formatDateTime } from '../../pages/Admin/jobsTable';
import {
  areVitalsStale,
  diskFreeRatio,
  formatBytes,
  formatCpu,
  formatEventLoopDelay,
  formatOptionalBytes,
  formatPercent,
  formatUptime,
  formatVitalsReported,
  isLowDisk,
  ratio,
} from '../../pages/Admin/workerVitals';

interface NodeVitalsDialogProps {
  /** The row to show, or `null` when closed. */
  node: WorkerNode | null;
  /** The page's single render clock — see `WorkersPage.tsx`. */
  now: Date;
  onClose: () => void;
}

/** The counters shown, in reading order, with the words an operator uses. */
export const VITALS_COUNTER_ROWS: { key: keyof NodeVitalsCounters; label: string }[] = [
  { key: 'claims', label: 'Claims' },
  { key: 'succeeded', label: 'Succeeded' },
  { key: 'failed', label: 'Failed' },
  { key: 'rateLimited', label: 'Rate limited' },
  { key: 'emptyPolls', label: 'Empty polls' },
  { key: 'claimFailures', label: 'Claim failures' },
  { key: 'leaseRenewals', label: 'Lease renewals' },
  { key: 'leaseRenewFailures', label: 'Lease renew failures' },
  { key: 'heartbeatFailures', label: 'Heartbeat failures' },
  { key: 'watchdogTrips', label: 'Watchdog trips' },
];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ minWidth: 160, flexGrow: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Typography variant="body2" component="div" sx={{ mt: 0.25 }}>
        {children}
      </Typography>
    </Box>
  );
}

interface MeterProps {
  label: string;
  /** 0..1, or `null` when the node did not report enough to compute it. */
  fraction: number | null;
  /** The reading in words — printed, and used as `aria-valuetext`. */
  text: string;
  warning?: boolean;
}

function Meter({ label, fraction, text, warning = false }: MeterProps) {
  const id = useId();
  return (
    <Box sx={{ minWidth: 200, flexGrow: 1, flexBasis: 200 }}>
      <Stack direction="row" sx={{ justifyContent: 'space-between', gap: 1 }}>
        <Typography id={id} variant="caption" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {text}
        </Typography>
      </Stack>
      {fraction !== null && (
        <LinearProgress
          variant="determinate"
          value={Math.min(100, Math.max(0, fraction * 100))}
          color={warning ? 'warning' : 'primary'}
          aria-labelledby={id}
          aria-valuetext={text}
          sx={{ mt: 0.5, height: 6, borderRadius: 3 }}
        />
      )}
    </Box>
  );
}

function formatCount(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString();
}

export function NodeVitalsDialog({ node, now, onClose }: NodeVitalsDialogProps) {
  const theme = useTheme();
  // The same `down('sm')` compact-window read the settings UI uses (CLAUDE.md
  // rule 5): a full screen on a phone rather than a dialog that scrolls inside
  // a scroll.
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));
  const titleId = useId();

  const vitals = node?.lastVitals ?? null;
  const stale = node ? areVitalsStale(node) : false;
  const reported = node ? formatVitalsReported(node.lastVitalsAt, now) : null;

  const heap = vitals ? ratio(vitals.heapUsedBytes, vitals.heapLimitBytes) : null;
  const diskFree = vitals ? diskFreeRatio(vitals) : null;
  const slots = vitals ? ratio(vitals.slotsUsed, vitals.slotsTotal) : null;
  const lowDisk = isLowDisk(vitals);

  return (
    <Dialog
      open={node !== null}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      fullScreen={isCompactWindow}
      aria-labelledby={titleId}
    >
      <DialogTitle id={titleId}>
        {node ? `Vitals — ${node.name} (${node.hostname})` : 'Vitals'}
      </DialogTitle>
      <DialogContent dividers>
        {node && !vitals && (
          <Typography color="text.secondary" data-testid="node-vitals-empty">
            This node has not reported vitals yet. Nodes running an older CLI do not send them. Its
            health is still derived from its heartbeat.
          </Typography>
        )}

        {node && vitals && (
          <Stack spacing={3}>
            <Box>
              {reported && (
                <Tooltip title={formatDateTime(node.lastVitalsAt)}>
                  <Typography variant="body2" color="text.secondary" component="span">
                    {reported}
                  </Typography>
                </Tooltip>
              )}
              {stale && (
                <Alert severity="warning" sx={{ mt: 1 }}>
                  This node is {node.health}: these are the last vitals it sent and may no longer
                  describe it.
                </Alert>
              )}
            </Box>

            <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Meter
                label="Heap used"
                fraction={heap}
                text={
                  heap !== null
                    ? `${formatBytes(vitals.heapUsedBytes!)} of ${formatBytes(
                        vitals.heapLimitBytes!
                      )} (${formatPercent(heap)})`
                    : formatOptionalBytes(vitals.heapUsedBytes)
                }
              />
              <Meter
                label="State directory disk used"
                fraction={diskFree !== null ? 1 - diskFree : null}
                warning={lowDisk}
                text={
                  diskFree !== null
                    ? `${formatBytes(vitals.stateDirFreeBytes!)} free of ${formatBytes(
                        vitals.stateDirTotalBytes!
                      )} (${formatPercent(diskFree)} free${lowDisk ? ', low' : ''})`
                    : formatOptionalBytes(vitals.stateDirFreeBytes)
                }
              />
              <Meter
                label="Job slots in use"
                fraction={slots}
                text={
                  slots !== null
                    ? `${vitals.slotsUsed} of ${vitals.slotsTotal} (${formatPercent(slots)})`
                    : '—'
                }
              />
            </Stack>

            <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Field label="CPU">{formatCpu(vitals.cpuPercent)}</Field>
              <Field label="Resident memory (RSS)">{formatOptionalBytes(vitals.rssBytes)}</Field>
              <Field label="Event-loop delay p99">
                {formatEventLoopDelay(vitals.eventLoopDelayP99Ms)}
              </Field>
              <Field label="Uptime">{formatUptime(vitals.uptimeSeconds)}</Field>
            </Stack>

            <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Field label="CLI version">{vitals.cliVersion ?? '—'}</Field>
              <Field label="Node.js version">{vitals.nodeVersion ?? '—'}</Field>
              <Field label="pg_dump version">{vitals.pgDumpVersion ?? '—'}</Field>
            </Stack>

            <Box>
              <Typography variant="subtitle2" component="h3" gutterBottom>
                Counters since the node process started
              </Typography>
              <Table size="small" aria-label="Node counters">
                <TableHead>
                  <TableRow>
                    <TableCell>Counter</TableCell>
                    <TableCell align="right">Count</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {VITALS_COUNTER_ROWS.map(({ key, label }) => (
                    <TableRow key={key}>
                      <TableCell component="th" scope="row">
                        {label}
                      </TableCell>
                      <TableCell align="right">{formatCount(vitals.counters?.[key])}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
