/**
 * The GreptimeDB connection — a SECTION of `/admin/settings/telemetry`
 * (issue #558, epic #528), not a card or a tab of its own.
 *
 * Two modes, chosen by the Host field alone:
 *
 *   - AUTOMATIC (host blank, issues #562, #570): the GreptimeDB deployed with
 *     this application. The deployment supplies its address, database and both
 *     logins, so the form collects NOTHING else — the port, database and login
 *     fields are not rendered, a read-only summary of `deployment` is shown
 *     instead, and Test/Save send exactly `{ host: null }`.
 *   - CUSTOM (a host typed): an external GreptimeDB. Port, database and both
 *     logins are entered here. The passwords are write-only — the fields always
 *     render empty, and the helper text says whether blank means "keep the
 *     saved one" or "required".
 *
 * Values typed into the custom fields survive clearing the host (so retyping
 * it brings them back) but are never sent while the host is blank.
 *
 * What is NOT here, on purpose: the GreptimeDB server itself (a deployment
 * concern), and the writer login and HTTP port, which only the OTel collector
 * uses and which stay deployment settings.
 *
 * Every write sends `If-Match: <connection version>`; a 409 offers a reload.
 * All controls are disabled without `telemetry:write` — the API is the gate.
 */
import { useEffect, useState } from 'react';
import type { ComponentProps, FormEvent } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Grid,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useTelemetryConnection } from '../../hooks/useTelemetryConnection';
import {
  isTelemetryProbeSkipped,
  TELEMETRY_CONNECTION_DEFAULTS,
  type TelemetryConnection,
  type TelemetryConnectionCustomInput,
  type TelemetryConnectionInput,
  type TelemetryConnectionSource,
  type TelemetryConnectionTestResult,
  type TelemetryCredentialStatus,
} from '../../services/telemetry';

/** The element id the page's other alerts link to. */
export const TELEMETRY_CONNECTION_SECTION_ID = 'telemetry-connection';

const SOURCE_LABELS: Record<TelemetryConnectionSource, string> = {
  stored: 'Saved in admin settings',
  environment: 'Deployment default (environment)',
  none: 'Not configured',
};

const SOURCE_COLORS: Record<TelemetryConnectionSource, 'success' | 'info' | 'default'> = {
  stored: 'success',
  environment: 'info',
  none: 'default',
};

interface ConnectionForm {
  host: string;
  pgPort: string;
  database: string;
  readerUser: string;
  readerPassword: string;
  adminUser: string;
  adminPassword: string;
}

type ConnectionField = keyof ConnectionForm;
type ConnectionErrors = Partial<Record<ConnectionField, string>>;

const DATABASE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isCustom(connection: TelemetryConnection): boolean {
  return connection.hostMode === 'custom';
}

/** A custom connection saved on this page — the only thing "revert" undoes. */
function isStoredCustom(connection: TelemetryConnection): boolean {
  return connection.source === 'stored' && isCustom(connection);
}

function isAutomatic(form: ConnectionForm): boolean {
  return !form.host.trim();
}

function toForm(connection: TelemetryConnection): ConnectionForm {
  // Automatic: every custom field starts from the defaults and empty logins —
  // the deployment's logins are not the administrator's to copy.
  const custom = isCustom(connection);
  return {
    host: custom ? (connection.host ?? '') : '',
    pgPort: String((custom && connection.pgPort) || TELEMETRY_CONNECTION_DEFAULTS.pgPort),
    database: (custom && connection.database) || TELEMETRY_CONNECTION_DEFAULTS.database,
    readerUser: custom ? connection.readerUser : '',
    readerPassword: '',
    adminUser: custom ? (connection.adminUser ?? '') : '',
    adminPassword: '',
  };
}

/** A password is saved in the credential store — blank then means "keep it". */
function hasStoredPassword(connection: TelemetryConnection, role: 'reader' | 'admin'): boolean {
  return isStoredCustom(connection) && connection.credentials[role].configured;
}

