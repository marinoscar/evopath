/**
 * Console → Observability → Telemetry Explorer — issue #537, epic #528.
 *
 * Ad-hoc, read-only SQL over the deployment's telemetry (GreptimeDB): a schema
 * browser, a CodeMirror SQL editor with schema-aware completion, a result
 * grid, export (CSV, Excel, Parquet, NDJSON), starter queries, a per-browser
 * history, and an AI assistant that investigates by running queries server-side.
 *
 * Gates: the route requires `telemetry:query` (what the explorer controller
 * enforces) AND the `telemetry` feature (`RequireTelemetryEnabled`). The
 * assistant additionally needs `ai:use`, AI switched on, and the assistant
 * enabled in the Telemetry settings. Every one of those is enforced by the API;
 * the browser only hides what would be refused. The SQL typed here is sent
 * verbatim — the API's guard decides whether it is read-only.
 *
 * Layout: schema | editor + results on `sm` and up; stacked on phones, with
 * the schema in a drawer and the assistant full-screen. `sm` (600px) is the
 * only breakpoint, per the settings UI spec.
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  Container,
  Drawer,
  IconButton,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Skeleton,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import DownloadIcon from '@mui/icons-material/Download';
import LibraryBooksOutlinedIcon from '@mui/icons-material/LibraryBooksOutlined';
import HistoryIcon from '@mui/icons-material/History';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined';
import CloseIcon from '@mui/icons-material/Close';
import MonitorHeartOutlinedIcon from '@mui/icons-material/MonitorHeartOutlined';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useTelemetryAssistantAvailable } from '../../hooks/useTelemetryAssistantAvailable';
import {
  telemetryErrorTitle,
  toTelemetryError,
  useTelemetryAssistantModel,
  useTelemetryQuery,
  useTelemetrySchema,
  type TelemetryErrorInfo,
} from '../../hooks/useTelemetryExplorer';
import { useTelemetryAssistant } from '../../hooks/useTelemetryAssistant';
import {
  TELEMETRY_EXPORT_FORMATS,
  TELEMETRY_EXPORT_LABELS,
  exportTelemetry,
  type TelemetryExportFormat,
} from '../../services/telemetry';
import type { SqlEditorHandle } from '../../components/telemetry/SqlEditor';
import { SchemaPanel } from '../../components/telemetry/SchemaPanel';
import { ResultsGrid } from '../../components/telemetry/ResultsGrid';
import { AssistantPanel } from '../../components/telemetry/AssistantPanel';
import { ASSISTANT_WIDTH, AssistantContainer } from '../../components/telemetry/AssistantContainer';
import { STARTER_QUERIES, traceQuery } from '../../components/telemetry/starterQueries';
import { pushQueryHistory, readQueryHistory } from '../../components/telemetry/queryHistory';
import {
  EXPLORER_SQL_PARAM,
  TELEMETRY_DASHBOARD_PATH,
  readExplorerHandoff,
} from '../../components/telemetry/explorerHandoff';
import { TelemetryCrossLink } from '../../components/telemetry/TelemetryCrossLink';

// The editor is its own chunk: CodeMirror is by far the heaviest thing here.
const SqlEditor = lazy(() => import('../../components/telemetry/SqlEditor'));

/** Mirrors the `Telemetry Explorer` card in `config/adminSections.tsx`. */
const PAGE_TITLE = 'Telemetry Explorer';
const PAGE_DESCRIPTION =
  'Query traces, logs and metrics with SQL, export the results, and ask the AI assistant for help.';

const SCHEMA_WIDTH = 260;

/**
 * A refusal or failure, as the API worded it. The heading branches on
 * `details.reason`; the reason code itself is shown too, for a bug report.
 */
function ErrorAlert({
  error,
  testId,
  onClose,
}: {
  error: TelemetryErrorInfo;
  testId: string;
  onClose?: () => void;
}) {
  const unavailable =
    error.reason === 'TELEMETRY_NOT_CONFIGURED' ||
    error.reason === 'TELEMETRY_UNREACHABLE' ||
    error.reason === 'TELEMETRY_DISABLED';
  return (
    <Alert
      severity={error.reason === 'TELEMETRY_QUERY_TIMEOUT' || unavailable ? 'warning' : 'error'}
      data-testid={testId}
      sx={{ mb: 2 }}
      onClose={onClose}
    >
      <AlertTitle>{telemetryErrorTitle(error)}</AlertTitle>
      <Box component="span" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {error.message}
      </Box>
      {error.reason === 'TELEMETRY_QUERY_TIMEOUT' && (
        <Box component="span" sx={{ display: 'block', mt: 0.5 }}>
          Narrow the time range or add a <code>LIMIT</code>.
        </Box>
      )}
      {(error.reason ?? error.code) && (
        <Typography variant="caption" component="div" sx={{ mt: 0.5, opacity: 0.8 }}>
          {error.reason ?? error.code}
        </Typography>
      )}
    </Alert>
  );
}

