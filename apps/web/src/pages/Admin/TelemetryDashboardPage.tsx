/**
 * Console → Observability → Telemetry Dashboard — issue #578, epic #576.
 *
 * "Is anything wrong?" at a glance: a verdict, headline tiles, API and log
 * timelines, the top failing routes and error messages, and a feed of recent
 * error and warning logs — all read from `/api/admin/telemetry/dashboard/*`
 * (#577). The verdict, tiles, bands and routes are the API's; this page only
 * presents them.
 *
 * Gates: the route requires `telemetry:query` (what the dashboard controller
 * enforces) AND the `telemetry` feature (`RequireTelemetryEnabled`), exactly
 * like the Telemetry Explorer. Every request is still authorised by the API.
 *
 * Data: every panel fetches INDEPENDENTLY (`hooks/useTelemetryDashboard.ts`),
 * so one failing or slow endpoint never blanks another. Auto-refresh (30 s,
 * `?refresh=off` to stop) pauses while the tab is hidden and refreshes at once
 * on return (`useVisiblePolling`). A store-level failure on the summary —
 * telemetry switched off, not configured, or unreachable — replaces the page
 * with one Alert linking to the Telemetry settings, as the explorer does.
 *
 * State lives in the URL (`dashboardState.ts`), so a link reproduces the view.
 *
 * Layout: phone < 600 (`xs`), tablet 600–1199 (`sm`–`md`), desktop ≥ 1200
 * (`lg`), decided HERE only — none of the shell's five coupled breakpoint
 * gates is touched.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Container,
  Grid,
  Stack,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { Navigate, Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import { usePermissions } from '../../hooks/usePermissions';
import { useVisiblePolling } from '../../hooks/useVisiblePolling';
import {
  useDashboardEvents,
  useDashboardFilters,
  useDashboardSummary,
  useDashboardTimeseries,
  useDashboardTop,
} from '../../hooks/useTelemetryDashboard';
import {
  telemetryErrorTitle,
  useTelemetryAssistantModel,
  type TelemetryErrorInfo,
} from '../../hooks/useTelemetryExplorer';
import { useTelemetryAssistant } from '../../hooks/useTelemetryAssistant';
import { useTelemetryAssistantAvailable } from '../../hooks/useTelemetryAssistantAvailable';
import { AssistantPanel } from '../../components/telemetry/AssistantPanel';
import {
  ASSISTANT_WIDTH,
  AssistantContainer,
  type AssistantContainerVariant,
} from '../../components/telemetry/AssistantContainer';
import {
  buildAssistantQuestion,
  type AssistantPanelContext,
} from '../../components/telemetry/dashboard/assistantPrompt';
import {
  DASHBOARD_REFRESH_MS,
  bucketWindow,
  dashboardQuery,
  windowSpanMs,
  dashboardStateToParams,
  parseDashboardState,
  type DashboardState,
} from '../../components/telemetry/dashboard/dashboardState';
import { DashboardPanel, type PanelAction } from '../../components/telemetry/dashboard/DashboardPanel';
import { VerdictBanner } from '../../components/telemetry/dashboard/VerdictBanner';
import { KpiTiles } from '../../components/telemetry/dashboard/KpiTiles';
import { ApiTimelineChart } from '../../components/telemetry/dashboard/ApiTimelineChart';
import { LogSeverityChart } from '../../components/telemetry/dashboard/LogSeverityChart';
import { SeverityChips } from '../../components/telemetry/dashboard/severity';
import {
  DashboardFilterBar,
  type DashboardLayout,
} from '../../components/telemetry/dashboard/DashboardFilterBar';
import { TopProblems, type TopProblemsKind } from '../../components/telemetry/dashboard/TopProblems';
import { EventsFeed } from '../../components/telemetry/dashboard/EventsFeed';
import { timelineHeight } from '../../components/telemetry/dashboard/timelineAxis';
import { TELEMETRY_EXPLORER_PATH, explorerHandoff } from '../../components/telemetry/explorerHandoff';
import { TelemetryCrossLink } from '../../components/telemetry/TelemetryCrossLink';
import { traceExplorerSql } from '../../components/telemetry/dashboard/traceLink';
import { sqlList } from '../../services/telemetryDashboard';
import type {
  DashboardBuckets,
  DashboardLogsBucket,
  DashboardSeverity,
} from '../../services/telemetryDashboard';

/** Mirrors the `Telemetry Dashboard` card in `config/adminSections.tsx`. */
const PAGE_TITLE = 'Telemetry Dashboard';
const PAGE_DESCRIPTION =
  'See at a glance whether anything is wrong: error rate, latency, error logs and the top failing routes.';