/**
 * Thin client-side checks so the obvious typo does not round-trip; the API
 * validates for real. `forSave` adds the required-password rules — a TEST may
 * leave a password blank ("use the connection in force's").
 */
function validate(
  form: ConnectionForm,
  connection: TelemetryConnection,
  forSave: boolean,
): ConnectionErrors {
  const errors: ConnectionErrors = {};
  // Automatic: the deployment supplies everything, so there is nothing to check.
  if (isAutomatic(form)) return errors;
  const host = form.host.trim();
  if (/[\s/:]/.test(host) && !/^[0-9a-fA-F:]+$/.test(host)) {
    errors.host = 'Host name or IP address only — no scheme, port or path.';
  }
  const port = form.pgPort.trim();
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    errors.pgPort = 'Enter a port from 1 to 65535.';
  }
  if (!DATABASE_PATTERN.test(form.database.trim())) {
    errors.database = 'Letters, digits and underscores, not starting with a digit.';
  }
  if (!form.readerUser.trim()) {
    errors.readerUser = 'Enter the read-only user.';
  }
  if (forSave) {
    if (!form.readerPassword && !hasStoredPassword(connection, 'reader')) {
      errors.readerPassword = 'Required — no reader password is saved in admin settings yet.';
    }
    if (form.adminUser.trim() && !form.adminPassword && !hasStoredPassword(connection, 'admin')) {
      errors.adminPassword = 'Required with an admin user — no admin password is saved yet.';
    }
  }
  return errors;
}

/**
 * A blank host is AUTOMATIC and sends exactly `{ host: null }` — whatever the
 * hidden custom fields hold. For a custom host, blank passwords are OMITTED —
 * never sent as `""` — so the stored one is kept.
 */
function toInput(form: ConnectionForm): TelemetryConnectionInput {
  if (isAutomatic(form)) return { host: null };
  const adminUser = form.adminUser.trim() || null;
  const input: TelemetryConnectionCustomInput = {
    host: form.host.trim(),
    pgPort: Number(form.pgPort.trim()),
    database: form.database.trim(),
    readerUser: form.readerUser.trim(),
    adminUser,
  };
  if (form.readerPassword) input.readerPassword = form.readerPassword;
  if (adminUser && form.adminPassword) input.adminPassword = form.adminPassword;
  return input;
}

function passwordHelper(
  connection: TelemetryConnection,
  role: 'reader' | 'admin',
  status: TelemetryCredentialStatus,
): string {
  if (hasStoredPassword(connection, role)) {
    const which = status.hint ? ` (${status.hint})` : '';
    return `Saved${which} — leave blank to keep it, or type a new one to replace it.`;
  }
  return 'Required to save.';
}

/** What a blank host means: the deployment host, always known (`deployment.host`). */
function automaticHostLabel(connection: TelemetryConnection): string {
  return connection.deployment.host ? `Automatic: ${connection.deployment.host}` : 'Automatic';
}

function hostHelper(connection: TelemetryConnection, automatic: boolean): string {
  const lead = automatic ? automaticHostLabel(connection) : 'Leave blank for automatic';
  return `${lead} — the GreptimeDB deployed with this application. Set a host only for an external GreptimeDB.`;
}

/**
 * The read-only summary of the deployment's GreptimeDB, shown while the host
 * is automatic. Whether a login is provided, never a password or a hint.
 */
