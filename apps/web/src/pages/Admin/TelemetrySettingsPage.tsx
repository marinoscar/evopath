/**
 * Console → Observability → Telemetry — issue #537, epic #528.
 *
 * The deployment's telemetry POLICY: whether it is collected, how long it is
 * kept, how this deployment labels what it exports (`app.instance.id`, #565),
 * how much a single explorer query may return, and whether (and with which
 * model) the AI assistant may help. Plus a live status card so an
 * operator can see whether the store is actually there.
 *
 * The Connection section (#558, `components/telemetry/TelemetryConnectionSection`)
 * is where the API's GreptimeDB host and logins are set. It is a section of
 * this page — the same destination — not a card or a tab of its own, and it
 * saves on its own `If-Match` version, separate from the policy form's.
 *
 * The Telemetry services section (#567, `components/telemetry/TelemetryServicesSection`)
 * sits just above it: the GreptimeDB containers' state and a one-click
 * (re)deploy. Also a section, not a card or tab; it is shown for
 * `system_settings:read` and deploys need `system_settings:write` — what the
 * `/admin/telemetry/stack` routes enforce.
 *
 * Gates: the route requires `telemetry:read` (the card's permission, what
 * `telemetry-admin.controller.ts` enforces on its GETs). Saving needs
 * `telemetry:write`; without it every control is disabled — the API is the
 * real gate either way. Saves send `If-Match: <version>`; a 409 means someone
 * else saved first and the page offers a reload.
 *
 * NOT behind `RequireTelemetryEnabled`: this is where telemetry is switched on.
 */
import { useContext, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Container,
  Divider,
  FormControlLabel,
  FormHelperText,
  Link,
  ListItemText,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import MonitorHeartOutlinedIcon from '@mui/icons-material/MonitorHeartOutlined';
import { Link as RouterLink, Navigate } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useTelemetryAdmin } from '../../hooks/useTelemetryAdmin';
import { TelemetryConfigContext, isTelemetryOn, useTelemetryConfig } from '../../hooks/useTelemetryConfig';
import { TelemetryCrossLink } from '../../components/telemetry/TelemetryCrossLink';
import { TELEMETRY_DASHBOARD_PATH } from '../../components/telemetry/explorerHandoff';
import { useAiConfig } from '../../hooks/useAiConfig';
import { useAiModels } from '../../hooks/useAiModels';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import {
  TELEMETRY_CONNECTION_SECTION_ID,
  TelemetryConnectionSection,
} from '../../components/telemetry/TelemetryConnectionSection';
import { TelemetryServicesSection } from '../../components/telemetry/TelemetryServicesSection';
import {
  TELEMETRY_INSTANCE_ID_PATTERN,
  TELEMETRY_LIMITS,
  type TelemetryAdminConfig,
  type TelemetrySettings,
  type TelemetryStatus,
} from '../../services/telemetry';
import type { AiModel } from '../../services/ai';

/** Mirrors the `Telemetry` card in `config/adminSections.tsx`. */
const PAGE_TITLE = 'Telemetry';
const PAGE_DESCRIPTION =
  'Turn telemetry collection on, choose how long it is kept, set query limits and configure the AI assistant.';

export const RETENTION_PRESETS = [7, 30, 90, 180, 365] as const;

/** Number inputs are kept as strings so a half-typed value can be shown and validated. */
interface FormState {
  enabled: boolean;
  /** `''` follows the default (sent as `null`). */
  instanceId: string;
  retentionMode: 'preset' | 'custom';
  retentionDays: string;
  maxRows: string;
  timeoutSeconds: string;
  assistantEnabled: boolean;
  /** `provider:modelId`, or `''` for none. */
  model: string;
  shareResults: boolean;
  maxResultRowsToModel: string;
  maxSteps: string;
}

type NumberField = 'retentionDays' | 'maxRows' | 'timeoutSeconds' | 'maxResultRowsToModel' | 'maxSteps';

const FIELD_LIMITS: Record<NumberField, { min: number; max: number }> = {
  retentionDays: TELEMETRY_LIMITS.retentionDays,
  maxRows: TELEMETRY_LIMITS.maxRows,
  timeoutSeconds: TELEMETRY_LIMITS.timeoutSeconds,
  maxResultRowsToModel: TELEMETRY_LIMITS.maxResultRowsToModel,
  maxSteps: TELEMETRY_LIMITS.maxSteps,
};

