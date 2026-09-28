/**
 * Admin → Settings → AI Models (`/admin/settings/ai/models`) — issue #429,
 * epic #419.
 *
 * The organisation's model catalogue: every model a provider's key can see,
 * what it can do, and whether users may call it. Registered under the `AI`
 * card's route, so `settingsPageTitle` titles it "AI Models" (the Job
 * Insights precedent), and reachable only while AI is switched on — the
 * route's `RequireAiEnabled`.
 *
 * =============================================================================
 * NOTHING IS CALLABLE UNTIL AN ADMIN SAYS SO
 * =============================================================================
 *
 * Discovery (Refresh from provider) only ADDS rows; a new model arrives
 * disabled. The admin enables the ones users may call. A model the provider's
 * classifier did not recognise arrives `unclassified` and cannot be enabled
 * until an admin states what it can do (Edit capabilities) — guessing a
 * model's capabilities wrong is worse than refusing to guess.
 *
 * =============================================================================
 * REFRESH IS A JOB, NOT A REQUEST
 * =============================================================================
 *
 * `POST /admin/ai/models/refresh` enqueues `ai.catalog.refresh` and returns a
 * job id at once. The snackbar says so and links to the Jobs page; the table
 * is not re-read, because nothing has changed yet.
 *
 * =============================================================================
 * PER-MODEL LIMITS LIVE IN THE CONFIGURATION, NOT ON THE MODEL
 * =============================================================================
 *
 * The override dialog also edits a model's limits (#450), which are stored in
 * `ai.limits.perModel['<provider>:<modelId>']` — `PATCH /admin/ai/models/:id`
 * does not accept them. Saving the dialog therefore PATCHes the capabilities
 * as before and, only when a limit changed, re-saves the loaded configuration
 * with just this model's entry replaced (`PUT /admin/ai/config`, `If-Match:
 * version`, so a concurrent edit 409s instead of being overwritten).
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Container,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Snackbar,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import TuneIcon from '@mui/icons-material/Tune';
import { Navigate, Link as RouterLink } from 'react-router-dom';
import { DataTable } from '../../components/datatable';
import type { DataTableRowAction } from '../../components/datatable';
import { usePermissions } from '../../hooks/usePermissions';
import { useAiAdminConfig } from '../../hooks/useAiAdminConfig';
import { useAiModels } from '../../hooks/useAiModels';
import {
  AI_CAPABILITY_LABELS,
  AI_CAPABILITY_VALUES,
} from '../../components/ai/aiCapabilities';
import { AiModelOverrideDialog } from '../../components/admin/ai/AiModelOverrideDialog';
import {
  TABLE_ID,
  buildAiModelColumns,
  isDeprecated,
} from '../../components/admin/ai/aiModelColumns';
import { aiAdminConfigToInput, aiModelLimitKey, withModelLimits } from '../../services/ai';
import type {
  AiModel,
  AiModelCapabilities,
  AiModelLimits,
  AiModelListFilter,
} from '../../services/ai';

export default function AiModelsPage() {
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('ai_config:write');

  // Providers (and whether each has a key) come from the admin configuration.
  // Per-model limits (#450) are read from, and saved to, the same document.
  const {
    config,
    loadError: configError,
    save: saveConfig,
    isSaving: isSavingConfig,
    saveError: configSaveError,
    clearSaveError: clearConfigSaveError,
  } = useAiAdminConfig();

  const [provider, setProvider] = useState('');
  const [capability, setCapability] = useState('');
  const [includeDeprecated, setIncludeDeprecated] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);

  const filter: AiModelListFilter = {
    ...(provider ? { provider } : {}),
    ...(capability ? { capability } : {}),
    ...(includeDeprecated ? { includeDeprecated: true } : {}),
    ...(search.trim() ? { q: search.trim() } : {}),
    page: page + 1,
    pageSize,
  };
  const isFiltered = !!provider || !!capability || !!search.trim();

  const {
    models,
    total,
    isLoading,
    error,
    pendingIds,
    updateError,
    clearUpdateError,
    setEnabled,
    updateCapabilities,
    isRefreshing,
    refreshError,
    clearRefreshError,
    refreshCatalog,
  } = useAiModels(filter);

  const [editing, setEditing] = useState<AiModel | null>(null);
  const [queuedJobIds, setQueuedJobIds] = useState<string[] | null>(null);

  const onToggleEnabled = useCallback(
    (model: AiModel, enabled: boolean) => {
      void setEnabled(model, enabled);
    },
    [setEnabled],
  );

  const columns = useMemo(
    () => buildAiModelColumns({ canWrite, pendingIds, onToggleEnabled }),
    [canWrite, pendingIds, onToggleEnabled],
  );

  const rowActions = useMemo(() => {
    if (!canWrite) return [] as DataTableRowAction<AiModel>[];
    return [
      {
        id: 'edit-capabilities',
        label: 'Edit capabilities',
        icon: <TuneIcon fontSize="small" />,
        disabled: (model) => isDeprecated(model),
        onClick: (model) => {
          clearUpdateError();
          clearConfigSaveError();
          setEditing(model);
        },
      },
    ] satisfies DataTableRowAction<AiModel>[];
  }, [canWrite, clearUpdateError, clearConfigSaveError]);

  // Defence, not the gate — the route's `RequirePermission` checks the same
  // string. After every hook so the hook order never changes.
  if (!hasPermission('ai_config:read')) {
    return <Navigate to="/" replace />;
  }

  const providers = config?.providers ?? [];
  // Which providers "Refresh" acts on: the one selected, or every one with a
  // stored organization key — discovery uses that key and nothing else.
  const refreshTargets = (provider ? providers.filter((p) => p.id === provider) : providers).filter(
    (p) => p.keyStatus.configured,
  );
  const refreshBlockedReason = !canWrite
    ? 'Refreshing the catalogue needs ai_config:write'
    : !config
      ? 'Loading the providers…'
      : refreshTargets.length === 0
        ? 'Save an organization key for this provider on the AI page first — discovery uses it.'
        : null;

  const handleRefresh = async () => {
    const jobIds: string[] = [];
    for (const target of refreshTargets) {
      const jobId = await refreshCatalog(target.id);
      if (jobId) jobIds.push(jobId);
    }
    if (jobIds.length > 0) setQueuedJobIds(jobIds);
  };

  const editingLimits = editing
    ? config?.limits?.perModel?.[aiModelLimitKey(editing.provider, editing.modelId)]
    : undefined;

  const handleSave = async (capabilities: AiModelCapabilities, limits: AiModelLimits) => {
    if (!editing) return;
    const ok = await updateCapabilities(editing, capabilities);
    if (!ok) return;
    const limitsChanged =
      limits.maxOutputTokens !== editingLimits?.maxOutputTokens ||
      limits.requestsPerMinutePerUser !== editingLimits?.requestsPerMinutePerUser;
    if (limitsChanged && config) {
      // Read-modify-write: everything as loaded, only this model's entry replaced.
      const key = aiModelLimitKey(editing.provider, editing.modelId);
      const saved = await saveConfig({
        ...aiAdminConfigToInput(config),
        limits: withModelLimits(config.limits, key, limits),
      });
      if (!saved) return;
    }
    setEditing(null);
  };

  const emptyState = (
    <Typography color="text.secondary" data-testid="ai-models-empty">
      {isFiltered
        ? 'No models match these filters.'
        : 'No models yet. Save an admin key and refresh to discover models.'}
    </Typography>
  );

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        {/* Title and description MIRROR the `AI Models` card in `config/adminSections.tsx`. */}
        <Typography variant="h4" component="h1" gutterBottom>
          AI Models
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Review the models each provider offers, classify what they can do, and choose which ones
          users may call.
          {!canWrite && ' (read-only)'}
        </Typography>

        {!canWrite && (
          <Alert severity="info" sx={{ mb: 3 }} data-testid="ai-models-read-only-notice">
            You can read the catalogue but not change it. Enabling models, editing capabilities and
            refreshing all need <code>ai_config:write</code>.
          </Alert>
        )}

        {configError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {configError}
          </Alert>
        )}

        {/* ---------------------------------------------------------------
            TOOLBAR. Column on phones, a wrapping row from `sm` up — pure
            layout in `sx`, never a new breakpoint gate.
            ------------------------------------------------------------- */}
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          useFlexGap
          sx={{ mb: 2, alignItems: { sm: 'center' }, flexWrap: 'wrap' }}
        >
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel id="ai-models-provider-label">Provider</InputLabel>
            <Select
              labelId="ai-models-provider-label"
              label="Provider"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setPage(0);
              }}
            >
              <MenuItem value="">All providers</MenuItem>
              {providers.map((p) => (
                <MenuItem key={p.id} value={p.id}>
                  {p.displayName}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl size="small" sx={{ minWidth: 200 }}>
            <InputLabel id="ai-models-capability-label">Capability</InputLabel>
            <Select
              labelId="ai-models-capability-label"
              label="Capability"
              value={capability}
              onChange={(e) => {
                setCapability(e.target.value);
                setPage(0);
              }}
            >
              <MenuItem value="">Any capability</MenuItem>
              {AI_CAPABILITY_VALUES.map((value) => (
                <MenuItem key={value} value={value}>
                  {AI_CAPABILITY_LABELS[value] ?? value}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControlLabel
            control={
              <Switch
                checked={includeDeprecated}
                onChange={(e) => {
                  setIncludeDeprecated(e.target.checked);
                  setPage(0);
                }}
                slotProps={{ input: { 'aria-label': 'Show deprecated models' } }}
              />
            }
            label="Show deprecated"
          />

          <Box sx={{ flexGrow: 1 }} />

          <Tooltip title={refreshBlockedReason ?? 'Ask the provider which models its key can see'}>
            {/* A disabled button fires no events; the span carries the tooltip. */}
            <span>
              <Button
                variant="outlined"
                startIcon={<RefreshIcon />}
                disabled={!!refreshBlockedReason || isRefreshing}
                onClick={() => void handleRefresh()}
              >
                {isRefreshing ? 'Queuing…' : 'Refresh from provider'}
              </Button>
            </span>
          </Tooltip>
        </Stack>

        {refreshError && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={clearRefreshError}>
            {refreshError}
          </Alert>
        )}

        {/* Only while no dialog is open: the dialog shows its own copy. */}
        {updateError && !editing && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={clearUpdateError} data-testid="ai-models-update-error">
            {updateError}
          </Alert>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <Paper sx={{ width: '100%', p: 2 }}>
          <Box sx={{ minWidth: 0 }}>
            <DataTable<AiModel>
              tableId={TABLE_ID}
              data-testid="admin-ai-models-table"
              ariaLabel="AI models"
              columns={columns}
              rows={models}
              rowId={(model) => model.id}
              loading={isLoading}
              emptyState={emptyState}
              pagination={{
                page,
                pageSize,
                total,
                pageSizeOptions: [10, 20, 50, 100],
                onPaginationChange: (next) => {
                  setPage(next.page);
                  setPageSize(next.pageSize);
                },
              }}
              quickSearch={{
                value: search,
                ariaLabel: 'Search models',
                placeholder: 'Search models',
                onChange: (next) => {
                  setSearch(next);
                  setPage(0);
                },
              }}
              rowActions={rowActions}
              disableExport
            />
          </Box>
        </Paper>

        <AiModelOverrideDialog
          model={editing}
          isSaving={!!editing && (pendingIds.has(editing.id) || isSavingConfig)}
          error={editing ? (updateError ?? configSaveError) : null}
          limits={editingLimits}
          limitsUnavailable={!config}
          onSave={(capabilities, limits) => void handleSave(capabilities, limits)}
          onClose={() => {
            setEditing(null);
            clearUpdateError();
            clearConfigSaveError();
          }}
        />

        <Snackbar
          open={!!queuedJobIds}
          autoHideDuration={8000}
          onClose={() => setQueuedJobIds(null)}
          message={
            queuedJobIds
              ? `Refresh queued (job ${queuedJobIds.join(', ')})`
              : undefined
          }
          action={
            <Button color="inherit" size="small" component={RouterLink} to="/admin/settings/jobs">
              View jobs
            </Button>
          }
        />
      </Box>
    </Container>
  );
}
