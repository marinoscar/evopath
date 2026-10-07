/**
 * Worker node VITALS on the Workers page (issue #131, epic B; API side #129).
 *
 * A node reports a small health snapshot on its heartbeat — CPU, memory, disk
 * in its state directory, slots, uptime, versions and cumulative counters —
 * and `GET /api/admin/nodes` returns the last one as `lastVitals` beside
 * `lastVitalsAt`. This module is everything the page does with it: pure
 * formatters and fleet arithmetic (unit-tested without a render), plus the one
 * compact cell the fleet table draws.
 *
 * =============================================================================
 * THREE RULES
 * =============================================================================
 *
 *  1. DISPLAY ONLY. Vitals are self-reported by the node. The API bounds them
 *     and never schedules on them; neither does this page. Nothing here turns a
 *     number into a verdict about the node beyond "low disk", which is labelled
 *     as a reading, not a health state.
 *
 *  2. ABSENT IS NOT ZERO. Every field is optional — a node reports what it can
 *     measure — so a missing field renders as "—" (or is left out of a
 *     sentence), never as `0`. A confident "0% CPU" for a node that simply did
 *     not send the field is a false reading.
 *
 *  3. FRESHNESS IS THE API'S HEALTH VERDICT, NOT A CLOCK IN THIS FILE. Vitals
 *     arrive on the heartbeat, so they are exactly as fresh as the heartbeat.
 *     The page already has the API's verdict on that (`node.health`, computed
 *     against the `nodes.staleHeartbeatSeconds` system setting — see
 *     `WorkersPage.tsx`'s header on why no threshold is ever invented here).
 *     A node that is not `healthy` has its vitals greyed AND labelled with its
 *     health ("Stale", "Offline"), so the signal never rests on colour alone.
 */

import HistoryIcon from '@mui/icons-material/History';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { Box, Stack, Tooltip, Typography } from '@mui/material';
import type { NodeVitals, WorkerNode } from '../../services/nodes';
import { formatBytes } from '@marinoscar/platform-web/telemetry/headless';
import { formatRelativeTime } from '../../utils/relativeTime';
import { formatDuration } from './jobsTable';

// Re-exported so the detail dialog and the tests format bytes with the one
// formatter the page uses, rather than importing it from the telemetry module.
export { formatBytes };

/** Below this fraction of the state directory free, a node counts as "low disk". */
export const LOW_DISK_FREE_RATIO = 0.1;

// =============================================================================
// Pure helpers
// =============================================================================

/** `used / total`, or `null` when either is missing or the total is not positive. */
export function ratio(used: number | undefined, total: number | undefined): number | null {
  if (used === undefined || total === undefined || !Number.isFinite(used) || !(total > 0)) {
    return null;
  }
  return used / total;
}

/** A 0..1 fraction as a whole percentage, "—" when unknown. */
export function formatPercent(fraction: number | null): string {
  return fraction === null ? '—' : `${Math.round(fraction * 100)}%`;
}

/**
 * Process CPU. `100` is one full core, so a busy multi-threaded node can read
 * `250%` — printed as is, because capping it at 100 would hide exactly the
 * node that is using more than its share.
 */
export function formatCpu(cpuPercent: number | undefined): string {
  if (cpuPercent === undefined || !Number.isFinite(cpuPercent)) return '—';
  return `${cpuPercent < 10 ? cpuPercent.toFixed(1) : Math.round(cpuPercent)}%`;
}

/** Byte count, or "—" when the node did not report it. */
export function formatOptionalBytes(bytes: number | undefined): string {
  return bytes === undefined || !Number.isFinite(bytes) ? '—' : formatBytes(bytes);
}

/** Uptime in the same vocabulary as every other duration in the admin pages. */
export function formatUptime(seconds: number | undefined): string {
  return seconds === undefined ? '—' : formatDuration(seconds * 1000);
}

/** Event-loop delay p99, milliseconds. */
export function formatEventLoopDelay(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
}