function truncateLabel(sql: string, max = 80): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export default function TelemetryExplorerPage() {
  const theme = useTheme();
  const isCompact = useMediaQuery(theme.breakpoints.down('sm'));
  const { hasPermission } = usePermissions();

  const schema = useTelemetrySchema();
  const query = useTelemetryQuery();

  // A statement handed over by the Telemetry Dashboard (#579) — `state.sql`,
  // or `?sql=` from a plain link. Read ONCE: it seeds the editor and is never
  // run; the reader reviews it and presses Run.
  const location = useLocation();
  const navigate = useNavigate();
  const [handoff] = useState(() => readExplorerHandoff(location.state, new URLSearchParams(location.search)));
  const [handoffNotice, setHandoffNotice] = useState(handoff !== null);

  const [sql, setSql] = useState<string>(() => handoff ?? STARTER_QUERIES[0].sql);
  const [history, setHistory] = useState<string[]>(() => readQueryHistory());
  const [schemaOpen, setSchemaOpen] = useState(true);
  const [schemaDrawerOpen, setSchemaDrawerOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [exporting, setExporting] = useState<TelemetryExportFormat | null>(null);
  const [exportError, setExportError] = useState<TelemetryErrorInfo | null>(null);
  const [exportAnchor, setExportAnchor] = useState<HTMLElement | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [starterAnchor, setStarterAnchor] = useState<HTMLElement | null>(null);
  const [historyAnchor, setHistoryAnchor] = useState<HTMLElement | null>(null);

  const editorRef = useRef<SqlEditorHandle | null>(null);

  const assistantAvailable = useTelemetryAssistantAvailable();
  const modelCaption = useTelemetryAssistantModel(
    assistantAvailable && hasPermission('telemetry:read'),
  );

  // Drop the handoff from the URL and the history entry (replace), so a
  // reload or a shared link does not carry it again. Once, on mount.
  const initialLocation = useRef(location);
  useEffect(() => {
    const { pathname, search, hash, state } = initialLocation.current;
    const params = new URLSearchParams(search);
    const hasState = typeof state === 'object' && state !== null && 'sql' in state;
    if (!params.has(EXPLORER_SQL_PARAM) && !hasState) return;
    params.delete(EXPLORER_SQL_PARAM);
    const rest = params.toString();
    navigate({ pathname, search: rest ? `?${rest}` : '', hash }, { replace: true, state: null });
  }, [navigate]);

  const { run } = query;
  const runSql = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      setHistory(pushQueryHistory(text));
      void run(text);
    },
    [run],
  );

  const assistant = useTelemetryAssistant({
    // The agent already ran its queries (#571): the answer's primary query goes
    // into the editor, but is not re-run — the report's buttons run on demand.
    onAnswer: (answer) => {
      if (answer.sql) setSql(answer.sql);
    },
  });

  // Defence, not the gate — `App.tsx` wraps the route in `RequirePermission`.
  if (!hasPermission('telemetry:query')) {
    return <Navigate to="/" replace />;
  }

  const insertAtCursor = (text: string) => {
    if (editorRef.current) editorRef.current.insertAtCursor(text);
    else setSql((prev) => (prev ? `${prev} ${text}` : text));
    if (isCompact) setSchemaDrawerOpen(false);
  };

  const replaceSql = (text: string) => {
    setSql(text);
    editorRef.current?.focus();
  };

  const handleTraceClick = (traceId: string) => {
    const text = traceQuery(traceId);
    setSql(text);
    runSql(text);
  };

  const handleExport = async (format: TelemetryExportFormat) => {
    setExportAnchor(null);
    setExporting(format);
    setExportError(null);
    try {
      const exported = await exportTelemetry(sql, format);
      if (exported.truncated) {
        setExportNotice(
          exported.rowCount !== null
            ? `Export truncated at ${exported.rowCount.toLocaleString()} rows — ${exported.filename} does not hold the full result.`
            : `Export truncated — ${exported.filename} does not hold the full result.`,
        );
      }
    } catch (err) {
      setExportError(toTelemetryError(err, 'The export failed'));
    } finally {
      setExporting(null);
    }
  };

  const openMenu = (setter: (el: HTMLElement | null) => void) => (event: MouseEvent<HTMLElement>) =>
    setter(event.currentTarget);

  const schemaPanel = (
    <SchemaPanel
      tables={schema.tables}
      isLoading={schema.isLoading}
      error={schema.error}
      onInsert={insertAtCursor}
    />
  );

  const assistantPanel = (
    <AssistantPanel
      messages={assistant.messages}
      isStreaming={assistant.isStreaming}
      onAsk={(question) => void assistant.ask(question)}
      onStop={assistant.stop}
      onNewChat={assistant.clear}
      onInsert={replaceSql}
      onInsertAndRun={(text) => {
        setSql(text);
        runSql(text);
      }}
      modelCaption={modelCaption}
    />
  );

  const result = query.result;
  const showAssistantDrawer = assistantAvailable && assistantOpen && !isCompact;

  return (
    <Container maxWidth={false} sx={{ maxWidth: 1600 }}>
      <Box
        sx={{
          py: 4,
          // Leave room for the docked assistant so it never covers results.
          pr: showAssistantDrawer ? `${ASSISTANT_WIDTH}px` : 0,
          minWidth: 0,
        }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
          <Typography variant="h4" component="h1" sx={{ flex: 1, minWidth: 0 }}>
            {PAGE_TITLE}
          </Typography>
          <TelemetryCrossLink
            to={TELEMETRY_DASHBOARD_PATH}
            label="Dashboard"
            compactLabel="Open Telemetry Dashboard"
            icon={<MonitorHeartOutlinedIcon />}
            compact={isCompact}
          />
        </Stack>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          {PAGE_DESCRIPTION}
        </Typography>

        {/* ---------------------------------------------------------------
            TOOLBAR
            ------------------------------------------------------------- */}
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 2 }}
          role="toolbar"
          aria-label="Query toolbar"
        >
          {query.isRunning ? (
            <Button
              variant="contained"
              color="inherit"
              onClick={query.cancel}
              startIcon={<CircularProgress size={16} />}
              endIcon={<StopIcon />}
            >
              Cancel
            </Button>
          ) : (
            <Tooltip title="Run (Ctrl/⌘ + Enter)">
              <span>
                <Button
                  variant="contained"
                  onClick={() => runSql(sql)}
                  disabled={!sql.trim()}
                  startIcon={<PlayArrowIcon />}
                >
                  Run
                </Button>
              </span>
            </Tooltip>
          )}
          <Button
            onClick={openMenu(setExportAnchor)}
            disabled={!sql.trim() || exporting !== null}
            startIcon={exporting ? <CircularProgress size={16} /> : <DownloadIcon />}
            aria-haspopup="menu"
          >
            Export
          </Button>
          <Button onClick={openMenu(setStarterAnchor)} startIcon={<LibraryBooksOutlinedIcon />} aria-haspopup="menu">
            Starter queries
          </Button>
          <Button onClick={openMenu(setHistoryAnchor)} startIcon={<HistoryIcon />} aria-haspopup="menu">
            History
          </Button>
          <Button
            onClick={() => (isCompact ? setSchemaDrawerOpen(true) : setSchemaOpen((open) => !open))}
            startIcon={<TableChartOutlinedIcon />}
            aria-pressed={isCompact ? undefined : schemaOpen}
          >
            Schema
          </Button>
          {assistantAvailable && (
            <Button
              onClick={() => setAssistantOpen((open) => !open)}
              startIcon={<AutoAwesomeOutlinedIcon />}
              aria-pressed={assistantOpen}
              variant={assistantOpen ? 'outlined' : 'text'}
            >
              Assistant
            </Button>
          )}
        </Stack>

        <Menu anchorEl={exportAnchor} open={!!exportAnchor} onClose={() => setExportAnchor(null)}>
          {TELEMETRY_EXPORT_FORMATS.map((format) => (
            <MenuItem key={format} onClick={() => void handleExport(format)}>
              {TELEMETRY_EXPORT_LABELS[format]}
            </MenuItem>
          ))}
        </Menu>
        <Menu anchorEl={starterAnchor} open={!!starterAnchor} onClose={() => setStarterAnchor(null)}>
          {STARTER_QUERIES.map((starter) => (
            <MenuItem
              key={starter.id}
              onClick={() => {
                setStarterAnchor(null);
                replaceSql(starter.sql);
              }}
            >
              {starter.title}
            </MenuItem>
          ))}
        </Menu>
        <Menu
          anchorEl={historyAnchor}
          open={!!historyAnchor}
          onClose={() => setHistoryAnchor(null)}
          slotProps={{ paper: { sx: { maxWidth: { xs: '90vw', sm: 560 } } } }}
        >
          {history.length === 0 && <MenuItem disabled>No queries run yet</MenuItem>}
          {history.map((entry) => (
            <MenuItem
              key={entry}
              onClick={() => {
                setHistoryAnchor(null);
                replaceSql(entry);
              }}
            >
              <ListItemText
                primary={truncateLabel(entry)}
                slotProps={{ primary: { sx: { fontFamily: 'monospace', fontSize: 12 } } }}
              />
            </MenuItem>
          ))}
        </Menu>

        {handoffNotice && (
          <Alert
            severity="info"
            data-testid="handoff-notice"
            sx={{ mb: 2 }}
            onClose={() => setHandoffNotice(false)}
          >
            Query loaded from the Telemetry Dashboard. Review it and press Run.
          </Alert>
        )}

        {exportError && (
          <ErrorAlert error={exportError} testId="export-error" onClose={() => setExportError(null)} />
        )}

        {/* ---------------------------------------------------------------
            SCHEMA | EDITOR + RESULTS
            ------------------------------------------------------------- */}
        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 2, minWidth: 0 }}>
          {!isCompact && schemaOpen && (
            <Paper
              variant="outlined"
              component="aside"
              aria-label="Schema"
              sx={{ width: SCHEMA_WIDTH, flexShrink: 0, p: 1.5, maxHeight: '75vh', display: 'flex', flexDirection: 'column' }}
            >
              {schemaPanel}
            </Paper>
          )}

          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Paper variant="outlined" sx={{ mb: 2, overflow: 'hidden' }}>
              <Suspense fallback={<Skeleton variant="rectangular" height={160} />}>
                <SqlEditor
                  ref={editorRef}
                  value={sql}
                  onChange={setSql}
                  onRun={() => runSql(sql)}
                  tables={schema.tables}
                  mode={theme.palette.mode}
                />
              </Suspense>
            </Paper>

            {query.error && <ErrorAlert error={query.error} testId="query-error" />}

            {result && (
              <>
                {result.truncated && (
                  <Alert severity="warning" sx={{ mb: 1 }} data-testid="truncated-banner">
                    Results truncated at {result.rowCount.toLocaleString()} rows. Add a{' '}
                    <code>LIMIT</code> or a tighter <code>WHERE</code>, or export for the full set.
                  </Alert>
                )}
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ mb: 1 }}
                  data-testid="query-status"
                  aria-live="polite"
                >
                  {result.rowCount.toLocaleString()} row{result.rowCount === 1 ? '' : 's'} ·{' '}
                  {Math.round(result.elapsedMs).toLocaleString()} ms
                </Typography>
                <ResultsGrid result={result} onTraceClick={handleTraceClick} />
              </>
            )}
            {!result && !query.error && !query.isRunning && (
              <Typography variant="body2" color="text.secondary">
                Run a query to see results here. Pick a starter query to begin.
              </Typography>
            )}
          </Box>
        </Box>
      </Box>

      <Snackbar
        open={!!exportNotice}
        autoHideDuration={8000}
        onClose={() => setExportNotice(null)}
        message={exportNotice}
      />

      {/* Schema on phones: a drawer from the left. */}
      <Drawer
        anchor="left"
        open={isCompact && schemaDrawerOpen}
        onClose={() => setSchemaDrawerOpen(false)}
        slotProps={{ paper: { sx: { width: '85vw', maxWidth: 360, p: 2 } } }}
      >
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="h6" component="h2">
            Schema
          </Typography>
          <IconButton aria-label="Close schema" onClick={() => setSchemaDrawerOpen(false)}>
            <CloseIcon />
          </IconButton>
        </Stack>
        {schemaPanel}
      </Drawer>

      {/* Assistant: a docked drawer on the right from `sm` up, full-screen on phones. */}
      {assistantAvailable && (
        <AssistantContainer
          open={assistantOpen}
          onClose={() => setAssistantOpen(false)}
          variant={isCompact ? 'fullscreen' : 'docked'}
        >
          {assistantPanel}
        </AssistantContainer>
      )}
    </Container>
  );
}
