/**
 * History: every body and vital entry, newest first, issue #60 (E2.5).
 *
 * One row per ENTRY (a blood-pressure pair is `128/84 mmHg`, weight + body fat
 * is one row with both), grouped in the client and merged across `Load more`
 * pages (`useMeasurements`). Each row carries the date and time, the readings
 * in the user's units, a method chip per reading (none for `unspecified`),
 * `Edited` when revised, the origin, the note, and Edit/Delete.
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
  IconButton,
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
import { HEALTH_DATA_UNAVAILABLE, type MetricDef, type UnitSystem } from '../../services/health';
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

/** What an origin reads as; `manual` for everything today, AI-read with E2.6. */
const ORIGIN_LABELS: Record<string, string> = { manual: 'Manual' };

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
          <Typography variant="caption" color="text.secondary">
            {ORIGIN_LABELS[entry.origin] ?? entry.origin}
          </Typography>
          {entry.edited && <Chip size="small" label="Edited" />}
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