/** Store-level reasons: nothing on this page can work, so say so once. */
const UNAVAILABLE_REASONS = new Set(['TELEMETRY_DISABLED', 'TELEMETRY_NOT_CONFIGURED', 'TELEMETRY_UNREACHABLE']);

/**
 * The panel header's "Open in Explorer" (#579). The SQL is ONLY what the API
 * reported it ran for the panel (`sql`), never rebuilt here. A panel whose
 * `sql` is a list hands over its FIRST (primary) statement — for "Key
 * indicators" that is the API's current-vs-previous totals query, the one the
 * headline tiles come from; the others are single statements.
 */
function explorerAction(openSql: (sql: string) => void, sqlAvailable: boolean): PanelAction {
  return {
    key: 'open-in-explorer',
    label: 'Open in Explorer',
    icon: <CodeOutlinedIcon />,
    onClick: (sql) => {
      if (sql[0]) openSql(sql[0]);
    },
    disabled: !sqlAvailable,
  };
}

/**
 * The panel header's "Ask assistant" (#579): opens the assistant with a
 * question describing what the panel shows (`assistantPrompt.ts`) PREFILLED —
 * never sent; the reader edits it and presses Ask. Offered only where the
 * assistant is available (`useTelemetryAssistantAvailable`, the Explorer's
 * condition), and disabled until the panel has data to describe.
 */
function askAction(onAsk: (() => void) | null): PanelAction {
  return {
    key: 'ask-assistant',
    label: 'Ask assistant',
    icon: <AutoAwesomeOutlinedIcon />,
    onClick: () => onAsk?.(),
    disabled: onAsk === null,
  };
}

function UnavailableAlert({ error, onRetry }: { error: TelemetryErrorInfo; onRetry: () => void }) {
  return (
    <Alert
      severity="warning"
      data-testid="telemetry-unavailable"
      action={
        <Button color="inherit" size="small" onClick={onRetry} sx={{ minHeight: 44 }}>
          Retry
        </Button>
      }
    >
      <AlertTitle>{telemetryErrorTitle(error)}</AlertTitle>
      <Box component="span" sx={{ display: 'block', wordBreak: 'break-word' }}>
        {error.message}
      </Box>
      <Box component="span" sx={{ display: 'block', mt: 1 }}>
        Check the connection and collection settings in{' '}
        <RouterLink to="/admin/settings/telemetry">Telemetry settings</RouterLink>.
      </Box>
      {error.reason && (
        <Typography variant="caption" component="div" sx={{ mt: 0.5, opacity: 0.8 }}>
          {error.reason}
        </Typography>
      )}
    </Alert>
  );
}

/** Whether any bucket holds a record of a selected band (`other` rides with `info`). */
function hasSelectedLogs(buckets: DashboardLogsBucket[], sev: DashboardSeverity[]): boolean {
  return buckets.some(
    (bucket) =>
      (sev.includes('error') && bucket.error > 0) ||
      (sev.includes('warn') && bucket.warn > 0) ||
      (sev.includes('info') && bucket.info + bucket.other > 0),
  );
}

/** Zoom gestures per layout: drag on desktop, drag or tap on tablet, tap on phones. */
const ZOOM_MODES: Record<DashboardLayout, { drag: boolean; tap: boolean }> = {
  desktop: { drag: true, tap: false },
  tablet: { drag: true, tap: true },
  phone: { drag: false, tap: true },
};

