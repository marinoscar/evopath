/**
 * History: every body and vital entry, newest first, issue #60 (E2.5).
 *
 * One row per ENTRY (a blood-pressure pair is `128/84 mmHg`, weight + body fat
 * is one row with both), grouped in the client and merged across `Load more`
 * pages (`useMeasurements`). Each row carries the date and time, the readings
 * in the user's units, a method chip per reading (none for `unspecified`),
 * `Edited` when revised, the origin, the note, and Edit/Delete.
 *
 * Photo provenance (issue #64, E2.6): an entry with a reading the AI read
 * off a photo (`origin: 'ai'`) shows "Read from photo" instead of the origin,
 * "You edited" when a saved value differs from what the AI read
 * (`sourceRef.userEdited`, kept current by the API on every edit), and
 * "View photo", which shows the first source photo through a short-lived
 * signed URL (`GET /api/storage/objects/:id/download`). When the user chose
 * to erase the file after processing (#185, `fileDeleted: true`), the entry
 * shows "File deleted" instead of "View photo"; the values and provenance stay.
 *
 * This list is also the text equivalent of the Trend chart above it.
 * `health_data:write` only enables the actions; the API enforces it.
 */

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Link,
  List,
  ListItem,
  MenuItem,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import HistoryIcon from '@mui/icons-material/History';
import PhotoCameraOutlinedIcon from '@mui/icons-material/PhotoCameraOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import HideImageOutlinedIcon from '@mui/icons-material/HideImageOutlined';
import {
  AI_READ_ORIGIN,
  HEALTH_DATA_UNAVAILABLE,
  photoSourceRef,
  type MetricDef,
  type UnitSystem,
} from '../../services/health';
import { ApiError } from '../../services/api';
import { getStorageObjectDownloadUrl } from '../../services/storage';
import { useMeasurements } from '../../hooks/useMeasurements';
import { EmptyState } from '../common/EmptyState';
import {
  describeEntry,
  metricChoices,
  spokenList,
  type HistoryEntry,
} from '../../utils/measurementSeries';
import { formatDateTime, formatShortDate, formatShortTime } from '../../utils/measurementDates';

export const NO_EDIT_PERMISSION_TOOLTIP = "You don't have permission to change health data";

/** What an origin reads as. An AI-read entry shows the "Read from photo" chip instead. */
const ORIGIN_LABELS: Record<string, string> = { manual: 'Manual' };

export const READ_FROM_PHOTO_CHIP = 'Read from photo';
export const USER_EDITED_CHIP = 'You edited';
export const FILE_DELETED_CHIP = 'File deleted';

/**
 * The photo provenance of an entry: any AI-read reading, edited or not, its
 * first photo still stored, and whether a source file was erased after
 * processing (#185).
 */
export function entryPhotoProvenance(entry: HistoryEntry): {
  readFromPhoto: boolean;
  userEdited: boolean;
  photoId: string | null;
  fileDeleted: boolean;
} {
  const aiRows = entry.readings.filter((reading) => reading.origin === AI_READ_ORIGIN);
  const refs = aiRows.map((reading) => photoSourceRef(reading)).filter((ref) => ref !== null);
  // An erased file has no photo to view any more.
  const storedRefs = aiRows
    .filter((reading) => reading.fileDeleted !== true)
    .map((reading) => photoSourceRef(reading))
    .filter((ref) => ref !== null);
  return {
    readFromPhoto: aiRows.length > 0,
    userEdited: refs.some((ref) => ref.userEdited === true),
    photoId: storedRefs.flatMap((ref) => ref.storageObjectIds ?? [])[0] ?? null,
    fileDeleted: entry.readings.some((reading) => reading.fileDeleted === true),
  };
}

/**
 * The stored photo of an entry, in a dialog. The signed URL is fetched when it
 * opens and lives in this component's state only (it is a bearer credential
 * for its lifetime).
 */
