/**
 * The explorer's schema browser — issue #537, epic #528.
 *
 * Tables from `GET /admin/telemetry/schema`, each expandable to its columns
 * and types. Clicking a table or column name inserts it (double-quoted when
 * needed — flattened attribute columns always are) at the editor's cursor.
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Collapse,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import type { TelemetrySchemaTable } from '../../services/telemetry';
import { quoteIdentifier } from './starterQueries';

export interface SchemaPanelProps {
  tables: TelemetrySchemaTable[];
  isLoading: boolean;
  error: string | null;
  onInsert: (text: string) => void;
}

export function SchemaPanel({ tables, isLoading, error, onInsert }: SchemaPanelProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState('');

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return tables;
    return tables.filter(
      (table) =>
        table.name.toLowerCase().includes(needle) ||
        table.columns.some((column) => column.name.toLowerCase().includes(needle)),
    );
  }, [tables, filter]);

  const toggle = (name: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <TextField
        size="small"
        placeholder="Filter tables and columns"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        slotProps={{ htmlInput: { 'aria-label': 'Filter schema' } }}
        sx={{ mb: 1 }}
      />
      {error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}
      {isLoading && (
        <Typography variant="body2" color="text.secondary">
          Loading schema…
        </Typography>
      )}
      {!isLoading && !error && visible.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          No tables.
        </Typography>
      )}
      <List dense disablePadding aria-label="Telemetry schema" sx={{ overflowY: 'auto', flex: 1 }}>
        {visible.map((table) => {
          const expanded = open.has(table.name) || filter.trim() !== '';
          return (
            <Box component="li" key={table.name} sx={{ listStyle: 'none' }}>
              <Box sx={{ display: 'flex', alignItems: 'center' }}>
                <IconButton
                  size="small"
                  onClick={() => toggle(table.name)}
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${table.name}`}
                  aria-expanded={expanded}
                >
                  {expanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
                </IconButton>
                <Tooltip title="Insert table name" placement="right">
                  <ListItemButton
                    dense
                    onClick={() => onInsert(quoteIdentifier(table.name))}
                    sx={{ py: 0, borderRadius: 1, minWidth: 0 }}
                  >
                    <ListItemText
                      primary={table.name}
                      secondary={
                        table.rows != null ? `${table.rows.toLocaleString()} rows` : undefined
                      }
                      slotProps={{
                        primary: { sx: { fontFamily: 'monospace', fontSize: 13, wordBreak: 'break-all' } },
                      }}
                    />
                  </ListItemButton>
                </Tooltip>
              </Box>
              <Collapse in={expanded} unmountOnExit>
                <List dense disablePadding sx={{ pl: 4 }} aria-label={`Columns of ${table.name}`}>
                  {table.columns.map((column, index) => (
                    <ListItemButton
                      key={`${column.name}-${index}`}
                      dense
                      onClick={() => onInsert(quoteIdentifier(column.name))}
                      sx={{ py: 0, borderRadius: 1 }}
                    >
                      <ListItemText
                        primary={column.name}
                        secondary={
                          column.semanticType ? `${column.type} · ${column.semanticType}` : column.type
                        }
                        slotProps={{
                          primary: { sx: { fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' } },
                          secondary: { sx: { fontSize: 11 } },
                        }}
                      />
                    </ListItemButton>
                  ))}
                </List>
              </Collapse>
            </Box>
          );
        })}
      </List>
    </Box>
  );
}