/** Free fraction of the state directory's filesystem, or `null` when unknown. */
export function diskFreeRatio(vitals: NodeVitals): number | null {
  return ratio(vitals.stateDirFreeBytes, vitals.stateDirTotalBytes);
}

/** Whether the last report shows the state directory under 10% free. */
export function isLowDisk(vitals: NodeVitals | null): boolean {
  if (!vitals) return false;
  const free = diskFreeRatio(vitals);
  return free !== null && free < LOW_DISK_FREE_RATIO;
}

/** "Slots 1/4", or `null` when the node did not report both halves. */
export function formatSlots(vitals: NodeVitals): string | null {
  if (vitals.slotsUsed === undefined || vitals.slotsTotal === undefined) return null;
  return `${vitals.slotsUsed}/${vitals.slotsTotal}`;
}

/**
 * Whether the node's vitals should be read as out of date.
 *
 * The API's health verdict and nothing else — see rule 3 in the header.
 */
export function areVitalsStale(node: WorkerNode): boolean {
  return node.health !== 'healthy';
}

/**
 * The word printed beside greyed vitals — the node's own health, capitalised
 * ("Stale", "Offline"), so the grey is never the only signal and an offline
 * node is not mislabelled as merely stale.
 */
export function staleLabel(node: WorkerNode): string {
  return node.health.charAt(0).toUpperCase() + node.health.slice(1);
}

/** "Vitals reported 3 minutes ago", or `null` when there is no timestamp. */
export function formatVitalsReported(iso: string | null, now: Date): string | null {
  return iso ? `Vitals reported ${formatRelativeTime(iso, now).toLowerCase()}` : null;
}

export interface FleetSaturation {
  used: number;
  total: number;
  /** How many nodes contributed — healthy, with both slot figures reported. */
  reporting: number;
  /** `used / total`, or `null` when no node contributed. */
  fraction: number | null;
}

/**
 * Slots in use across the fleet: Σ slotsUsed / Σ slotsTotal over HEALTHY nodes
 * that reported both figures.
 *
 * Healthy only, because a stale or offline node's last report describes work
 * it may no longer be doing — counting it would show a fleet busier (or
 * roomier) than it is. The number of contributing nodes travels with the
 * answer so the tile can say what it is a fraction OF.
 */
export function fleetSaturation(nodes: WorkerNode[]): FleetSaturation {
  let used = 0;
  let total = 0;
  let reporting = 0;
  for (const node of nodes) {
    const vitals = node.lastVitals;
    if (node.health !== 'healthy' || !vitals) continue;
    if (vitals.slotsUsed === undefined || vitals.slotsTotal === undefined) continue;
    used += vitals.slotsUsed;
    total += vitals.slotsTotal;
    reporting += 1;
  }
  return { used, total, reporting, fraction: total > 0 ? used / total : null };
}

/**
 * Nodes whose last report shows the state directory under 10% free.
 *
 * Offline nodes are left out (nothing is running there to fill the disk);
 * stale ones are kept, because a node that went quiet WITH a full disk is the
 * likeliest reason it went quiet.
 */
export function countLowDisk(nodes: WorkerNode[]): number {
  return nodes.filter((node) => node.health !== 'offline' && isLowDisk(node.lastVitals)).length;
}

/**
 * The vitals as one line of text — the column's scalar, and so what the CSV
 * export writes. Fields the node did not report are left out of the sentence.
 */
export function vitalsSummaryText(node: WorkerNode): string {
  const vitals = node.lastVitals;
  if (!vitals) return 'No vitals';
  const parts: string[] = [];
  if (vitals.cpuPercent !== undefined) parts.push(`CPU ${formatCpu(vitals.cpuPercent)}`);
  if (vitals.rssBytes !== undefined) parts.push(`RSS ${formatBytes(vitals.rssBytes)}`);
  const heap = ratio(vitals.heapUsedBytes, vitals.heapLimitBytes);
  if (heap !== null) parts.push(`Heap ${formatPercent(heap)}`);
  const disk = diskFreeRatio(vitals);
  if (disk !== null) parts.push(`Disk ${formatPercent(disk)} free`);
  const slots = formatSlots(vitals);
  if (slots !== null) parts.push(`Slots ${slots}`);
  if (parts.length === 0) return 'No vitals';
  return areVitalsStale(node) ? `${staleLabel(node)}: ${parts.join(' · ')}` : parts.join(' · ');
}