function PhotoViewerDialog({
  storageObjectId,
  label,
  onClose,
}: {
  storageObjectId: string | null;
  label: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A PDF source (H2, #186) cannot be drawn by an `<img>`: offer the new tab instead.
  const [unviewable, setUnviewable] = useState(false);

  useEffect(() => {
    setUrl(null);
    setError(null);
    setUnviewable(false);
    if (!storageObjectId) return;
    let cancelled = false;
    getStorageObjectDownloadUrl(storageObjectId).then(
      ({ url: signed }) => {
        if (!cancelled) setUrl(signed);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError && err.status === 404
            ? 'This photo is no longer available.'
            : 'Could not load the photo. Try again later.',
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [storageObjectId]);

  return (
    <Dialog open={storageObjectId !== null} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby={titleId}>
      <DialogTitle id={titleId}>Photo</DialogTitle>
      <DialogContent dividers>
        {error ? (
          <Alert severity="error">{error}</Alert>
        ) : url && unviewable ? (
          <Alert severity="info">This file (a PDF, for example) can't be shown here. Open it in a new tab.</Alert>
        ) : url ? (
          <Box
            component="img"
            src={url}
            alt={label}
            onError={() => setUnviewable(true)}
            sx={{ display: 'block', maxWidth: '100%', maxHeight: '70vh', mx: 'auto' }}
          />
        ) : (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress aria-label="Loading photo" />
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        {url && (
          <Link href={url} target="_blank" rel="noopener noreferrer" sx={{ mr: 'auto', ml: 1 }}>
            Open in a new tab
          </Link>
        )}
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

export interface MeasurementHistoryProps {
  metrics: readonly MetricDef[];
  methodLabels: ReadonlyMap<string, string>;
  unitSystem: UnitSystem;
  canWrite: boolean;
  /** Bumped by the page after any change (log, edit, delete): reload the loaded pages. */
  refreshToken?: number;
  onEdit: (entry: HistoryEntry) => void;
  onDelete: (entry: HistoryEntry) => void;
}

function ActionButton({
  label,
  canWrite,
  onClick,
  children,
}: {
  label: string;
  canWrite: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const button = (
    <IconButton
      aria-label={label}
      onClick={onClick}
      disabled={!canWrite}
      sx={{ minWidth: 44, minHeight: 44 }}
    >
      {children}
    </IconButton>
  );
  return (
    <Tooltip title={canWrite ? label : NO_EDIT_PERMISSION_TOOLTIP}>
      {/* A disabled button fires no events; the span carries the tooltip. */}
      <Box component="span" sx={{ display: 'inline-flex' }}>
        {button}
      </Box>
    </Tooltip>
  );
}

function HistoryRow({
  entry,
  divider,
  metricsByKey,
  methodLabels,
  unitSystem,
  canWrite,
  onEdit,
  onDelete,
}: {
  entry: HistoryEntry;
  divider: boolean;
  metricsByKey: ReadonlyMap<string, MetricDef>;
  methodLabels: ReadonlyMap<string, string>;
  unitSystem: UnitSystem;
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const views = describeEntry(entry, metricsByKey, unitSystem);
  const what = spokenList(views.map((view) => view.label));
  const when = `${formatShortDate(entry.measuredAt)}, ${formatShortTime(entry.measuredAt)}`;
  const provenance = entryPhotoProvenance(entry);
  const [viewing, setViewing] = useState(false);

  return (
    <ListItem
      data-testid="history-entry"
      divider={divider}
      sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, px: { xs: 1, sm: 2 }, py: 1.5 }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" color="text.secondary" component="p">
          <Box component="time" dateTime={entry.measuredAt}>
            {formatDateTime(entry.measuredAt)}
          </Box>
        </Typography>
        <Stack spacing={0.5} sx={{ mt: 0.5 }}>
          {views.map((view) => (
            <Box
              key={view.key}
              sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 1, rowGap: 0.5 }}
            >
              <Typography component="span" sx={{ overflowWrap: 'anywhere' }}>
                <Box component="span" sx={{ color: 'text.secondary' }}>
                  {view.label}
                </Box>{' '}
                <Box component="span" sx={{ fontWeight: 600 }}>
                  {view.text}
                </Box>
              </Typography>
              {view.methods.map((method) => (
                <Chip key={method} size="small" variant="outlined" label={methodLabels.get(method) ?? method} />
              ))}
            </Box>
          ))}
        </Stack>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mt: 0.75 }}>
          {provenance.readFromPhoto ? (
            <Chip
              size="small"
              variant="outlined"
              color="secondary"
              icon={<PhotoCameraOutlinedIcon />}
              label={READ_FROM_PHOTO_CHIP}
            />
          ) : (
            <Typography variant="caption" color="text.secondary">
              {ORIGIN_LABELS[entry.origin] ?? entry.origin}
            </Typography>
          )}
          {provenance.userEdited && <Chip size="small" variant="outlined" label={USER_EDITED_CHIP} />}
          {entry.edited && <Chip size="small" label="Edited" />}
          {provenance.fileDeleted && !provenance.photoId && (
            <Chip
              size="small"
              variant="outlined"
              icon={<HideImageOutlinedIcon />}
              label={FILE_DELETED_CHIP}
              title="The photo was erased after its values were saved"
            />
          )}
          {provenance.photoId && (
            <Button
              size="small"
              startIcon={<ImageOutlinedIcon />}
              onClick={() => setViewing(true)}
              aria-label={`View photo for ${what} entry from ${when}`}
              sx={{ minHeight: 32 }}
            >
              View photo
            </Button>
          )}
        </Box>
        {entry.notes && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>
            {entry.notes}
          </Typography>
        )}
      </Box>
      <Box sx={{ display: 'flex', flexShrink: 0 }}>
        <ActionButton label={`Edit ${what} entry from ${when}`} canWrite={canWrite} onClick={onEdit}>
          <EditOutlinedIcon />
        </ActionButton>
        <ActionButton label={`Delete ${what} entry from ${when}`} canWrite={canWrite} onClick={onDelete}>
          <DeleteOutlineIcon />
        </ActionButton>
      </Box>
      {provenance.photoId && (
        <PhotoViewerDialog
          storageObjectId={viewing ? provenance.photoId : null}
          label={`Photo the ${what} entry from ${when} was read from`}
          onClose={() => setViewing(false)}
        />
      )}
    </ListItem>
  );
}

export function MeasurementHistorySkeleton() {
  return (
    <Stack spacing={1} data-testid="measurement-history-skeleton" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} variant="rounded" height={72} />
      ))}
    </Stack>
  );
}

export function MeasurementHistory({
  metrics,
  methodLabels,
  unitSystem,
  canWrite,
  refreshToken = 0,
  onEdit,
  onDelete,
}: MeasurementHistoryProps) {
  const filterId = useId();
  const choices = useMemo(() => metricChoices(metrics, { includeWellness: false }), [metrics]);
  const [filter, setFilter] = useState('all');
  const choice = choices.find((c) => c.id === filter) ?? null;
  const history = useMeasurements({ metricKeys: choice?.metricKeys ?? [] });
  const metricsByKey = useMemo(() => new Map(metrics.map((m) => [m.key, m])), [metrics]);

  // The page bumps `refreshToken` after a log, an edit or a delete.
  const { refresh } = history;
  const lastToken = useRef(refreshToken);
  useEffect(() => {
    if (lastToken.current === refreshToken) return;
    lastToken.current = refreshToken;
    refresh();
  }, [refreshToken, refresh]);

  const firstLoad = history.isLoading && history.entries.length === 0;

  let body: ReactNode;
  if (history.forbidden) {
    body = <Alert severity="info">{HEALTH_DATA_UNAVAILABLE}</Alert>;
  } else if (history.error && history.entries.length === 0 && !history.isLoading) {
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={history.refresh}>
            Retry
          </Button>
        }
      >
        Could not load your history. {history.error}
      </Alert>
    );
  } else if (firstLoad) {
    body = <MeasurementHistorySkeleton />;
  } else if (history.entries.length === 0) {
    body = (
      <EmptyState
        Icon={HistoryIcon}
        headingLevel="h3"
        title={choice ? `No ${choice.label.toLowerCase()} entries yet` : 'No entries yet'}
        description="What you log appears here, newest first."
      />
    );
  } else {
    body = (
      <>
        <List disablePadding aria-label="Measurement history" sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
          {history.entries.map((entry, index) => (
            <HistoryRow
              key={entry.entryId}
              entry={entry}
              divider={index < history.entries.length - 1}
              metricsByKey={metricsByKey}
              methodLabels={methodLabels}
              unitSystem={unitSystem}
              canWrite={canWrite}
              onEdit={() => onEdit(entry)}
              onDelete={() => onDelete(entry)}
            />
          ))}
        </List>
        {history.error && (
          <Alert
            severity="error"
            sx={{ mt: 2 }}
            action={
              <Button color="inherit" size="small" onClick={history.loadMore}>
                Retry
              </Button>
            }
          >
            Could not load more entries. {history.error}
          </Alert>
        )}
        {history.hasMore && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
            <Button variant="outlined" onClick={history.loadMore} disabled={history.isLoadingMore}>
              {history.isLoadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </Box>
        )}
      </>
    );
  }

  return (
    <Stack spacing={2}>
      {!history.forbidden && (
        <TextField
          id={filterId}
          select
          size="small"
          label="Show"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          sx={{ width: { xs: '100%', sm: 240 } }}
        >
          <MenuItem value="all">All</MenuItem>
          {choices.map((c) => (
            <MenuItem key={c.id} value={c.id}>
              {c.label}
            </MenuItem>
          ))}
        </TextField>
      )}
      {body}
    </Stack>
  );
}

export default MeasurementHistory;
