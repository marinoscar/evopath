/**
 * A lab result's revisions, H5 (#189): the supersede chain of one reading
 * (`GET /api/measurements/:id/revisions`), newest (current) first. An edit
 * never overwrites a value; this is where the earlier ones are shown.
 */
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  Skeleton,
  Stack,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { useMeasurementRevisions } from '../../../hooks/useBiomarkers';
import { referenceRangeText } from '../../../services/labReport';
import { formatLabValue } from '../../../utils/biomarkers';
import { withUnit } from '../../../utils/measurementUnits';
import { formatDateTime } from '../../../utils/measurementDates';
import { LabFlagChip } from '../LabResultValue';

export const REVISION_HISTORY_TITLE = 'Value history';

const ORIGIN_LABELS: Record<string, string> = { manual: 'Entered by you', ai: 'Read from report' };

export function originLabel(origin: string): string {
  return ORIGIN_LABELS[origin] ?? origin;
}

export interface RevisionHistoryDialogProps {
  /** The reading to show; `null` = closed. */
  measurementId: string | null;
  label: string;
  decimals?: number;
  onClose: () => void;
}

export function RevisionHistoryDialog({ measurementId, label, decimals, onClose }: RevisionHistoryDialogProps) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const { data, isLoading, error, notFound, refresh } = useMeasurementRevisions(measurementId);
  const titleId = 'revision-history-title';

  const body = () => {
    if (notFound) return <Alert severity="info">This result is no longer available.</Alert>;
    if (error && !isLoading) {
      return (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={refresh}>
              Retry
            </Button>
          }
        >
          Could not load the history. {error}
        </Alert>
      );
    }
    if (!data) return <Skeleton variant="rounded" height={120} data-testid="revision-history-skeleton" />;
    return (
      <>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {data.length === 1
            ? 'This value has not been edited.'
            : `Edited ${data.length - 1} time${data.length === 2 ? '' : 's'}. Earlier values are kept, newest first.`}
        </Typography>
        <List aria-label="Revisions" disablePadding>
          {data.map((revision) => {
            const range = referenceRangeText(revision);
            const current = revision.supersededAt === null;
            return (
              <ListItem
                key={revision.id}
                divider
                disableGutters
                data-testid="revision-item"
                sx={{ display: 'block', py: 1.25 }}
              >
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  <Typography sx={{ fontWeight: 600 }}>
                    {withUnit(formatLabValue(revision.value, decimals), revision.unit)}
                  </Typography>
                  <LabFlagChip flag={revision.flag} />
                  {current ? (
                    <Chip size="small" color="primary" label="Current" />
                  ) : (
                    <Chip size="small" variant="outlined" label={`Revision ${revision.revision}`} />
                  )}
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  Taken {formatDateTime(revision.measuredAt)}
                  {range ? ` · Range ${range}` : ''} · {originLabel(revision.origin)}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  Saved {formatDateTime(revision.createdAt)}
                  {revision.supersededAt ? ` · Replaced ${formatDateTime(revision.supersededAt)}` : ''}
                </Typography>
              </ListItem>
            );
          })}
        </List>
      </>
    );
  };

  return (
    <Dialog
      open={measurementId !== null}
      onClose={onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby={titleId}
    >
      <DialogTitle id={titleId}>
        {REVISION_HISTORY_TITLE}
        <Box component="span" sx={{ display: 'block', typography: 'body2', color: 'text.secondary' }}>
          {label}
        </Box>
      </DialogTitle>
      <DialogContent>{body()}</DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

export default RevisionHistoryDialog;