export default function TelemetryDashboardPage() {
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const isDesktop = useMediaQuery(theme.breakpoints.up('lg'));
  const layout: DashboardLayout = isPhone ? 'phone' : isDesktop ? 'desktop' : 'tablet';
  const { hasPermission } = usePermissions();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const state = useMemo(() => parseDashboardState(searchParams), [searchParams]);
  const [tick, setTick] = useState(0);

  const update = useCallback(
    (patch: Partial<DashboardState>) => {
      setSearchParams(dashboardStateToParams({ ...state, ...patch }), { replace: true });
    },
    [setSearchParams, state],
  );

  useVisiblePolling(() => setTick((value) => value + 1), state.refresh ? DASHBOARD_REFRESH_MS : 0);

  const query = useMemo(() => dashboardQuery(state), [state]);
  // Phones get half the buckets: 60 bars in 340px are slivers.
  const buckets: DashboardBuckets | undefined = isPhone ? '30' : undefined;
  const seriesQuery = useMemo(() => (buckets ? { ...query, buckets } : query), [query, buckets]);
  const windowQuery = useMemo(
    () => (query.range ? { range: query.range } : { from: query.from, to: query.to }),
    [query.range, query.from, query.to],
  );

  const summary = useDashboardSummary(seriesQuery, tick);
  const filters = useDashboardFilters(windowQuery, tick);
  const apiSeries = useDashboardTimeseries('api', seriesQuery, tick);
  const logSeries = useDashboardTimeseries('logs', seriesQuery, tick);
  const topRoutes = useDashboardTop('routes', query, tick);
  const topErrors = useDashboardTop('errors', query, tick);
  const eventsQuery = useMemo(
    () => ({ ...query, severity: state.sev, ...(state.q ? { q: state.q } : {}) }),
    [query, state.sev, state.q],
  );
  const events = useDashboardEvents(eventsQuery, tick);

  const openSql = useCallback(
    (sql: string) => {
      const { to, state: handoff } = explorerHandoff(sql);
      navigate(to, { state: handoff });
    },
    [navigate],
  );
  const hasSql = (sql: string | string[] | undefined) => sqlList(sql).length > 0;

  // ---- assistant (#579) ------------------------------------------------------
  const assistantAvailable = useTelemetryAssistantAvailable();
  const modelCaption = useTelemetryAssistantModel(assistantAvailable && hasPermission('telemetry:read'));
  const assistant = useTelemetryAssistant();
  const [assistantOpen, setAssistantOpen] = useState(false);
  // The prefill, keyed so every "Ask assistant" re-seeds the panel's input.
  const [draft, setDraft] = useState<{ text: string; key: number } | null>(null);
  // What opened the assistant, to hand focus back on close. A phone ⋮ menu
  // item is gone by then, so the panel's ⋮ button stands in for it.
  const invoker = useRef<{ element: HTMLElement | null; panelId: string } | null>(null);

  const askAbout = (panelId: string, panel: AssistantPanelContext | null) =>
    panel && assistantAvailable
      ? () => {
          invoker.current = {
            element: document.activeElement instanceof HTMLElement ? document.activeElement : null,
            panelId,
          };
          setDraft((prev) => ({ text: buildAssistantQuestion(panel, state), key: (prev?.key ?? 0) + 1 }));
          setAssistantOpen(true);
        }
      : null;

  const returnFocus = useCallback((): HTMLElement | null => {
    const origin = invoker.current;
    if (!origin) return null;
    if (origin.element?.isConnected) return origin.element;
    return document.querySelector<HTMLElement>(`[data-testid="${origin.panelId}"] button[aria-haspopup="menu"]`);
  }, []);

  /** A panel's header actions: "Ask assistant" (when available), then "Open in Explorer". */
  const panelActions = (panelId: string, sql: string | string[] | undefined, panel: AssistantPanelContext | null) => [
    ...(assistantAvailable ? [askAction(askAbout(panelId, panel))] : []),
    explorerAction(openSql, hasSql(sql)),
  ];

  const topPanel = (kind: TopProblemsKind): AssistantPanelContext | null => {
    if (kind === 'routes') {
      return topRoutes.data ? { kind: 'routes', title: 'Top failing routes', items: topRoutes.data.items } : null;
    }
    return topErrors.data ? { kind: 'errors', title: 'Top errors', items: topErrors.data.items } : null;
  };

  const spanMs = windowSpanMs(state);
  const zoomTo = (starts: string[], bucketSeconds: number) => (first: number, last: number) => {
    const window = bucketWindow(starts, bucketSeconds, first, last);
    if (window) update(window);
  };

  // Defence, not the gate — `App.tsx` wraps the route in `RequirePermission`.
  if (!hasPermission('telemetry:query')) return <Navigate to="/" replace />;

  const unavailable = summary.error && UNAVAILABLE_REASONS.has(summary.error.reason ?? '') ? summary.error : null;
  const assistantVariant: AssistantContainerVariant = isPhone ? 'fullscreen' : isDesktop ? 'docked' : 'overlay';
  const docked = assistantAvailable && assistantOpen && assistantVariant === 'docked';
  const explainVerdict = summary.data
    ? askAbout('verdict-banner', { kind: 'verdict', title: 'Verdict', verdict: summary.data.verdict })
    : null;

  return (
    <Container maxWidth={false} sx={{ maxWidth: 1600, px: { xs: 0, sm: 2 } }}>
      <Box
        sx={{
          py: { xs: 1, sm: 3 },
          minWidth: 0,
          // Leave room for the docked assistant so it never covers a panel.
          pr: docked ? `${ASSISTANT_WIDTH}px` : 0,
        }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: { xs: 0.5, sm: 1 } }}>
          <Typography
            variant="h4"
            component="h1"
            sx={{ fontSize: { xs: '1.5rem', sm: '2.125rem' }, flex: 1, minWidth: 0 }}
          >
            {PAGE_TITLE}
          </Typography>
          <TelemetryCrossLink
            to={TELEMETRY_EXPLORER_PATH}
            label="Explorer"
            compactLabel="Open Telemetry Explorer"
            icon={<TerminalOutlinedIcon />}
            compact={isPhone}
          />
        </Stack>
        <Typography color="text.secondary" sx={{ mb: 2, display: { xs: 'none', sm: 'block' } }}>
          {PAGE_DESCRIPTION}
        </Typography>

        {unavailable ? (
          <UnavailableAlert error={unavailable} onRetry={summary.reload} />
        ) : (
          <Stack spacing={{ xs: 1.5, sm: 2 }} sx={{ minWidth: 0 }}>
            <DashboardFilterBar
              state={state}
              onChange={update}
              services={filters.data?.services ?? []}
              instances={filters.data?.instances ?? []}
              updatedAt={summary.fetchedAt}
              layout={layout}
            />

            <VerdictBanner
              verdict={summary.data?.verdict ?? null}
              isLoading={summary.isLoading}
              error={summary.error}
              onRetry={summary.reload}
              compact={isPhone}
              action={explainVerdict ? { label: 'Explain this', onClick: explainVerdict } : undefined}
            />

            <DashboardPanel
              id="panel-tiles"
              title="Key indicators"
              actions={panelActions(
                'panel-tiles',
                summary.data?.sql,
                summary.data
                  ? { kind: 'tiles', title: 'Key indicators', tiles: summary.data.tiles, runtime: summary.data.runtime }
                  : null,
              )}
              sql={summary.data?.sql}
              isLoading={summary.isLoading}
              isRefreshing={summary.isRefreshing}
              error={summary.error}
              onRetry={summary.reload}
              isEmpty={!!summary.data && summary.data.tiles.length === 0}
              skeletonHeight={120}
            >
              {summary.data && <KpiTiles tiles={summary.data.tiles} runtime={summary.data.runtime} />}
            </DashboardPanel>

            <Grid container spacing={{ xs: 1.5, sm: 2 }}>
              <Grid size={{ xs: 12, lg: 6 }} sx={{ minWidth: 0 }}>
                <DashboardPanel
                  id="panel-api"
                  title="API requests"
                  actions={panelActions(
                    'panel-api',
                    apiSeries.data?.sql,
                    apiSeries.data ? { kind: 'api', title: 'API requests', buckets: apiSeries.data.buckets } : null,
                  )}
                  sql={apiSeries.data?.sql}
                  isLoading={apiSeries.isLoading}
                  isRefreshing={apiSeries.isRefreshing}
                  error={apiSeries.error}
                  onRetry={apiSeries.reload}
                  isEmpty={!!apiSeries.data && apiSeries.data.buckets.length === 0}
                  emptyMessage="No requests in this window."
                  skeletonHeight={timelineHeight(layout)}
                >
                  {apiSeries.data && (
                    <ApiTimelineChart
                      buckets={apiSeries.data.buckets}
                      height={timelineHeight(layout)}
                      spanMs={spanMs}
                      compact={isPhone}
                      zoom={ZOOM_MODES[layout]}
                      onZoomBuckets={zoomTo(
                        apiSeries.data.buckets.map((bucket) => bucket.t),
                        apiSeries.data.range.bucketSeconds,
                      )}
                    />
                  )}
                </DashboardPanel>
              </Grid>
              <Grid size={{ xs: 12, lg: 6 }} sx={{ minWidth: 0 }}>
                <DashboardPanel
                  id="panel-logs"
                  title="Log severity"
                  headerExtra={
                    <SeverityChips
                      value={state.sev}
                      onChange={(sev) => update({ sev })}
                      large={isPhone}
                      label="Log severity filter"
                    />
                  }
                  actions={panelActions(
                    'panel-logs',
                    logSeries.data?.sql,
                    logSeries.data
                      ? { kind: 'logs', title: 'Log severity', buckets: logSeries.data.buckets, severities: state.sev }
                      : null,
                  )}
                  sql={logSeries.data?.sql}
                  isLoading={logSeries.isLoading}
                  isRefreshing={logSeries.isRefreshing}
                  error={logSeries.error}
                  onRetry={logSeries.reload}
                  isEmpty={!!logSeries.data && !hasSelectedLogs(logSeries.data.buckets, state.sev)}
                  emptyMessage="No log records of the selected severities in this window."
                  skeletonHeight={timelineHeight(layout)}
                >
                  {logSeries.data && (
                    <LogSeverityChart
                      buckets={logSeries.data.buckets}
                      severities={state.sev}
                      height={timelineHeight(layout)}
                      spanMs={spanMs}
                      compact={isPhone}
                      zoom={ZOOM_MODES[layout]}
                      onZoomBuckets={zoomTo(
                        logSeries.data.buckets.map((bucket) => bucket.t),
                        logSeries.data.range.bucketSeconds,
                      )}
                    />
                  )}
                </DashboardPanel>
              </Grid>
            </Grid>

            <TopProblems
              routes={topRoutes}
              errors={topErrors}
              layout={layout}
              actions={(kind) =>
                panelActions(
                  layout === 'phone' ? 'panel-top' : kind === 'routes' ? 'panel-top-routes' : 'panel-top-errors',
                  (kind === 'routes' ? topRoutes : topErrors).data?.sql,
                  topPanel(kind),
                )
              }
            />

            <EventsFeed
              events={events}
              sev={state.sev}
              q={state.q}
              onChange={update}
              layout={layout}
              onViewTrace={(traceId) => openSql(traceExplorerSql(traceId))}
              actions={panelActions(
                'panel-events',
                events.data?.sql,
                events.data
                  ? { kind: 'events', title: 'Recent events', items: events.items, severities: state.sev, q: state.q }
                  : null,
              )}
            />
          </Stack>
        )}
      </Box>

      {/* Assistant (#579): docked on desktop, an overlay drawer on tablets, full-screen on phones. */}
      {assistantAvailable && (
        <AssistantContainer
          open={assistantOpen}
          onClose={() => setAssistantOpen(false)}
          variant={assistantVariant}
          returnFocus={returnFocus}
        >
          <AssistantPanel
            key={draft?.key ?? 0}
            initialQuestion={draft?.text}
            messages={assistant.messages}
            isStreaming={assistant.isStreaming}
            onAsk={(question) => void assistant.ask(question)}
            onStop={assistant.stop}
            onNewChat={assistant.clear}
            // The dashboard has no editor: a report's query opens in the
            // Explorer — loaded, never run (the Explorer's handoff rule), so
            // "Insert and run" lands there too and waits for Run.
            onInsert={openSql}
            onInsertAndRun={openSql}
            modelCaption={modelCaption}
          />
        </AssistantContainer>
      )}
    </Container>
  );
}