function DeploymentManagedPanel({ connection }: { connection: TelemetryConnection }) {
  const { deployment } = connection;
  const rows: [string, string][] = [
    ['Address', `${deployment.host}:${deployment.pgPort}`],
    ['Database', deployment.database],
    ['Reader login', deployment.readerConfigured ? 'Provided' : 'Missing'],
    ['Admin login', deployment.adminConfigured ? 'Provided' : 'Not provisioned'],
  ];
  return (
    <Alert
      severity="info"
      sx={{ mt: 2, '& .MuiAlert-message': { minWidth: 0, flex: 1 } }}
      data-testid="telemetry-connection-deployment-managed"
    >
      <AlertTitle>Managed by the deployment</AlertTitle>
      GreptimeDB is deployed with this application. Its address and logins are managed for you —
      nothing to configure here.
      <Box
        component="dl"
        data-testid="telemetry-connection-deployment-summary"
        sx={{
          display: 'grid',
          gridTemplateColumns: 'auto minmax(0, 1fr)',
          columnGap: 2,
          rowGap: 0.5,
          mt: 1.5,
          mb: 0,
        }}
      >
        {rows.map(([term, value]) => (
          <Box key={term} sx={{ display: 'contents' }}>
            <Typography component="dt" variant="body2" sx={{ fontWeight: 500 }}>
              {term}
            </Typography>
            <Typography
              component="dd"
              variant="body2"
              sx={{ m: 0, overflowWrap: 'anywhere' }}
            >
              {value}
            </Typography>
          </Box>
        ))}
      </Box>
    </Alert>
  );
}

function TestResultView({ result }: { result: TelemetryConnectionTestResult }) {
  const { host, reader, admin } = result;
  return (
    <Stack spacing={1} sx={{ mt: 2 }} data-testid="telemetry-connection-test-result">
      {host && (
        <Typography variant="body2" color="text.secondary">
          Tested <code>{host}</code>
        </Typography>
      )}
      <Alert severity={reader.success ? 'success' : 'error'}>
        <AlertTitle>
          {reader.success ? 'Reader login connected' : 'Reader login failed'}
        </AlertTitle>
        {reader.success
          ? `${reader.version ?? 'Connected'} · ${reader.latencyMs} ms`
          : `${reader.error ?? 'The connection failed'} (${reader.latencyMs} ms)`}
      </Alert>
      {isTelemetryProbeSkipped(admin) ? (
        <Alert severity="info">
          <AlertTitle>Admin login skipped</AlertTitle>
          No admin user is set, so the admin login was not checked. Retention cannot be applied
          without one.
        </Alert>
      ) : (
        <Alert severity={admin.success ? 'success' : 'error'}>
          <AlertTitle>{admin.success ? 'Admin login connected' : 'Admin login failed'}</AlertTitle>
          {admin.success
            ? `${admin.latencyMs} ms`
            : `${admin.error ?? 'The connection failed'} (${admin.latencyMs} ms)`}
        </Alert>
      )}
    </Stack>
  );
}

export interface TelemetryConnectionSectionProps {
  canWrite: boolean;
  /** After a successful save or revert — the page refreshes its config and status. */
  onChanged: (message: string) => void;
  /**
   * Bumped by the page when the store changed under it (a telemetry services
   * deploy, #567): the connection is re-read and a stale test result dropped.
   */
  refreshToken?: number;
}

