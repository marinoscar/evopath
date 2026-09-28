/**
 * Top problems — issue #578, epic #576.
 *
 * The ten request paths with the most 5xx responses (then highest p95), and
 * the ten most frequent error log messages — ranked by the API. Two panels,
 * each fetched on its own so one failing leaves the other working.
 *
 * Desktop: two tables side by side. Tablet: stacked. Phone: ONE panel with a
 * Routes / Errors toggle and a card list instead of a table.
 */
import { useState } from 'react';
import {
  Box,
  Grid,
  List,
  ListItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import type { DashboardResource } from '../../../hooks/useTelemetryDashboard';
import type {
  DashboardTopError,
  DashboardTopErrors,
  DashboardTopRoute,
  DashboardTopRoutes,
} from '../../../services/telemetryDashboard';
import { DashboardPanel, type PanelAction } from './DashboardPanel';
import type { DashboardLayout } from './DashboardFilterBar';
import { formatDuration, formatRelative, formatTimestamp } from './format';

const pct = (value: number) => `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
const ms = (value: number | null) => (value === null ? '—' : formatDuration(value));

const clamp = (lines: number) => ({
  display: '-webkit-box',
  WebkitLineClamp: lines,
  WebkitBoxOrient: 'vertical' as const,
  overflow: 'hidden',
  wordBreak: 'break-word' as const,
});

function RoutesTable({ items }: { items: DashboardTopRoute[] }) {
  return (
    <TableContainer sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label="Top routes">
        <TableHead>
          <TableRow>
            <TableCell>Method</TableCell>
            <TableCell>Route</TableCell>
            <TableCell align="right">Requests</TableCell>
            <TableCell align="right">5xx</TableCell>
            <TableCell align="right">p95</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {items.map((item, index) => (
            <TableRow key={`${item.method}-${item.route}-${index}`}>
              <TableCell sx={{ fontFamily: 'monospace' }}>{item.method ?? '—'}</TableCell>
              <TableCell sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere', minWidth: 200 }}>
                {item.route ?? '—'}
              </TableCell>
              <TableCell align="right">{item.count.toLocaleString()}</TableCell>
              <TableCell align="right" sx={{ color: item.errors > 0 ? 'error.main' : undefined, whiteSpace: 'nowrap' }}>
                {pct(item.errorRatePct)}
              </TableCell>
              <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                {ms(item.p95Ms)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function ErrorsTable({ items, now }: { items: DashboardTopError[]; now: number }) {
  return (
    <TableContainer sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label="Top errors">
        <TableHead>
          <TableRow>
            <TableCell>Message</TableCell>
            <TableCell align="right">Count</TableCell>
            <TableCell>First seen</TableCell>
            <TableCell>Last seen</TableCell>
            <TableCell>Service</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {items.map((item, index) => (
            <TableRow key={`${item.message}-${index}`}>
              <TableCell sx={{ minWidth: 160 }}>
                <Box sx={clamp(2)} title={item.message ?? undefined}>
                  {item.message ?? '—'}
                </Box>
              </TableCell>
              <TableCell align="right">{item.count.toLocaleString()}</TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap' }} title={formatTimestamp(item.firstSeen)}>
                {item.firstSeen ? formatRelative(item.firstSeen, now) : '—'}
              </TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap' }} title={formatTimestamp(item.lastSeen)}>
                {item.lastSeen ? formatRelative(item.lastSeen, now) : '—'}
              </TableCell>
              <TableCell sx={{ wordBreak: 'break-word' }}>{item.service ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function RoutesCards({ items }: { items: DashboardTopRoute[] }) {
  return (
    <List disablePadding aria-label="Top routes">
      {items.map((item, index) => (
        <ListItem key={`${item.method}-${item.route}-${index}`} divider sx={{ px: 0, display: 'block' }}>
          <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
            <strong>{item.method ?? '—'}</strong> {item.route ?? '—'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {item.count.toLocaleString()} req ·{' '}
            <Box component="span" sx={{ color: item.errors > 0 ? 'error.main' : undefined }}>
              {pct(item.errorRatePct)} 5xx
            </Box>{' '}
            · p95 {ms(item.p95Ms)}
          </Typography>
        </ListItem>
      ))}
    </List>
  );
}

function ErrorsCards({ items, now }: { items: DashboardTopError[]; now: number }) {
  return (
    <List disablePadding aria-label="Top errors">
      {items.map((item, index) => (
        <ListItem key={`${item.message}-${index}`} divider sx={{ px: 0, display: 'block' }}>
          <Typography variant="body2" sx={clamp(2)}>
            {item.message ?? '—'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {item.count.toLocaleString()}× · last {item.lastSeen ? formatRelative(item.lastSeen, now) : '—'}
            {item.service ? ` · ${item.service}` : ''}
          </Typography>
        </ListItem>
      ))}
    </List>
  );
}

export type TopProblemsKind = 'routes' | 'errors';

export interface TopProblemsProps {
  routes: DashboardResource<DashboardTopRoutes>;
  errors: DashboardResource<DashboardTopErrors>;
  layout: DashboardLayout;
  /**
   * Header actions: one list for both panels, or one per panel (#579 — "Ask
   * assistant" describes the panel it was invoked from). On phones the single
   * panel offers the actions of the view the toggle shows.
   */
  actions?: PanelAction[] | ((kind: TopProblemsKind) => PanelAction[]);
  now?: number;
}

export function TopProblems({ routes, errors, layout, actions = [], now = Date.now() }: TopProblemsProps) {
  const [kind, setKind] = useState<TopProblemsKind>('routes');
  const actionsOf = (which: TopProblemsKind) => (typeof actions === 'function' ? actions(which) : actions);

  const routesPanel = (
    <DashboardPanel
      id="panel-top-routes"
      title="Top failing routes"
      actions={actionsOf('routes')}
      sql={routes.data?.sql}
      isLoading={routes.isLoading}
      isRefreshing={routes.isRefreshing}
      error={routes.error}
      onRetry={routes.reload}
      isEmpty={!!routes.data && routes.data.items.length === 0}
      emptyMessage="No requests in this window."
    >
      {routes.data && <RoutesTable items={routes.data.items} />}
    </DashboardPanel>
  );

  const errorsPanel = (
    <DashboardPanel
      id="panel-top-errors"
      title="Top errors"
      actions={actionsOf('errors')}
      sql={errors.data?.sql}
      isLoading={errors.isLoading}
      isRefreshing={errors.isRefreshing}
      error={errors.error}
      onRetry={errors.reload}
      isEmpty={!!errors.data && errors.data.items.length === 0}
      emptyMessage="No error logs in this window."
    >
      {errors.data && <ErrorsTable items={errors.data.items} now={now} />}
    </DashboardPanel>
  );

  if (layout === 'phone') {
    const active = kind === 'routes' ? routes : errors;
    return (
      <DashboardPanel
        id="panel-top"
        title="Top problems"
        headerExtra={
          <ToggleButtonGroup
            exclusive
            size="small"
            aria-label="Top problems view"
            value={kind}
            onChange={(_event, next: TopProblemsKind | null) => next && setKind(next)}
          >
            <ToggleButton value="routes" sx={{ minHeight: 44, textTransform: 'none' }}>
              Routes
            </ToggleButton>
            <ToggleButton value="errors" sx={{ minHeight: 44, textTransform: 'none' }}>
              Errors
            </ToggleButton>
          </ToggleButtonGroup>
        }
        actions={actionsOf(kind)}
        sql={active.data?.sql}
        isLoading={active.isLoading}
        isRefreshing={active.isRefreshing}
        error={active.error}
        onRetry={active.reload}
        isEmpty={!!active.data && active.data.items.length === 0}
        emptyMessage={kind === 'routes' ? 'No requests in this window.' : 'No error logs in this window.'}
      >
        {kind === 'routes' && routes.data && <RoutesCards items={routes.data.items} />}
        {kind === 'errors' && errors.data && <ErrorsCards items={errors.data.items} now={now} />}
      </DashboardPanel>
    );
  }

  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, lg: 6 }} sx={{ minWidth: 0 }}>
        {routesPanel}
      </Grid>
      <Grid size={{ xs: 12, lg: 6 }} sx={{ minWidth: 0 }}>
        {errorsPanel}
      </Grid>
    </Grid>
  );
}
