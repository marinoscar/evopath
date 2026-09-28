/**
 * One AI usage grouping as a table (issue #444) — the shared `DataTable`, so a
 * phone gets the card renderer rather than a horizontally scrolling grid.
 *
 * Nothing is `sortable`: these rows are the whole result, not a page of a
 * server-side query, and arrive ordered the way the API chose (busiest first,
 * or by date for `day`).
 */
import { useMemo } from 'react';
import { Typography } from '@mui/material';
import { DataTable } from '../../datatable';
import type { DataTableColumn } from '../../datatable';
import type { AiUsageSeriesEntry } from '../../../services/ai';
import { formatCount, formatFailureRate, formatUnits, formatUsageDay } from './aiUsageFormat';

export interface AiUsageTableProps {
  rows: AiUsageSeriesEntry[];
  /** Header of the grouping column ("User", "Model", "Day", …). */
  keyLabel: string;
  /** Render `key` as a day (`Sep 24`) rather than `label`. */
  isDay?: boolean;
  /** Persistence key for `user_settings.dataTables`. */
  tableId: string;
  ariaLabel: string;
  emptyText: string;
  csvFilename?: string;
  'data-testid'?: string;
}

export function AiUsageTable({
  rows,
  keyLabel,
  isDay = false,
  tableId,
  ariaLabel,
  emptyText,
  csvFilename,
  'data-testid': testId,
}: AiUsageTableProps) {
  const hasUnits = rows.some((row) => formatUnits(row.units) !== null);

  const columns = useMemo<DataTableColumn<AiUsageSeriesEntry>[]>(() => {
    const cols: DataTableColumn<AiUsageSeriesEntry>[] = [
      {
        id: 'label',
        label: keyLabel,
        priority: 'primary',
        hideable: false,
        minWidth: 160,
        flex: 1,
        value: (row) => (isDay ? formatUsageDay(row.key) : row.label || row.key),
      },
      {
        id: 'requests',
        label: 'Requests',
        priority: 'primary',
        align: 'right',
        width: 110,
        value: (row) => row.requests,
        render: (row) => formatCount(row.requests),
      },
      {
        id: 'failureRate',
        label: 'Failure rate',
        priority: 'secondary',
        align: 'right',
        width: 120,
        value: (row) => formatFailureRate(row),
        render: (row) => `${formatFailureRate(row)} (${formatCount(row.failed)})`,
      },
      {
        id: 'inputTokens',
        label: 'Input tokens',
        priority: 'secondary',
        align: 'right',
        width: 130,
        value: (row) => row.inputTokens,
        render: (row) => formatCount(row.inputTokens),
      },
      {
        id: 'outputTokens',
        label: 'Output tokens',
        priority: 'secondary',
        align: 'right',
        width: 130,
        value: (row) => row.outputTokens,
        render: (row) => formatCount(row.outputTokens),
      },
      {
        id: 'reasoningTokens',
        label: 'Reasoning tokens',
        priority: 'detail',
        align: 'right',
        width: 150,
        value: (row) => row.reasoningTokens,
        render: (row) => formatCount(row.reasoningTokens),
      },
      {
        id: 'cachedInputTokens',
        label: 'Cached input tokens',
        priority: 'detail',
        align: 'right',
        width: 170,
        value: (row) => row.cachedInputTokens,
        render: (row) => formatCount(row.cachedInputTokens),
      },
    ];
    if (hasUnits) {
      cols.push({
        id: 'units',
        label: 'Other units',
        priority: 'detail',
        width: 180,
        value: (row) => formatUnits(row.units) ?? '',
      });
    }
    return cols;
  }, [keyLabel, isDay, hasUnits]);

  return (
    <DataTable<AiUsageSeriesEntry>
      tableId={tableId}
      data-testid={testId}
      ariaLabel={ariaLabel}
      columns={columns}
      rows={rows}
      rowId={(row) => row.key}
      emptyState={<Typography color="text.secondary">{emptyText}</Typography>}
      {...(csvFilename ? { csvExport: { filename: csvFilename } } : { disableExport: true })}
    />
  );
}
