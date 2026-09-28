/**
 * The explorer's result grid — issue #537, epic #528.
 *
 * MUI X DataGrid directly rather than the app's `DataTable`: that wrapper is
 * built around a DECLARED column contract with server-side paging, sorting and
 * persisted layout, whereas a query result has columns nobody knew until it
 * ran. The grid is used with the app theme, client-side paging/sorting and a
 * bounded height so row virtualization works.
 *
 * Column names can repeat (`SELECT a.x, b.x`), so each column's field is its
 * POSITION (`c0`, `c1`, …) and rows are read positionally, as the API sends
 * them. A value in a column named `trace_id` is a link that opens that trace.
 */
import { useMemo } from 'react';
import { Box, Link, Typography } from '@mui/material';
import { DataGrid, type GridColDef, type GridRenderCellParams } from '@mui/x-data-grid';
import type { TelemetryQueryResult } from '../../services/telemetry';

export interface ResultsGridProps {
  result: TelemetryQueryResult;
  onTraceClick?: (traceId: string) => void;
}

type GridRow = { id: number } & Record<string, unknown>;

/** A cell value as text: strings as-is, objects as JSON, `null` as `NULL`. */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function fieldFor(index: number): string {
  return `c${index}`;
}

export function ResultsGrid({ result, onTraceClick }: ResultsGridProps) {
  const columns = useMemo<GridColDef<GridRow>[]>(
    () =>
      result.columns.map((column, index) => {
        const isTraceId = column.name.toLowerCase() === 'trace_id';
        return {
          field: fieldFor(index),
          headerName: column.name,
          // The pg wire protocol truncates timestamps to microseconds.
          description:
            column.type === 'timestamp'
              ? `${column.name} · timestamp (microseconds; use CAST(ts AS STRING) for nanoseconds)`
              : `${column.name} · ${column.type}`,
          minWidth: 120,
          flex: 1,
          sortable: true,
          valueFormatter: (value: unknown) => formatCellValue(value),
          renderCell: (params: GridRenderCellParams<GridRow>) => {
            const value = params.value;
            if (value === null || value === undefined) {
              return (
                <Typography component="span" variant="body2" color="text.disabled" sx={{ fontStyle: 'italic' }}>
                  NULL
                </Typography>
              );
            }
            const text = formatCellValue(value);
            if (isTraceId && onTraceClick && typeof value === 'string' && value) {
              return (
                <Link
                  component="button"
                  type="button"
                  variant="body2"
                  onClick={(event) => {
                    event.stopPropagation();
                    onTraceClick(value);
                  }}
                  sx={{ fontFamily: 'monospace' }}
                  title="Show this trace's spans and logs"
                >
                  {text}
                </Link>
              );
            }
            return (
              <Box component="span" title={text} sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {text}
              </Box>
            );
          },
        };
      }),
    [result.columns, onTraceClick],
  );

  const rows = useMemo<GridRow[]>(
    () =>
      result.rows.map((row, rowIndex) => {
        const entry: GridRow = { id: rowIndex };
        row.forEach((value, index) => {
          entry[fieldFor(index)] = value;
        });
        return entry;
      }),
    [result.rows],
  );

  return (
    <Box sx={{ height: { xs: 420, sm: 480 }, width: '100%', minWidth: 0 }}>
      <DataGrid
        rows={rows}
        columns={columns}
        density="compact"
        aria-label="Query results"
        disableColumnFilter
        disableRowSelectionOnClick
        pageSizeOptions={[25, 50, 100]}
        initialState={{ pagination: { paginationModel: { pageSize: 100, page: 0 } } }}
        sx={{
          '& .MuiDataGrid-cell': { fontFamily: 'monospace', fontSize: 13 },
          '& .MuiDataGrid-virtualScroller': { overflowX: 'auto' },
        }}
      />
    </Box>
  );
}