function modelKey(provider: string | null, modelId: string | null): string {
  return provider && modelId ? `${provider}:${modelId}` : '';
}

function toFormState(config: TelemetryAdminConfig): FormState {
  const preset = (RETENTION_PRESETS as readonly number[]).includes(config.retentionDays);
  return {
    enabled: config.enabled,
    instanceId: config.instanceId ?? '',
    retentionMode: preset ? 'preset' : 'custom',
    retentionDays: String(config.retentionDays),
    maxRows: String(config.query.maxRows),
    timeoutSeconds: String(config.query.timeoutSeconds),
    assistantEnabled: config.assistant.enabled,
    model: modelKey(config.assistant.provider, config.assistant.modelId),
    shareResults: config.assistant.shareResults,
    maxResultRowsToModel: String(config.assistant.maxResultRowsToModel),
    maxSteps: String(config.assistant.maxSteps),
  };
}

/** `null` when valid, else the message to show under the field. */
export function validateInteger(value: string, limits: { min: number; max: number }): string | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return `Enter a whole number from ${limits.min} to ${limits.max}.`;
  const n = Number(trimmed);
  if (n < limits.min || n > limits.max) return `Must be from ${limits.min} to ${limits.max}.`;
  return null;
}

/**
 * `null` when valid (blank is valid: it follows the default), else the message
 * to show under the field. Mirrors the API's pattern; the API is the gate.
 */
export function validateInstanceId(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (TELEMETRY_INSTANCE_ID_PATTERN.test(trimmed)) return null;
  return 'Use 1-63 lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.';
}

type FieldErrors = Partial<Record<NumberField | 'instanceId', string>>;

function validate(form: FormState): FieldErrors {
  const errors: FieldErrors = {};
  for (const field of Object.keys(FIELD_LIMITS) as NumberField[]) {
    const error = validateInteger(form[field], FIELD_LIMITS[field]);
    if (error) errors[field] = error;
  }
  const instanceIdError = validateInstanceId(form.instanceId);
  if (instanceIdError) errors.instanceId = instanceIdError;
  return errors;
}

function toSettings(form: FormState): TelemetrySettings {
  const separator = form.model.indexOf(':');
  const provider = separator > 0 ? form.model.slice(0, separator) : null;
  const modelId = separator > 0 ? form.model.slice(separator + 1) : null;
  const instanceId = form.instanceId.trim();
  return {
    enabled: form.enabled,
    instanceId: instanceId === '' ? null : instanceId,
    retentionDays: Number(form.retentionDays),
    query: { maxRows: Number(form.maxRows), timeoutSeconds: Number(form.timeoutSeconds) },
    assistant: {
      enabled: form.assistantEnabled,
      provider,
      modelId,
      shareResults: form.shareResults,
      maxResultRowsToModel: Number(form.maxResultRowsToModel),
      maxSteps: Number(form.maxSteps),
    },
  };
}

function formatRows(rows: number | null): string {
  return rows === null ? '—' : rows.toLocaleString();
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Paper sx={{ p: { xs: 2, sm: 3 }, mb: 3 }} component="section" aria-label={title}>
      <Typography variant="h6" component="h2" gutterBottom>
        {title}
      </Typography>
      {children}
    </Paper>
  );
}

/** An in-page link to the Connection section. */
function ConnectionLink({ children }: { children: ReactNode }) {
  return <Link href={`#${TELEMETRY_CONNECTION_SECTION_ID}`}>{children}</Link>;
}

