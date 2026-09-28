/**
 * Recent events — issue #578, epic #576.
 *
 * Log records newest first, filtered by the severity chips (`sev`, shared with
 * the log timeline) and a body search (`q`, debounced 400 ms, ≤ 200
 * characters — the API's limit). "Load more" follows the API's `nextCursor`.
 *
 * Desktop: a table (time, severity, service, one-line message). Tablet: the
 * same without the service column. Phone: a list (severity chip + relative
 * time, two-line message). Any row opens the full record in a dialog —
 * full-screen on phones — with the body, exact timestamp, service, trace id
 * and span id. MUI's Dialog traps focus and restores it to the row on close.
 *
 * "View trace" (#579): an event whose trace id is a real OpenTelemetry id (32
 * lower-case hex digits, `traceLink.ts`) offers it in that detail, and opens
 * the trace's spans in the Telemetry Explorer (loaded, not run). It lives in
 * the detail rather than on the row because a row is itself a button, and a
 * control nested in a control is unreachable for assistive technology. Any
 * other id gets no link.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import type { DashboardEventsResource } from '../../../hooks/useTelemetryDashboard';
import {
  DASHBOARD_SEARCH_MAX_LENGTH,
  type DashboardEvent,
  type DashboardSeverity,
} from '../../../services/telemetryDashboard';
import { DashboardPanel, PanelError, type PanelAction } from './DashboardPanel';
import type { DashboardLayout } from './DashboardFilterBar';
import { SeverityChip, SeverityChips, SeverityLabel } from './severity';
import { formatRelative, formatTimestamp } from './format';
import { isTraceId } from './traceLink';

export const SEARCH_DEBOUNCE_MS = 400;

/** A search box that reports its value 400 ms after the last keystroke. */
function SearchField({ value, onChange }: { value: string; onChange: (q: string) => void }) {
  const [draft, setDraft] = useState(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const committed = useRef(value);

  // An outside change (Reset, back button) replaces the draft.
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setDraft(value);
    }
  }, [value]);

  useEffect(() => {
    if (draft === committed.current) return;
    const timer = setTimeout(() => {
      committed.current = draft;
      onChangeRef.current(draft);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  return (
    <TextField
      size="small"
      fullWidth
      type="search"
      label="Search messages"
      value={draft}
      onChange={(event) => setDraft(event.target.value.slice(0, DASHBOARD_SEARCH_MAX_LENGTH))}
      slotProps={{
        htmlInput: { maxLength: DASHBOARD_SEARCH_MAX_LENGTH },
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" aria-hidden />
            </InputAdornment>
          ),
        },
      }}
      sx={{ mb: 1.5 }}
    />
  );
}

function DetailRow({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <Box sx={{ mb: 1.5 }}>
      <Typography variant="caption" color="text.secondary" component="dt">
        {label}
      </Typography>
      <Typography
        component="dd"
        variant="body2"
        sx={{ m: 0, wordBreak: 'break-all', fontFamily: mono ? 'monospace' : undefined }}
      >
        {value ?? '—'}
      </Typography>
    </Box>
  );
}

function EventDialog({
  event,
  fullScreen,
  onClose,
  onViewTrace,
}: {
  event: DashboardEvent | null;
  fullScreen: boolean;
  onClose: () => void;
  onViewTrace?: (traceId: string) => void;
}) {
  const titleId = useId();
  return (
    <Dialog open={event !== null} onClose={onClose} fullScreen={fullScreen} fullWidth maxWidth="md" aria-labelledby={titleId}>
      {event && (
        <>
          <DialogTitle id={titleId} sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1 }}>
            <SeverityLabel severity={event.severity} />
            <Box component="span" sx={{ flex: 1 }}>
              Log event
            </Box>
            <IconButton aria-label="Close event" onClick={onClose} sx={{ width: 44, height: 44 }}>
              <CloseIcon />
            </IconButton>
          </DialogTitle>
          <DialogContent dividers>
            <Box
              component="pre"
              data-testid="event-body"
              sx={{ m: 0, mb: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace', fontSize: 13 }}
            >
              {event.body ?? '(no message)'}
            </Box>
            <Box component="dl" sx={{ m: 0 }}>
              <DetailRow label="Timestamp (UTC)" value={event.timestamp} mono />
              <DetailRow label="Service" value={event.service} />
              <DetailRow label="Trace id" value={event.traceId} mono />
              <DetailRow label="Span id" value={event.spanId} mono />
            </Box>
            {onViewTrace && isTraceId(event.traceId) && (
              <Button
                variant="outlined"
                startIcon={<AccountTreeOutlinedIcon />}
                onClick={() => onViewTrace(event.traceId as string)}
                sx={{ minHeight: 44 }}
              >
                View trace
              </Button>
            )}
          </DialogContent>
        </>
      )}
    </Dialog>
  );
}

/** Event timestamps carry nanoseconds; `Date.parse` needs at most milliseconds. */
function eventTime(timestamp: string): string {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(timestamp.replace(' ', 'T'));
  if (!match) return timestamp;
  const fraction = match[2] ? match[2].slice(0, 4) : '';
  return `${match[1]}${fraction}${match[3] ?? 'Z'}`;
}

export interface EventsFeedProps {
  events: DashboardEventsResource;
  sev: DashboardSeverity[];
  q: string;
  onChange: (patch: { sev?: DashboardSeverity[]; q?: string }) => void;
  layout: DashboardLayout;
  actions?: PanelAction[];
  /** Opens a trace (a validated 32-hex id) in the explorer (#579). Omitted: no link. */
  onViewTrace?: (traceId: string) => void;
  now?: number;
}

export function EventsFeed({
  events,
  sev,
  q,
  onChange,
  layout,
  actions = [],
  onViewTrace,
  now = Date.now(),
}: EventsFeedProps) {
  const [selected, setSelected] = useState<DashboardEvent | null>(null);
  const isPhone = layout === 'phone';
  const showService = layout === 'desktop';

  const openOnKey = (event: KeyboardEvent, item: DashboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelected(item);
    }
  };

  const rows = isPhone ? (
    <List disablePadding aria-label="Recent events">
      {events.items.map((item, index) => (
        <ListItemButton
          key={`${item.timestamp}-${item.spanId ?? ''}-${index}`}
          divider
          onClick={() => setSelected(item)}
          sx={{ px: 0.5, display: 'block', minHeight: 44 }}
        >
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
            <SeverityChip severity={item.severity} />
            <Typography variant="caption" color="text.secondary" title={formatTimestamp(eventTime(item.timestamp))}>
              {formatRelative(eventTime(item.timestamp), now)}
            </Typography>
          </Stack>
          <Typography
            variant="body2"
            sx={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              wordBreak: 'break-word',
            }}
          >
            {item.body ?? '(no message)'}
          </Typography>
        </ListItemButton>
      ))}
    </List>
  ) : (
    <TableContainer>
      <Table size="small" aria-label="Recent events" sx={{ tableLayout: 'fixed' }}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: 96 }}>Time</TableCell>
            <TableCell sx={{ width: 96 }}>Severity</TableCell>
            {showService && <TableCell sx={{ width: 160 }}>Service</TableCell>}
            <TableCell>Message</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {events.items.map((item, index) => (
            <TableRow
              key={`${item.timestamp}-${item.spanId ?? ''}-${index}`}
              hover
              tabIndex={0}
              role="button"
              aria-label={`Open event: ${item.body ?? 'no message'}`}
              onClick={() => setSelected(item)}
              onKeyDown={(event) => openOnKey(event, item)}
              sx={{ cursor: 'pointer' }}
            >
              <TableCell sx={{ whiteSpace: 'nowrap' }} title={formatTimestamp(eventTime(item.timestamp))}>
                {formatRelative(eventTime(item.timestamp), now)}
              </TableCell>
              <TableCell>
                <SeverityLabel severity={item.severity} />
              </TableCell>
              {showService && (
                <TableCell sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.service ?? '—'}
                </TableCell>
              )}
              <TableCell sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.body ?? '(no message)'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );

  return (
    <DashboardPanel
      id="panel-events"
      title="Recent events"
      headerExtra={
        <SeverityChips
          value={sev}
          onChange={(next) => onChange({ sev: next })}
          large={isPhone}
          label="Event severity filter"
        />
      }
      actions={actions}
      sql={events.data?.sql}
      isRefreshing={events.isRefreshing}
    >
      <SearchField value={q} onChange={(next) => onChange({ q: next })} />
      {events.error ? (
        <PanelError error={events.error} onRetry={events.reload} />
      ) : events.isLoading ? (
        <Stack sx={{ alignItems: 'center', py: 4 }}>
          <CircularProgress size={28} aria-label="Loading events" />
        </Stack>
      ) : events.items.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
          {q ? 'No events match this search.' : 'No events of the selected severities in this window.'}
        </Typography>
      ) : (
        <>
          {rows}
          {events.loadMoreError && (
            <Box sx={{ mt: 1.5 }}>
              <PanelError error={events.loadMoreError} onRetry={events.loadMore} />
            </Box>
          )}
          {events.hasMore && (
            <Stack sx={{ alignItems: 'center', mt: 1.5 }}>
              <Button
                variant="outlined"
                onClick={events.loadMore}
                disabled={events.isLoadingMore}
                startIcon={events.isLoadingMore ? <CircularProgress size={16} /> : undefined}
                sx={{ minHeight: 44 }}
              >
                Load more
              </Button>
            </Stack>
          )}
        </>
      )}
      <EventDialog
        event={selected}
        fullScreen={isPhone}
        onClose={() => setSelected(null)}
        onViewTrace={onViewTrace}
      />
    </DashboardPanel>
  );
}
