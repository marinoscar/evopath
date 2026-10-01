/**
 * Every result of one lab analyte, H5 (#189), newest first: date, value,
 * unit, the printed range, the lab's flag, where the value came from and the
 * source report. A value is a button that opens its revision history.
 *
 * At `sm` and up it is a table; below it (a phone) each result is a card, so
 * nothing scrolls sideways. A local layout choice, NOT one of the five coupled
 * `sm` shell gates (docs/specs/settings-ui.md#breakpoint-gates).
 */
import {
  Box,
  Button,
  Chip,
  List,
  ListItem,
  Stack,
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
import type { LabMeasurement } from '../../../services/biomarkers';
import { referenceRangeText } from '../../../services/labReport';
import { formatLabValue } from '../../../utils/biomarkers';
import { withUnit } from '../../../utils/measurementUnits';
import { LabFlagChip } from '../LabResultValue';
import { SourceDocumentLink } from './SourceDocumentLink';
import { originLabel } from './RevisionHistoryDialog';

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export interface BiomarkerResultsProps {
  label: string;
  decimals?: number;
  rows: readonly LabMeasurement[];
  onShowHistory: (row: LabMeasurement) => void;
}

function ValueButton({
  row,
  label,
  decimals,
  onShowHistory,
}: {
  row: LabMeasurement;
  label: string;
  decimals?: number;
  onShowHistory: (row: LabMeasurement) => void;
}) {
  const value = formatLabValue(row.value, decimals);
  return (
    <Button
      size="small"
      onClick={() => onShowHistory(row)}
      aria-label={`${label} ${withUnit(value, row.unit)} on ${formatDate(row.measuredAt)}: show value history`}
      aria-haspopup="dialog"
      sx={{ minWidth: 0, minHeight: 32, px: 1, fontWeight: 600, fontSize: '0.95rem', textTransform: 'none' }}
    >
      {value}
    </Button>
  );
}

export function BiomarkerResults({ label, decimals, rows, onShowHistory }: BiomarkerResultsProps) {
  const theme = useTheme();
  const compact = useMediaQuery(theme.breakpoints.down('sm'));

  if (compact) {
    return (
      <List aria-label={`${label} results`} disablePadding data-testid="biomarker-results-cards">
        {rows.map((row) => {
          const range = referenceRangeText(row);
          const when = formatDate(row.measuredAt);
          return (
            <ListItem key={row.id} divider disableGutters sx={{ display: 'block', py: 1 }} data-testid="biomarker-result">
              <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 1 }}>
                <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
                  {when}
                </Typography>
                <LabFlagChip flag={row.flag} />
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 0.5 }}>
                <ValueButton row={row} label={label} decimals={decimals} onShowHistory={onShowHistory} />
                <Typography component="span">{row.unit}</Typography>
                {row.edited && <Chip size="small" label="Edited" sx={{ ml: 1 }} />}
              </Box>
              <Typography variant="body2" color="text.secondary">
                {range ? `Range ${range}` : 'No range printed'} · {originLabel(row.origin)}
              </Typography>
              <Box sx={{ mt: 0.5 }}>
                <SourceDocumentLink row={row} describedAs={`${label} result from ${when}`} />
              </Box>
            </ListItem>
          );
        })}
      </List>
    );
  }

  return (
    <TableContainer>
      <Table size="small" aria-label={`${label} results`} data-testid="biomarker-results-table">
        <TableHead>
          <TableRow>
            <TableCell>Date</TableCell>
            <TableCell align="right">Value</TableCell>
            <TableCell>Unit</TableCell>
            <TableCell>Range</TableCell>
            <TableCell>Flag</TableCell>
            <TableCell>Origin</TableCell>
            <TableCell>Source</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => {
            const when = formatDate(row.measuredAt);
            return (
              <TableRow key={row.id} data-testid="biomarker-result">
                <TableCell sx={{ whiteSpace: 'nowrap' }}>{when}</TableCell>
                <TableCell align="right">
                  <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end', alignItems: 'center' }}>
                    {row.edited && <Chip size="small" label="Edited" />}
                    <ValueButton row={row} label={label} decimals={decimals} onShowHistory={onShowHistory} />
                  </Stack>
                </TableCell>
                <TableCell>{row.unit}</TableCell>
                <TableCell>{referenceRangeText(row) ?? '—'}</TableCell>
                <TableCell>{row.flag ? <LabFlagChip flag={row.flag} /> : '—'}</TableCell>
                <TableCell>{originLabel(row.origin)}</TableCell>
                <TableCell>
                  <SourceDocumentLink row={row} describedAs={`${label} result from ${when}`} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export default BiomarkerResults;
