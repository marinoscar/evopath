/**
 * A `/metrics` table, formatted by column unit — issue #127, epic #576.
 *
 * The API decides the rows and columns (`tables[]`: a key column, one column
 * per catalog part, `lastSeenAt`); this only presents them. Each cell is
 * formatted by its column's unit (`format.ts`), `null` reads "—", and a column
 * the caller asks for but the response lacks is skipped rather than shown
 * empty. A caller may override a column's rendering (a utilization bar, an
 * Up/Down status) or add a virtual column (slots "used / total").
 *
 * The table is labelled by its caption; it scrolls sideways inside its own
 * box on a narrow screen, never the page.
 */
import type { ReactNode } from 'react';
import {
  Box,
  LinearProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import type {
  DashboardMetricCell,
  DashboardMetricColumn,
  DashboardMetricTable,
} from '../../../../services/telemetryDashboard';
import { formatMetricValue, formatTimestamp } from '../format';

type Row = Record<string, DashboardMetricCell>;

export interface MetricTableColumnSpec {
  /** A column key of the response, or a virtual key when `render` is given. */
  key: string;
  /** Header text; defaults to the response's column label. */
  label?: string;
  /** Custom cell. Without it the value is formatted by the column's unit. */
  render?: (row: Row, column: DashboardMetricColumn | undefined) => ReactNode;
  /** Only drawn when every one of these response columns exists (for virtual columns). */
  requires?: string[];
}

export interface MetricTableProps {
  table: DashboardMetricTable;
  /** Columns in order. Default: every response column. */
  columns?: MetricTableColumnSpec[];
  /** Rows first, e.g. failing URLs before healthy ones. Stable otherwise. */
  sortRows?: (a: Row, b: Row) => number;
  emptyMessage?: string;
  /** For relative "Last reading" times. */
  now?: number;
}

const NUMERIC_UNITS = new Set(['%', 'bytes', 'bytes/s', 'count', 'per_s', 'per_min', 'ms', 'seconds', 'hours', 'days', 'cores', 'load']);

function formatCell(value: DashboardMetricCell, column: DashboardMetricColumn | undefined, now: number): ReactNode {
  if (!column) return formatMetricValue(value, 'text', now);
  if (column.unit === 'timestamp') {
    if (typeof value !== 'string') return '—';
    return (
      <Box component="span" title={formatTimestamp(value)}>
        {formatMetricValue(value, 'timestamp', now)}
      </Box>
    );
  }
  return formatMetricValue(value, column.unit, now);
}

/**
 * A utilization bar with its number beside it: the text carries the value,
 * the bar only echoes it (warning from `warnAt`, error from `criticalAt`,
 * which mirror the verdict thresholds).
 */
export function UtilizationBar({
  value,
  label,
  warnAt = 85,
  criticalAt = 95,
}: {
  value: DashboardMetricCell;
  label: string;
  warnAt?: number;
  criticalAt?: number;
}) {
  if (typeof value !== 'number') return <>—</>;
  const pct = Math.min(Math.max(value, 0), 100);
  const color = value >= criticalAt ? 'error' : value >= warnAt ? 'warning' : 'primary';
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 120 }}>
      <LinearProgress
        variant="determinate"
        value={pct}
        color={color}
        aria-label={label}
        sx={{ flex: 1, height: 8, borderRadius: 1 }}
      />
      <Box component="span" sx={{ minWidth: 48, textAlign: 'right' }}>
        {formatMetricValue(value, '%')}
      </Box>
    </Box>
  );
}

/**
 * A status as an icon AND a word, never colour alone: `ok` true → `okText`,
 * false → `badText`, null → "—".
 */
export function StatusCell({ ok, okText, badText }: { ok: DashboardMetricCell; okText: string; badText: string }) {
  if (typeof ok !== 'boolean') return <>—</>;
  const Icon = ok ? CheckCircleOutlineIcon : ErrorOutlineIcon;
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        color: ok ? 'success.main' : 'error.main',
        fontWeight: ok ? 400 : 600,
        whiteSpace: 'nowrap',
      }}
    >
      <Icon aria-hidden sx={{ fontSize: 16 }} />
      {ok ? okText : badText}
    </Box>
  );
}

export function MetricTable({
  table,
  columns,
  sortRows,
  emptyMessage = 'nothing reported in this window.',
  now = Date.now(),
}: MetricTableProps) {
  const byKey = new Map(table.columns.map((column) => [column.key, column]));
  const specs: MetricTableColumnSpec[] = (
    columns ?? table.columns.map((column): MetricTableColumnSpec => ({ key: column.key }))
  ).filter(
    (spec) => (spec.render ? (spec.requires ?? []).every((key) => byKey.has(key)) : byKey.has(spec.key)),
  );
  const rows = sortRows ? [...table.rows].sort(sortRows) : table.rows;
  const captionId = `metric-table-${table.key}`;

  if (rows.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
        {table.label}: {emptyMessage}
      </Typography>
    );
  }

  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography id={captionId} variant="subtitle2" component="h3" sx={{ mb: 0.5 }}>
        {table.label}
      </Typography>
      <TableContainer sx={{ overflowX: 'auto', maxWidth: '100%' }}>
        <Table size="small" aria-labelledby={captionId} data-testid={`metric-table-${table.key}`}>
          <TableHead>
            <TableRow>
              {specs.map((spec) => {
                const column = byKey.get(spec.key);
                return (
                  <TableCell
                    key={spec.key}
                    align={column && NUMERIC_UNITS.has(column.unit) && !spec.render ? 'right' : 'left'}
                    sx={{ whiteSpace: 'nowrap' }}
                  >
                    {spec.label ?? column?.label ?? spec.key}
                  </TableCell>
                );
              })}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow key={`${String(row.key)}-${index}`}>
                {specs.map((spec, columnIndex) => {
                  const column = byKey.get(spec.key);
                  const content = spec.render ? spec.render(row, column) : formatCell(row[spec.key] ?? null, column, now);
                  const numeric = column && NUMERIC_UNITS.has(column.unit) && !spec.render;
                  return (
                    <TableCell
                      key={spec.key}
                      component={columnIndex === 0 ? 'th' : 'td'}
                      scope={columnIndex === 0 ? 'row' : undefined}
                      align={numeric ? 'right' : 'left'}
                      sx={{
                        whiteSpace: numeric ? 'nowrap' : 'normal',
                        // The key (a URL, a job type) keeps a readable width and wraps only past it.
                        ...(columnIndex === 0 && {
                          minWidth: { xs: 120, sm: 160 },
                          maxWidth: 320,
                          overflowWrap: 'anywhere',
                          fontWeight: 500,
                        }),
                        ...(column?.unit === 'text' &&
                          columnIndex !== 0 && { minWidth: 80, maxWidth: 280, overflowWrap: 'anywhere' }),
                      }}
                    >
                      {content}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
