/**
 * A chart with its text alternatives (E5.9 Progress view): the chart itself
 * is `role="img"` named by a one-sentence summary, and a "Show data table"
 * toggle reveals the same numbers as a table. Colour is never the only
 * carrier of meaning: the summary and the table say everything the bars do.
 */
import { useId, useState, type ReactNode } from 'react';
import {
  Box,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
} from '@mui/material';
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined';

export interface ChartFrameProps {
  /** Names the chart image; also read as its description. */
  summary: string;
  /** What the table is about, for its accessible name and the toggle ("weekly adherence"). */
  tableLabel: string;
  columns: string[];
  rows: Array<Array<string | number>>;
  children: ReactNode;
}

/** Week start `YYYY-MM-DD` as "Sep 28", independent of the browser time zone. */
export function weekLabel(weekStart: string): string {
  const [y, m, d] = weekStart.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime())) return weekStart;
  return date.toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' });
}

export function ChartFrame({ summary, tableLabel, columns, rows, children }: ChartFrameProps) {
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  return (
    <Box sx={{ minWidth: 0 }}>
      <Box role="img" aria-label={summary} sx={{ minWidth: 0, width: '100%' }}>
        {children}
      </Box>
      <Button
        size="small"
        startIcon={<TableChartOutlinedIcon />}
        aria-expanded={showTable}
        aria-controls={tableId}
        onClick={() => setShowTable((v) => !v)}
        sx={{ mt: 0.5, minHeight: 44 }}
      >
        {showTable ? 'Hide data table' : 'Show data table'}
      </Button>
      {showTable && (
        <TableContainer id={tableId} sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label={tableLabel}>
            <TableHead>
              <TableRow>
                {columns.map((column) => (
                  <TableCell key={column} scope="col">
                    {column}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={index}>
                  {row.map((cell, cellIndex) =>
                    cellIndex === 0 ? (
                      <TableCell key={cellIndex} component="th" scope="row">
                        {cell}
                      </TableCell>
                    ) : (
                      <TableCell key={cellIndex}>{cell}</TableCell>
                    )
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}
