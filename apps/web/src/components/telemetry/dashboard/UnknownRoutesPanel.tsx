/**
 * Unknown API routes — issue #258.
 *
 * Requests the API answered from its not-found handler: no route of the
 * running build matches the method and path. With a bearer token they come
 * from the application itself — typically a web build calling a route its API
 * lacks after a deploy ("Cannot GET /api/coach/messages") — and the API
 * degrades the verdict; without one they are usually internet scanners and
 * are only counted.
 *
 * Shows the summary's `unknownRoutes.topRoutes` (at most 5, bearer requests
 * first, as the API ranked them): `METHOD /path`, the request count, and an
 * "app" chip (some requests carried a bearer) or an "anonymous" one. The
 * page renders it only when the block is present and counted a request
 * (`hasUnknownRoutes`); it is a compact list at every width, so it fits a
 * 390px phone without a table.
 */
import { Box, Chip, List, ListItem, Typography } from '@mui/material';
import type { DashboardUnknownRoute, DashboardUnknownRoutes } from '../../../services/telemetryDashboard';
import { DashboardPanel, type PanelAction } from './DashboardPanel';
import { UNKNOWN_ROUTES_ANCHOR } from './unknownRoutes';

export const UNKNOWN_ROUTES_TITLE = 'Unknown API routes';

function routeTitle(item: DashboardUnknownRoute): string {
  return `${item.count.toLocaleString()} requests: ${item.bearer.toLocaleString()} from the app (with a bearer token), ${item.anonymous.toLocaleString()} anonymous`;
}

function SourceChip({ item }: { item: DashboardUnknownRoute }) {
  const fromApp = item.bearer > 0;
  return (
    <Chip
      size="small"
      label={fromApp ? 'app' : 'anonymous'}
      color={fromApp ? 'warning' : 'default'}
      variant="outlined"
      data-testid="unknown-route-source"
      sx={{ height: 22, fontSize: '0.75rem' }}
    />
  );
}

export interface UnknownRoutesPanelProps {
  unknownRoutes: DashboardUnknownRoutes;
  /** The statements that computed the block (`unknownRoutesSql`), handed to the actions. */
  sql: string[];
  actions?: PanelAction[];
  isRefreshing?: boolean;
}

export function UnknownRoutesPanel({ unknownRoutes, sql, actions = [], isRefreshing = false }: UnknownRoutesPanelProps) {
  const { requests, bearer, anonymous, topRoutes, truncated } = unknownRoutes;
  return (
    <DashboardPanel
      id="panel-unknown-routes"
      anchorId={UNKNOWN_ROUTES_ANCHOR}
      title={UNKNOWN_ROUTES_TITLE}
      actions={actions}
      sql={sql}
      isRefreshing={isRefreshing}
      isEmpty={topRoutes.length === 0}
      emptyMessage="No unknown routes listed for this window."
    >
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }} data-testid="unknown-routes-summary">
        {requests.toLocaleString()} {requests === 1 ? 'request' : 'requests'} to routes this API does not have:{' '}
        <Box component="span" sx={{ color: bearer > 0 ? 'warning.main' : undefined, fontWeight: bearer > 0 ? 600 : undefined }}>
          {bearer.toLocaleString()} from the app
        </Box>
        , {anonymous.toLocaleString()} anonymous.
        {bearer > 0 && ' Requests from the app usually mean the web and API versions differ, e.g. after a deploy.'}
      </Typography>
      <List disablePadding aria-label={UNKNOWN_ROUTES_TITLE}>
        {topRoutes.map((item, index) => (
          <ListItem
            key={`${item.method}-${item.route}-${index}`}
            divider={index < topRoutes.length - 1}
            title={routeTitle(item)}
            sx={{ px: 0, py: 0.75, gap: 1, alignItems: 'center' }}
          >
            <Typography
              variant="body2"
              sx={{ fontFamily: 'monospace', flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}
            >
              <strong>{item.method ?? '—'}</strong> {item.route ?? '—'}
            </Typography>
            <SourceChip item={item} />
            <Typography
              variant="body2"
              sx={{ minWidth: 40, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
              aria-label={`${item.count.toLocaleString()} requests`}
            >
              {item.count.toLocaleString()}
            </Typography>
          </ListItem>
        ))}
      </List>
      {truncated && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          More unknown routes were requested; the most-hit are listed.
        </Typography>
      )}
    </DashboardPanel>
  );
}
