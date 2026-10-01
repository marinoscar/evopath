/**
 * What Health Connect holds, as the phone saw it (#283 scope update): per
 * data type the permission, the records in the last 30 days ("1000+" when the
 * phone stopped counting), the latest record and the apps that wrote it; and
 * the apps feeding Health Connect at all.
 *
 * A row with permission granted but no records is highlighted: that is the
 * "enabled but nothing shared" failure, where the source app (Samsung Health,
 * say) is not writing that type into Health Connect.
 *
 * A table from `sm` up; a list below it, so the dialog never scrolls sideways.
 */
import {
  Box,
  Chip,
  List,
  ListItem,
  ListItemText,
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
import { alpha, type Theme } from '@mui/material/styles';
import {
  isGrantedButEmpty,
  type HealthConnectInventoryRow,
  type HealthConnectSource,
} from '../../../services/healthSync';
import { formatDateTime } from './format';

export const EMPTY_TYPE_HINT =
  'Permission granted but no records in the last 30 days: the source app is probably not sharing this type with Health Connect.';

/** A tint that reads in both themes, unlike `warning.light` under dark text. */
const emptyTint = (theme: Theme) => alpha(theme.palette.warning.main, 0.14);

function countLabel(row: HealthConnectInventoryRow): string {
  return row.capped ? `${row.recordCount30d}+` : String(row.recordCount30d);
}

function sourcesLabel(row: HealthConnectInventoryRow): string {
  const sources = row.sources ?? [];
  if (sources.length === 0) return '—';
  return sources.map((s) => s.appLabel || s.packageName).join(', ');
}

function PermissionChip({ permission }: { permission: string }) {
  const granted = permission === 'granted';
  return (
    <Chip
      size="small"
      variant="outlined"
      color={granted ? 'success' : 'error'}
      label={granted ? 'Granted' : permission === 'denied' ? 'Denied' : permission}
    />
  );
}

export function InventoryTable({ rows }: { rows: HealthConnectInventoryRow[] }) {
  const theme = useTheme();
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));

  if (isCompactWindow) {
    return (
      <List dense disablePadding aria-label="Health Connect data">
        {rows.map((row) => {
          const empty = isGrantedButEmpty(row);
          return (
            <ListItem
              key={row.dataType}
              divider
              disableGutters
              data-testid={`inventory-${row.dataType}`}
              data-empty={empty ? 'true' : undefined}
              sx={{ display: 'block', ...(empty && { bgcolor: emptyTint, px: 1, borderRadius: 1 }) }}
            >
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  {row.dataType}
                </Typography>
                <PermissionChip permission={row.permission} />
              </Box>
              <Typography variant="body2" color="text.secondary">
                {countLabel(row)} records · latest {formatDateTime(row.latestRecordAt)} · {sourcesLabel(row)}
              </Typography>
              {empty && (
                <Typography variant="body2" color="warning.main">
                  {EMPTY_TYPE_HINT}
                </Typography>
              )}
            </ListItem>
          );
        })}
      </List>
    );
  }

  return (
    <TableContainer>
      <Table size="small" aria-label="Health Connect data">
        <TableHead>
          <TableRow>
            <TableCell>Data type</TableCell>
            <TableCell>Permission</TableCell>
            <TableCell align="right">Records (30 days)</TableCell>
            <TableCell>Latest record</TableCell>
            <TableCell>Sources</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => {
            const empty = isGrantedButEmpty(row);
            return (
              <TableRow
                key={row.dataType}
                data-testid={`inventory-${row.dataType}`}
                data-empty={empty ? 'true' : undefined}
                sx={empty ? { bgcolor: emptyTint } : undefined}
                title={empty ? EMPTY_TYPE_HINT : undefined}
              >
                <TableCell>{row.dataType}</TableCell>
                <TableCell>
                  <PermissionChip permission={row.permission} />
                </TableCell>
                <TableCell align="right">{countLabel(row)}</TableCell>
                <TableCell>{formatDateTime(row.latestRecordAt)}</TableCell>
                <TableCell sx={{ overflowWrap: 'anywhere' }}>{sourcesLabel(row)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {rows.some(isGrantedButEmpty) && (
        <Typography variant="body2" color="warning.main" sx={{ mt: 1 }}>
          Highlighted: {EMPTY_TYPE_HINT}
        </Typography>
      )}
    </TableContainer>
  );
}

export function SourcesList({ sources }: { sources: HealthConnectSource[] }) {
  return (
    <List dense disablePadding aria-label="Health Connect sources">
      {sources.map((source) => (
        <ListItem key={source.packageName} divider disableGutters>
          <ListItemText
            primary={source.appLabel || source.packageName}
            secondary={[
              source.appLabel ? source.packageName : null,
              source.dataTypes?.length ? source.dataTypes.join(', ') : null,
              source.recordCount !== undefined ? `${source.recordCount} records` : null,
              source.latestRecordAt ? `latest ${formatDateTime(source.latestRecordAt)}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            slotProps={{ secondary: { sx: { overflowWrap: 'anywhere' } } }}
          />
        </ListItem>
      ))}
    </List>
  );
}