export function TelemetryConnectionSection({
  canWrite,
  onChanged,
  refreshToken = 0,
}: TelemetryConnectionSectionProps) {
  const {
    connection,
    isLoading,
    loadError,
    isSaving,
    saveError,
    conflict,
    isTesting,
    testResult,
    testError,
    reload,
    save,
    revert,
    test,
    clearTestResult,
  } = useTelemetryConnection();

  // Not on mount: the hook already loads once.
  useEffect(() => {
    if (refreshToken === 0) return;
    clearTestResult();
    void reload();
  }, [refreshToken, clearTestResult, reload]);

  const [form, setForm] = useState<ConnectionForm | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);

  useEffect(() => {
    if (connection) {
      setForm(toForm(connection));
      setShowErrors(false);
    }
  }, [connection]);

  const title = 'Connection';
  const automatic = form ? isAutomatic(form) : true;
  const storedCustom = connection ? isStoredCustom(connection) : false;
  const busy = isSaving || isTesting;
  const locked = !canWrite || busy;

  const update = (field: ConnectionField, value: string) =>
    setForm((prev) => (prev ? { ...prev, [field]: value } : prev));

  const saveErrors = form && connection ? validate(form, connection, true) : {};
  const testErrors = form && connection ? validate(form, connection, false) : {};
  const visibleErrors: ConnectionErrors = showErrors ? saveErrors : testErrors;

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || !connection || !canWrite) return;
    if (Object.keys(saveErrors).length > 0) {
      setShowErrors(true);
      return;
    }
    const ok = await save(toInput(form));
    if (ok) onChanged('Telemetry connection saved');
  };

  const handleTest = () => {
    if (!form || !canWrite || Object.keys(testErrors).length > 0) return;
    void test(toInput(form));
  };

  const handleRevert = async () => {
    setConfirmRevert(false);
    const ok = await revert();
    if (ok) onChanged('Telemetry connection reverted to the deployment default');
  };

  const field = (
    name: ConnectionField,
    label: string,
    helper: string,
    extra: Partial<ComponentProps<typeof TextField>> = {},
  ) => (
    <TextField
      fullWidth
      size="small"
      label={label}
      value={form?.[name] ?? ''}
      onChange={(event) => update(name, event.target.value)}
      disabled={locked}
      error={!!visibleErrors[name]}
      helperText={visibleErrors[name] ?? helper}
      {...extra}
    />
  );

  return (
    <Paper
      sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}
      component="section"
      aria-label={title}
      id={TELEMETRY_CONNECTION_SECTION_ID}
    >
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between', mb: 1 }}
      >
        <Typography variant="h6" component="h2">
          {title}
        </Typography>
        {connection && (
          <Chip
            size="small"
            color={SOURCE_COLORS[connection.source]}
            label={SOURCE_LABELS[connection.source]}
            data-testid="telemetry-connection-source"
            sx={{ alignSelf: { xs: 'flex-start', sm: 'auto' } }}
          />
        )}
      </Stack>
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ mb: 2 }}
        data-testid="telemetry-connection-description"
      >
        How the API reaches GreptimeDB to read telemetry and apply retention. GreptimeDB is
        deployed with this application, and the Automatic host finds it — leave the host blank.
        Enter a host only to use an external GreptimeDB. The collector&apos;s writer login is
        managed by the deployment.
      </Typography>

      {loadError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {loadError}
        </Alert>
      )}

      {isLoading && !connection && (
        <Typography variant="body2" color="text.secondary">
          Loading the connection…
        </Typography>
      )}

      {connection && connection.source === 'none' && (
        <Alert severity="warning" sx={{ mb: 2 }} data-testid="telemetry-connection-none">
          No GreptimeDB connection is configured. Leave the host blank and save to use the
          GreptimeDB deployed with this application, or enter the host of an external one.
        </Alert>
      )}

      {form && connection && (
        <Box component="form" onSubmit={handleSave} noValidate>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: automatic ? 12 : 6 }}>
              {field('host', 'Host', hostHelper(connection, automatic), {
                placeholder: automaticHostLabel(connection),
                slotProps: {
                  inputLabel: { shrink: true },
                  htmlInput: { autoCapitalize: 'none', spellCheck: false },
                },
              })}
            </Grid>
            {!automatic && (
              <>
                <Grid size={{ xs: 12, sm: 3 }}>
                  {field(
                    'pgPort',
                    'PostgreSQL port',
                    `Default ${TELEMETRY_CONNECTION_DEFAULTS.pgPort}.`,
                    {
                      type: 'number',
                      slotProps: {
                        htmlInput: { min: 1, max: 65535, step: 1, inputMode: 'numeric' },
                      },
                    },
                  )}
                </Grid>
                <Grid size={{ xs: 12, sm: 3 }}>
                  {field(
                    'database',
                    'Database',
                    `Default ${TELEMETRY_CONNECTION_DEFAULTS.database}.`,
                  )}
                </Grid>
                <Grid size={12}>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    data-testid="telemetry-connection-custom-note"
                  >
                    Connecting to an external GreptimeDB — enter its logins.
                  </Typography>
                </Grid>
                <Grid size={{ xs: 12, sm: 6 }}>
                  {field(
                    'readerUser',
                    'Reader user',
                    'The read-only login the explorer and status use.',
                    { autoComplete: 'off' },
                  )}
                </Grid>
                <Grid size={{ xs: 12, sm: 6 }}>
                  {field(
                    'readerPassword',
                    'Reader password',
                    passwordHelper(connection, 'reader', connection.credentials.reader),
                    { type: 'password', autoComplete: 'new-password' },
                  )}
                </Grid>
                <Grid size={{ xs: 12, sm: 6 }}>
                  {field(
                    'adminUser',
                    'Admin user (optional)',
                    'The DDL-capable login retention needs. Leave blank for none.',
                    { autoComplete: 'off' },
                  )}
                </Grid>
                <Grid size={{ xs: 12, sm: 6 }}>
                  {field(
                    'adminPassword',
                    'Admin password',
                    form.adminUser.trim()
                      ? passwordHelper(connection, 'admin', connection.credentials.admin)
                      : 'Only with an admin user.',
                    {
                      type: 'password',
                      autoComplete: 'new-password',
                      disabled: locked || !form.adminUser.trim(),
                    },
                  )}
                </Grid>
              </>
            )}
          </Grid>

          {automatic && <DeploymentManagedPanel connection={connection} />}
          {automatic && connection.problem && (
            <Alert severity="warning" sx={{ mt: 2 }} data-testid="telemetry-connection-problem">
              {connection.problem}
            </Alert>
          )}

          {conflict && (
            <Alert
              severity="warning"
              sx={{ mt: 2 }}
              data-testid="telemetry-connection-conflict"
              action={
                <Button color="inherit" size="small" onClick={() => void reload()}>
                  Reload
                </Button>
              }
            >
              The connection was changed by someone else since you opened this page. Reload to
              see the current values, then re-apply your changes.
            </Alert>
          )}
          {saveError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {saveError}
            </Alert>
          )}
          {testError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {testError}
            </Alert>
          )}
          {testResult && <TestResultView result={testResult} />}

          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            useFlexGap
            sx={{ mt: 3, flexWrap: 'wrap' }}
          >
            <Button
              variant="outlined"
              onClick={handleTest}
              disabled={locked || Object.keys(testErrors).length > 0}
            >
              {isTesting ? 'Testing…' : 'Test connection'}
            </Button>
            <Button type="submit" variant="contained" disabled={locked}>
              {isSaving ? 'Saving…' : 'Save connection'}
            </Button>
            {storedCustom && (
              <Button color="warning" onClick={() => setConfirmRevert(true)} disabled={locked}>
                Revert to deployment default
              </Button>
            )}
          </Stack>
          {storedCustom && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 1 }}
              data-testid="telemetry-connection-revert-hint"
            >
              Reverting forgets the external GreptimeDB and its saved logins, and uses the
              GreptimeDB deployed with this application again.
            </Typography>
          )}
          {connection.updatedBy && connection.updatedAt && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              Connection last saved by {connection.updatedBy.email} on{' '}
              {new Date(connection.updatedAt).toLocaleString()}
            </Typography>
          )}
        </Box>
      )}

      <Dialog
        open={confirmRevert}
        onClose={() => setConfirmRevert(false)}
        aria-labelledby="telemetry-connection-revert-title"
      >
        <DialogTitle id="telemetry-connection-revert-title">
          Revert to the deployment default?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            The saved external host and its passwords are deleted. The API then uses the
            GreptimeDB deployed with this application, with the logins the deployment provides.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRevert(false)}>Cancel</Button>
          <Button color="warning" variant="contained" onClick={() => void handleRevert()}>
            Revert
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