// =============================================================================
// The fleet-table cell
// =============================================================================

interface NodeVitalsCellProps {
  node: WorkerNode;
  now: Date;
}

/**
 * Two compact lines: CPU and slots, then memory and disk.
 *
 * Two lines because that is what the row already holds (the name cell is name
 * over hostname); a third would make every row taller for the sake of one
 * column. Bars live in the detail dialog, where there is room for their labels.
 */
export function NodeVitalsCell({ node, now }: NodeVitalsCellProps) {
  const vitals = node.lastVitals;
  const testId = `node-vitals-${node.id}`;

  if (!vitals) {
    return (
      <Typography variant="body2" color="text.secondary" noWrap data-testid={testId}>
        No vitals
      </Typography>
    );
  }

  const stale = areVitalsStale(node);
  const slots = formatSlots(vitals);
  const heap = ratio(vitals.heapUsedBytes, vitals.heapLimitBytes);
  const disk = diskFreeRatio(vitals);
  const lowDisk = isLowDisk(vitals);
  const reported = formatVitalsReported(node.lastVitalsAt, now);

  // Absent fields are left out, exactly as `vitalsSummaryText` leaves them
  // out — never "CPU —" in the cell beside "No vitals" in the CSV.
  const lineOne = [
    vitals.cpuPercent !== undefined ? `CPU ${formatCpu(vitals.cpuPercent)}` : null,
    slots !== null ? `Slots ${slots}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const memory =
    vitals.rssBytes !== undefined
      ? `Mem ${formatBytes(vitals.rssBytes)}${heap !== null ? ` (heap ${formatPercent(heap)})` : ''}`
      : heap !== null
        ? `Heap ${formatPercent(heap)}`
        : null;
  const diskText = disk !== null ? `Disk ${formatPercent(disk)} free` : null;

  // A snapshot with nothing the compact cell shows (versions or counters only)
  // reads as "No vitals" here, the same as the CSV; the dialog still has it.
  if (!lineOne && !memory && !diskText) {
    return (
      <Typography variant="body2" color="text.secondary" noWrap data-testid={testId}>
        No vitals
      </Typography>
    );
  }
  const label = staleLabel(node);

  return (
    <Tooltip
      title={stale && reported ? `${label} — last ${reported.toLowerCase()}` : (reported ?? '')}
    >
      <Stack
        data-testid={testId}
        data-stale={stale ? 'true' : 'false'}
        sx={{ minWidth: 0, color: stale ? 'text.disabled' : 'text.primary' }}
      >
        {(stale || lineOne) && (
          <Typography variant="body2" noWrap sx={{ color: 'inherit' }}>
            {stale && (
              // Word AND icon, not just grey: the greying is the secondary cue.
              <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', mr: 0.5 }}>
                <HistoryIcon fontSize="inherit" aria-hidden sx={{ mr: 0.25 }} />
                {label}
                {lineOne ? ' · ' : ''}
              </Box>
            )}
            {lineOne}
          </Typography>
        )}
        {(memory || diskText) && (
          <Typography variant="caption" noWrap sx={{ color: stale ? 'inherit' : 'text.secondary' }}>
            {memory}
            {memory && diskText ? ' · ' : ''}
            {diskText && (
              <Box
                component="span"
                sx={{
                  color: lowDisk && !stale ? 'warning.main' : 'inherit',
                  display: 'inline-flex',
                  alignItems: 'center',
                }}
              >
                {lowDisk && <WarningAmberIcon fontSize="inherit" aria-hidden sx={{ mr: 0.25 }} />}
                {diskText}
                {lowDisk ? ' (low)' : ''}
              </Box>
            )}
          </Typography>
        )}
      </Stack>
    </Tooltip>
  );
}