function StatusCard({
  status,
  error,
  onRefresh,
}: {
  status: TelemetryStatus | null;
  error: string | null;
  onRefresh: () => void;
}) {
  return (
    <Section title="Status">
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {status && !status.configured && (
        <Alert severity="warning" sx={{ mb: 2 }} data-testid="telemetry-not-configured">
          <AlertTitle>GreptimeDB not configured</AlertTitle>
          The API has no connection to a telemetry store. Enter the GreptimeDB logins in
          the <ConnectionLink>Connection</ConnectionLink> section and save. GreptimeDB is
          deployed with this application; settings saved here take effect once it is reachable,
          with no restart needed.
        </Alert>
      )}
      {status && (
        <>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mb: 2 }}>
            <Chip
              size="small"
              color={status.configured ? 'success' : 'default'}
              label={status.configured ? 'Configured' : 'Not configured'}
            />
            {status.configured && (
              <Chip
                size="small"
                color={status.reachable ? 'success' : 'error'}
                label={status.reachable ? 'Reachable' : 'Unreachable'}
              />
            )}
          </Stack>
          {status.configured && status.error && (
            <Alert severity={status.reachable ? 'warning' : 'error'} sx={{ mb: 2 }}>
              {status.error}
            </Alert>
          )}
          <Box
            component="dl"
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: 'max-content 1fr' },
              columnGap: 3,
              rowGap: 0.5,
              m: 0,
              '& dt': { color: 'text.secondary' },
              '& dd': { m: 0, mb: { xs: 1, sm: 0 }, wordBreak: 'break-word' },
            }}
          >
            <dt>Version</dt>
            <dd>{status.version ?? '—'}</dd>
            <dt>Database</dt>
            <dd>{status.database}</dd>
            <dt>Retention in force</dt>
            <dd>
              {status.ttl
                ? status.ttl.days !== null
                  ? `${status.ttl.days} days (${status.ttl.raw})`
                  : status.ttl.raw
                : 'None set'}
              {status.ttl?.days != null && status.ttl.days !== status.retentionDays && (
                <Typography component="span" variant="body2" color="warning.main" sx={{ ml: 1 }}>
                  (setting is {status.retentionDays} days — the background job has not applied it yet)
                </Typography>
              )}
            </dd>
          </Box>
          {status.tables.length > 0 && (
            <Box sx={{ mt: 2, overflowX: 'auto' }}>
              <Table size="small" aria-label="Telemetry tables">
                <TableHead>
                  <TableRow>
                    <TableCell>Table</TableCell>
                    <TableCell align="right">Rows</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {status.tables.map((table) => (
                    <TableRow key={table.name}>
                      <TableCell sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                        {table.name}
                      </TableCell>
                      <TableCell align="right">{formatRows(table.rows)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          )}
        </>
      )}
      <Box sx={{ mt: 2 }}>
        <Button size="small" onClick={onRefresh}>
          Refresh status
        </Button>
      </Box>
    </Section>
  );
}

function modelLabel(model: AiModel): string {
  return model.displayName || model.modelId;
}

function supportsTools(model: AiModel): boolean {
  return model.capabilities?.capabilities.includes('tools') ?? false;
}

/**
 * Provider + model picker over the admin AI catalogue (`listAiModels` via
 * `useAiModels`, enabled models only). Tool-calling models are listed first:
 * the assistant works by calling tools. Mounted only for a holder of
 * `ai_config:read`, which the catalogue route requires.
 */
function AssistantModelSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (key: string) => void;
  disabled: boolean;
}) {
  const { models, isLoading, error } = useAiModels({ enabled: true, pageSize: 100 });
  const sorted = useMemo(
    () =>
      [...models].sort((a, b) => Number(supportsTools(b)) - Number(supportsTools(a))),
    [models],
  );
  const known = sorted.some((model) => modelKey(model.provider, model.modelId) === value);

  return (
    <TextField
      select
      fullWidth
      size="small"
      label="Model"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled || isLoading}
      helperText={
        error ??
        'Choose an enabled model. Models that support tool calling are listed first — the assistant needs it.'
      }
      error={!!error}
      slotProps={{ htmlInput: { 'aria-label': 'Assistant model' } }}
    >
      <MenuItem value="">
        <ListItemText primary="Not set" secondary="The assistant cannot run until a model is chosen" />
      </MenuItem>
      {!known && value && (
        <MenuItem value={value}>
          <ListItemText primary={value} secondary="Stored, but not an enabled model" />
        </MenuItem>
      )}
      {sorted.map((model) => (
        <MenuItem key={model.id} value={modelKey(model.provider, model.modelId)}>
          <ListItemText
            primary={modelLabel(model)}
            secondary={`${model.provider}${supportsTools(model) ? ' · tool calling' : ' · tool calling not declared'}`}
          />
        </MenuItem>
      ))}
    </TextField>
  );
}

function NumberInput({
  label,
  field,
  form,
  errors,
  disabled,
  helper,
  onChange,
}: {
  label: string;
  field: NumberField;
  form: FormState;
  errors: FieldErrors;
  disabled: boolean;
  helper: string;
  onChange: (field: NumberField, value: string) => void;
}) {
  const limits = FIELD_LIMITS[field];
  return (
    <TextField
      label={label}
      type="number"
      size="small"
      value={form[field]}
      onChange={(event) => onChange(field, event.target.value)}
      disabled={disabled}
      error={!!errors[field]}
      helperText={errors[field] ?? helper}
      slotProps={{ htmlInput: { min: limits.min, max: limits.max, step: 1, inputMode: 'numeric' } }}
      sx={{ width: { xs: '100%', sm: 260 } }}
    />
  );
}

export default function TelemetrySettingsPage() {
  const { hasPermission } = usePermissions();
  const {
    config,
    status,
    isLoading,
    loadError,
    statusError,
    isSaving,
    saveError,
    conflict,
    reload,
    refreshStatus,
    save,
  } = useTelemetryAdmin();
  const { config: aiConfig } = useAiConfig();
  // The shell's shared `GET /telemetry/config`. Refreshed after a save so the
  // hub, the rail and the explorer route learn at once. With no shell above
  // (a test), there is nothing to refresh.
  const sharedTelemetryConfig = useContext(TelemetryConfigContext);
  // "Open dashboard" (#579) follows the dashboard route's own gates: the
  // `telemetry` feature (store deployed AND collecting) and `telemetry:query`.
  const { config: publicTelemetryConfig } = useTelemetryConfig();
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));

  const [form, setForm] = useState<FormState | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  // Bumped after a telemetry services deploy so the Connection section re-reads.
  const [connectionRefresh, setConnectionRefresh] = useState(0);

  useEffect(() => {
    if (config) setForm(toFormState(config));
  }, [config]);

  // Defence, not the gate — `App.tsx` wraps the route in `RequirePermission`.
  if (!hasPermission('telemetry:read')) {
    return <Navigate to="/" replace />;
  }

  const canWrite = hasPermission('telemetry:write');
  const canOpenDashboard = isTelemetryOn(publicTelemetryConfig) && hasPermission('telemetry:query');
  const canPickModel = hasPermission('ai_config:read');
  // The Telemetry services section (#567) follows `telemetry-stack` routes,
  // which enforce `system_settings:read` / `system_settings:write`.
  const canViewServices = hasPermission('system_settings:read');
  const canDeployServices = hasPermission('system_settings:write');

  if (isLoading && !form) {
    return <LoadingSpinner />;
  }

  const errors = form ? validate(form) : {};
  const invalid = Object.keys(errors).length > 0;
  const isDirty =
    !!form && !!config && JSON.stringify(form) !== JSON.stringify(toFormState(config));
  const locked = !canWrite || isSaving;

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };
  const updateNumber = (field: NumberField, value: string) => update(field, value);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || invalid || !canWrite) return;
    const ok = await save(toSettings(form));
    if (ok) {
      setSavedMessage('Telemetry settings saved');
      void sharedTelemetryConfig?.refresh();
    }
  };

  const retentionToggleValue =
    form?.retentionMode === 'custom' ? 'custom' : (form?.retentionDays ?? '');

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
          <Typography variant="h4" component="h1" sx={{ flex: 1, minWidth: 0 }}>
            {PAGE_TITLE}
          </Typography>
          {canOpenDashboard && (
            <TelemetryCrossLink
              to={TELEMETRY_DASHBOARD_PATH}
              label="Open dashboard"
              compactLabel="Open Telemetry Dashboard"
              icon={<MonitorHeartOutlinedIcon />}
              compact={isPhone}
            />
          )}
        </Stack>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          {PAGE_DESCRIPTION}
          {!canWrite && ' (read-only)'}
        </Typography>

        {config?.updatedBy && config.updatedAt && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Last updated by {config.updatedBy.email} on {new Date(config.updatedAt).toLocaleString()}
          </Typography>
        )}

        {loadError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {loadError}
          </Alert>
        )}

        {!canWrite && !loadError && (
          <Alert severity="info" sx={{ mb: 3 }} data-testid="telemetry-read-only-notice">
            You can read this configuration but not change it. Saving needs{' '}
            <code>telemetry:write</code>.
          </Alert>
        )}

        {canViewServices && (
          <TelemetryServicesSection
            canDeploy={canDeployServices}
            onDeployed={() => {
              // A fresh store changes the connection test, `available` and the
              // status — refresh them all, and the shell's shared flag.
              setConnectionRefresh((n) => n + 1);
              void reload();
              void sharedTelemetryConfig?.refresh();
            }}
          />
        )}

        <TelemetryConnectionSection
          canWrite={canWrite}
          refreshToken={connectionRefresh}
          onChanged={(message) => {
            setSavedMessage(message);
            // The connection decides `available`, `retentionApplicable` and the
            // status, so refresh all three — and the shell's shared flag.
            void reload();
            void sharedTelemetryConfig?.refresh();
          }}
        />

        <StatusCard status={status} error={statusError} onRefresh={() => void refreshStatus()} />

        {form && config && (
          <Box component="form" onSubmit={handleSubmit} noValidate>
            <Section title="Collection">
              <FormControlLabel
                control={
                  <Switch
                    checked={form.enabled}
                    onChange={(event) => update('enabled', event.target.checked)}
                    disabled={locked}
                    slotProps={{ input: { 'aria-label': 'Collect telemetry' } }}
                  />
                }
                label="Collect telemetry"
              />
              <FormHelperText sx={{ mt: 0 }}>
                Export of traces, logs and metrics starts or stops within seconds on every
                instance — no restart. Nothing is collected while no telemetry store is
                configured.
              </FormHelperText>
              {!config.available && (
                <Alert severity="info" sx={{ mt: 2 }}>
                  No telemetry store is configured yet, so this switch has no effect until a
                  GreptimeDB connection is saved in the{' '}
                  <ConnectionLink>Connection</ConnectionLink> section.
                </Alert>
              )}
              <Box sx={{ mt: 3, maxWidth: { sm: 480 } }}>
                <TextField
                  fullWidth
                  size="small"
                  label="Instance identifier"
                  value={form.instanceId}
                  onChange={(event) => update('instanceId', event.target.value)}
                  disabled={locked}
                  placeholder={config.instanceIdDefault}
                  error={!!errors.instanceId}
                  helperText={
                    <>
                      {errors.instanceId && (
                        <Box component="span" sx={{ display: 'block' }}>
                          {errors.instanceId}
                        </Box>
                      )}
                      Labels every trace, log and metric as <code>app.instance.id</code> so
                      dashboards can filter and aggregate across deployments that share a
                      telemetry store. Leave blank to use the default,{' '}
                      <code>{config.instanceIdDefault}</code>. Currently in use:{' '}
                      <code data-testid="telemetry-instance-id-effective">
                        {config.instanceIdEffective}
                      </code>
                      .
                    </>
                  }
                  slotProps={{
                    htmlInput: {
                      autoCapitalize: 'none',
                      autoCorrect: 'off',
                      spellCheck: false,
                      maxLength: 63,
                    },
                  }}
                />
              </Box>
            </Section>

            <Section title="Retention">
              <ToggleButtonGroup
                exclusive
                size="small"
                value={retentionToggleValue}
                onChange={(_event, next: string | null) => {
                  if (next === null) return;
                  if (next === 'custom') {
                    update('retentionMode', 'custom');
                  } else {
                    setForm((prev) =>
                      prev ? { ...prev, retentionMode: 'preset', retentionDays: next } : prev,
                    );
                  }
                }}
                disabled={locked}
                aria-label="Retention period"
                sx={{ flexWrap: 'wrap', mb: 2 }}
              >
                {RETENTION_PRESETS.map((days) => (
                  <ToggleButton key={days} value={String(days)} aria-label={`${days} days`}>
                    {days} days
                  </ToggleButton>
                ))}
                <ToggleButton value="custom" aria-label="Custom">
                  Custom
                </ToggleButton>
              </ToggleButtonGroup>
              {form.retentionMode === 'custom' && (
                <Box sx={{ mb: 2 }}>
                  <NumberInput
                    label="Retention (days)"
                    field="retentionDays"
                    form={form}
                    errors={errors}
                    disabled={locked}
                    helper="From 1 to 3650 days."
                    onChange={updateNumber}
                  />
                </Box>
              )}
              <FormHelperText sx={{ mt: 0 }}>
                Retention is applied to the telemetry store by a background job after each save
                (and re-asserted nightly), so older data is dropped shortly after, not instantly.
              </FormHelperText>
              {!config.retentionApplicable && (
                <Alert severity="warning" sx={{ mt: 2 }} data-testid="retention-not-applicable">
                  No GreptimeDB admin login is configured, so this retention period is saved but
                  cannot be applied. Add an admin user and password in the{' '}
                  <ConnectionLink>Connection</ConnectionLink> section.
                </Alert>
              )}
            </Section>

            <Section title="Query limits">
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <NumberInput
                  label="Maximum rows per query"
                  field="maxRows"
                  form={form}
                  errors={errors}
                  disabled={locked}
                  helper="From 1 to 100000. Larger results are truncated."
                  onChange={updateNumber}
                />
                <NumberInput
                  label="Query timeout (seconds)"
                  field="timeoutSeconds"
                  form={form}
                  errors={errors}
                  disabled={locked}
                  helper="From 1 to 120."
                  onChange={updateNumber}
                />
              </Stack>
            </Section>

            <Section title="AI assistant">
              {!aiConfig.enabled && (
                <Alert severity="info" sx={{ mb: 2 }} data-testid="telemetry-ai-off">
                  AI is switched off for this deployment. You can configure the assistant here,
                  but it will not run until AI is turned on in{' '}
                  <Link component={RouterLink} to="/admin/settings/ai">
                    AI settings
                  </Link>
                  .
                </Alert>
              )}
              <FormControlLabel
                control={
                  <Switch
                    checked={form.assistantEnabled}
                    onChange={(event) => update('assistantEnabled', event.target.checked)}
                    disabled={locked}
                    slotProps={{ input: { 'aria-label': 'Enable the telemetry assistant' } }}
                  />
                }
                label="Enable the telemetry assistant"
              />
              <FormHelperText sx={{ mt: 0, mb: 2 }}>
                Lets explorer users ask questions in plain language; the assistant inspects the
                schema and writes and runs read-only SQL on their behalf.
              </FormHelperText>

              <Stack spacing={2}>
                <Box sx={{ maxWidth: { sm: 480 } }}>
                  {canPickModel ? (
                    <AssistantModelSelect
                      value={form.model}
                      onChange={(key) => update('model', key)}
                      disabled={locked}
                    />
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      Model: {form.model || 'not set'} (choosing one needs{' '}
                      <code>ai_config:read</code>)
                    </Typography>
                  )}
                </Box>
                <Box>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={form.shareResults}
                        onChange={(event) => update('shareResults', event.target.checked)}
                        disabled={locked}
                        slotProps={{
                          input: { 'aria-label': 'Share query results with the model' },
                        }}
                      />
                    }
                    label="Share query results with the model"
                  />
                  <FormHelperText sx={{ mt: 0 }}>
                    Off: the model sees only column names, row counts and errors, never values.
                  </FormHelperText>
                </Box>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <NumberInput
                    label="Rows shared per query"
                    field="maxResultRowsToModel"
                    form={form}
                    errors={errors}
                    disabled={locked || !form.shareResults}
                    helper="From 1 to 100."
                    onChange={updateNumber}
                  />
                  <NumberInput
                    label="Maximum steps"
                    field="maxSteps"
                    form={form}
                    errors={errors}
                    disabled={locked}
                    helper="Tool calls per question, from 1 to 20. 15 is recommended for investigations."
                    onChange={updateNumber}
                  />
                </Stack>
              </Stack>
            </Section>

            {conflict && (
              <Alert
                severity="warning"
                sx={{ mb: 3 }}
                data-testid="telemetry-conflict"
                action={
                  <Button color="inherit" size="small" onClick={() => void reload()}>
                    Reload
                  </Button>
                }
              >
                These settings were changed by someone else since you opened this page. Reload to
                see the current values, then re-apply your changes.
              </Alert>
            )}
            {saveError && (
              <Alert severity="error" sx={{ mb: 3 }}>
                {saveError}
              </Alert>
            )}

            <Divider sx={{ mb: 3 }} />
            <Button type="submit" variant="contained" disabled={locked || !isDirty || invalid}>
              {isSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          </Box>
        )}

        <Snackbar
          open={!!savedMessage}
          autoHideDuration={3000}
          onClose={() => setSavedMessage(null)}
          message={savedMessage}
        />
      </Box>
    </Container>
  );
}
