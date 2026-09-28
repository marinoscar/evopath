/**
 * Admin → Settings → AI (`/admin/settings/ai`) — issue #429, epic #419.
 *
 * A STANDALONE PAGE, exactly like `StorageConfigPage` and `PushConfigPage`
 * and for the same reason: it hits its own controller (`/api/admin/ai/*`)
 * with its own document and its own permission pair (`ai_config:read` /
 * `ai_config:write`). One card in `ADMIN_SECTIONS`, one route in `App.tsx`,
 * no tab — `CLAUDE.md`'s "MANDATORY: Settings UI Pattern" rules 1–3.
 *
 * =============================================================================
 * ONE FORM FOR POLICY, IMMEDIATE BUTTONS FOR KEYS
 * =============================================================================
 *
 * The master switch, the key policy, prompt logging, the defaults and each
 * provider's enable switch / base URL are POLICY: they travel together in one
 * `PUT /admin/ai/config` guarded by `If-Match: version`, so a colleague's
 * concurrent edit is detected rather than silently overwritten.
 *
 * A provider's admin KEY is not policy and is not in that form: it is
 * verified by the provider before it is stored, it can be tested on its own,
 * and removing it is destructive. Each of those is an immediate action on the
 * provider's card (`AiProviderCard`).
 *
 * The hosted-tool switches (#442) are policy too: five switches and the MCP
 * host allowlist travel in the same PUT. Every tool is off by default — each
 * reaches outside the deployment and bills per use.
 *
 * The Limits section (#450) is policy as well: the per-user and org-key rate
 * limits travel in the same PUT as `limits`, blank meaning unlimited. Because
 * the API replaces `limits` WHOLESALE, the per-model entries (edited from the
 * AI Models page's dialog, not here) are re-sent unchanged from the loaded
 * configuration — omitting them would lift every per-model limit.
 *
 * =============================================================================
 * SNACKBAR vs. ALERT
 * =============================================================================
 *
 * A save is the ordinary outcome — `Snackbar`. Anything the admin must READ
 * (a failed check, the provider's verbatim error, a refused save) is a
 * persistent, dismissible `Alert`, as on the storage page.
 *
 * =============================================================================
 * READ-ONLY IS STATED, NOT MIMED
 * =============================================================================
 *
 * Without `ai_config:write` every control stays visible and DISABLED, and an
 * info alert says why — an admin diagnosing "why can nobody use AI" needs to
 * see the switch that is off.
 */

import { useContext, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Container,
  Divider,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  Grid,
  Paper,
  Radio,
  RadioGroup,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useAiAdminConfig } from '../../hooks/useAiAdminConfig';
import { AiConfigContext } from '../../hooks/useAiConfig';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { AiProviderCard } from '../../components/admin/ai/AiProviderCard';
import {
  EMPTY_PROVIDER_FORM_VALUE,
  hasProviderFormErrors,
  toProviderFormValue,
  toProviderInput,
  validateProviderForm,
} from '../../components/admin/ai/aiProviderForm';
import type { AiProviderFormErrors, AiProviderFormValue } from '../../components/admin/ai/aiProviderForm';
import { AI_HOSTED_TOOL_TYPES, AI_LIMIT_MAX, aiProviderSettingsFields } from '../../services/ai';
import type {
  AiAdminConfig,
  AiAdminConfigInput,
  AiHostedToolType,
  AiKeyPolicy,
  AiLimits,
} from '../../services/ai';

/** The four deployment-wide limit fields (#450); per-model limits live on the AI Models page. */
const LIMIT_FIELDS = [
  'perUserRequestsPerMinute',
  'perUserRequestsPerDay',
  'orgKeyRequestsPerDayPerUser',
  'orgKeyTokensPerDayPerUser',
] as const;
type LimitField = (typeof LIMIT_FIELDS)[number];

const LIMIT_COPY: Record<LimitField, { label: string; help: string }> = {
  perUserRequestsPerMinute: {
    label: 'Requests per minute, per user',
    help: "Every AI call a user makes, whoever's key pays.",
  },
  perUserRequestsPerDay: {
    label: 'Requests per day, per user',
    help: "Counted per UTC day, whoever's key pays.",
  },
  orgKeyRequestsPerDayPerUser: {
    label: 'Organization key: requests per day, per user',
    help: 'Only calls the organization key pays for.',
  },
  orgKeyTokensPerDayPerUser: {
    label: 'Organization key: tokens per day, per user',
    help: 'Input plus output tokens the organization key pays for.',
  },
};

/** The form's own state — strings for the number field so "blank" is representable. */
interface AiFormState {
  enabled: boolean;
  keyPolicy: AiKeyPolicy;
  logPromptContent: boolean;
  maxOutputTokensCap: string;
  allowBackgroundRuns: boolean;
  allowRealtime: boolean;
  hostedTools: Record<AiHostedToolType, boolean>;
  /** One host per line, as typed. */
  mcpAllowedHosts: string;
  /** Strings so "blank" (unlimited) is representable. */
  limits: Record<LimitField, string>;
  providers: Record<string, AiProviderFormValue>;
}

/** Label and helper per hosted tool type (#442), in the order the API lists them. */
const HOSTED_TOOL_COPY: Record<AiHostedToolType, { label: string; help: string }> = {
  web_search: { label: 'Web search', help: 'Live web search, with the sources cited in the answer.' },
  file_search: { label: 'File search', help: "Search documents in the provider's vector stores." },
  code_interpreter: { label: 'Code interpreter', help: 'Run code in a sandbox the provider manages.' },
  image_generation: { label: 'Image generation', help: 'Generate images as part of an answer.' },
  mcp: { label: 'Remote MCP servers', help: 'Let the model call tools on MCP servers users name.' },
};

/** `mcp.example.com` or `*.example.com` — mirrors the API's own pattern. */
const MCP_HOST_PATTERN =
  /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** The allowlist textarea as a list: trimmed, lower-cased, blank lines dropped. */
function parseHosts(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/** A stored limit as its field's text — blank when unset. */
function limitText(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/** A limit field's text as a number — `undefined` (omitted: unlimited) when blank. */
function limitValue(text: string): number | undefined {
  const trimmed = text.trim();
  return trimmed ? Number(trimmed) : undefined;
}

/** Drop the `undefined` members, and the whole object when nothing is left. */
function compact<T extends Record<string, number | undefined>>(value: T): Partial<T> | undefined {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as Partial<T>) : undefined;
}

function toFormState(config: AiAdminConfig): AiFormState {
  const providers: Record<string, AiProviderFormValue> = {};
  for (const provider of config.providers) {
    providers[provider.id] = toProviderFormValue(provider);
  }
  return {
    enabled: config.enabled,
    keyPolicy: config.keyPolicy,
    logPromptContent: config.logPromptContent,
    maxOutputTokensCap:
      config.defaults.maxOutputTokensCap === null ? '' : String(config.defaults.maxOutputTokensCap),
    allowBackgroundRuns: config.defaults.allowBackgroundRuns,
    // Absent from an API older than #449 — read as off.
    allowRealtime: config.defaults.allowRealtime ?? false,
    hostedTools: {
      web_search: config.hostedTools?.web_search ?? false,
      file_search: config.hostedTools?.file_search ?? false,
      code_interpreter: config.hostedTools?.code_interpreter ?? false,
      image_generation: config.hostedTools?.image_generation ?? false,
      mcp: config.hostedTools?.mcp ?? false,
    },
    mcpAllowedHosts: (config.hostedTools?.mcpAllowedHosts ?? []).join('\n'),
    limits: {
      perUserRequestsPerMinute: limitText(config.limits?.perUser?.requestsPerMinute),
      perUserRequestsPerDay: limitText(config.limits?.perUser?.requestsPerDay),
      orgKeyRequestsPerDayPerUser: limitText(config.limits?.orgKey?.requestsPerDayPerUser),
      orgKeyTokensPerDayPerUser: limitText(config.limits?.orgKey?.tokensPerDayPerUser),
    },
    providers,
  };
}

/**
 * `limits` for the PUT. Blank fields are omitted (unlimited). The per-model
 * entries are not on this form: they are re-sent exactly as loaded, because
 * the API replaces `limits` wholesale.
 */
function toLimits(form: AiFormState, config: AiAdminConfig): AiLimits {
  const perUser = compact({
    requestsPerMinute: limitValue(form.limits.perUserRequestsPerMinute),
    requestsPerDay: limitValue(form.limits.perUserRequestsPerDay),
  });
  const orgKey = compact({
    requestsPerDayPerUser: limitValue(form.limits.orgKeyRequestsPerDayPerUser),
    tokensPerDayPerUser: limitValue(form.limits.orgKeyTokensPerDayPerUser),
  });
  const perModel = config.limits?.perModel;
  return {
    ...(perUser ? { perUser } : {}),
    ...(orgKey ? { orgKey } : {}),
    ...(perModel && Object.keys(perModel).length > 0 ? { perModel } : {}),
  };
}

/**
 * The `PUT` body.
 *
 * ⚠ THE PUT IS A FULL REPLACE. For every provider it names, an omitted
 * `baseUrl` CLEARS the stored override, and an omitted cap clears the cap. So
 * every value is sent EXPLICITLY, every time — the current override to keep
 * it, `null` to clear it — and every provider on screen is included. Omitting
 * "unchanged" fields, the instinct from a PATCH, would silently wipe them.
 *
 * Each provider entry carries only that provider's `settingsFields` (#448) —
 * see `toProviderInput`.
 */
function toInput(form: AiFormState, config: AiAdminConfig): AiAdminConfigInput {
  const providers: AiAdminConfigInput['providers'] = {};
  for (const provider of config.providers) {
    const value = form.providers[provider.id];
    if (value) providers[provider.id] = toProviderInput(provider, value);
  }
  const cap = form.maxOutputTokensCap.trim();
  return {
    enabled: form.enabled,
    keyPolicy: form.keyPolicy,
    logPromptContent: form.logPromptContent,
    defaults: {
      maxOutputTokensCap: cap ? Number(cap) : null,
      allowBackgroundRuns: form.allowBackgroundRuns,
      allowRealtime: form.allowRealtime,
    },
    hostedTools: { ...form.hostedTools, mcpAllowedHosts: [...new Set(parseHosts(form.mcpAllowedHosts))] },
    limits: toLimits(form, config),
    providers,
  };
}

interface FormErrors {
  maxOutputTokensCap?: string;
  mcpAllowedHosts?: string;
  limits: Partial<Record<LimitField, string>>;
  /** Per provider id; only providers with a problem appear. */
  providers: Record<string, AiProviderFormErrors>;
}

/** Blank, or a whole number from 1 to {@link AI_LIMIT_MAX}; else the error to show. */
function limitError(text: string): string | undefined {
  const value = text.trim();
  if (!value) return undefined;
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    return 'Must be a whole number greater than zero, or blank for no limit.';
  }
  if (Number(value) > AI_LIMIT_MAX) {
    return `Must be at most ${AI_LIMIT_MAX.toLocaleString('en-US')}.`;
  }
  return undefined;
}

/** Thin client-side validation — the API validates for real; this stops the obvious typo. */
function validate(form: AiFormState, config: AiAdminConfig): FormErrors {
  const errors: FormErrors = { limits: {}, providers: {} };
  const cap = form.maxOutputTokensCap.trim();
  if (cap && (!/^\d+$/.test(cap) || Number(cap) <= 0)) {
    errors.maxOutputTokensCap = 'Must be a whole number greater than zero, or blank for no cap.';
  }
  const badHost = parseHosts(form.mcpAllowedHosts).find(
    (host) => host.length > 253 || !MCP_HOST_PATTERN.test(host),
  );
  if (badHost) {
    errors.mcpAllowedHosts = `"${badHost}" is not a host name. Use mcp.example.com or *.example.com — no https:// or path.`;
  }
  for (const field of LIMIT_FIELDS) {
    const error = limitError(form.limits[field]);
    if (error) errors.limits[field] = error;
  }
  for (const provider of config.providers) {
    const value = form.providers[provider.id];
    if (!value) continue;
    const providerErrors = validateProviderForm(provider, value);
    if (hasProviderFormErrors(providerErrors)) errors.providers[provider.id] = providerErrors;
  }
  return errors;
}

function hasErrors(errors: FormErrors): boolean {
  return (
    !!errors.maxOutputTokensCap ||
    !!errors.mcpAllowedHosts ||
    Object.keys(errors.limits).length > 0 ||
    Object.keys(errors.providers).length > 0
  );
}

export default function AiConfigPage() {
  const { hasPermission } = usePermissions();
  const {
    config,
    isLoading,
    loadError,
    isSaving,
    saveError,
    clearSaveError,
    save,
    keyAction,
    keyError,
    clearKeyError,
    keyWarnings,
    clearKeyWarnings,
    setKey,
    removeKey,
    probingProvider,
    probeError,
    clearProbeError,
    testResults,
    clearTestResult,
    test,
  } = useAiAdminConfig();
  // The shell's shared `GET /ai/config` answer. Refreshed after a save so the
  // hub, the rail and the AI routes learn at once that AI was switched on or
  // off. Read from context directly — with no shell above (a test), there is
  // nothing to refresh and no request is made.
  const sharedAiConfig = useContext(AiConfigContext);

  const [form, setForm] = useState<AiFormState | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  // The server's answer is the new baseline after every load and every save.
  useEffect(() => {
    if (config) setForm(toFormState(config));
  }, [config]);

  // Defence, not the gate — `App.tsx` wraps the route in `RequirePermission`
  // with this same string. After every hook so the hook order never changes.
  if (!hasPermission('ai_config:read')) {
    return <Navigate to="/" replace />;
  }

  const canWrite = hasPermission('ai_config:write');

  if (isLoading || (!form && !loadError)) {
    return <LoadingSpinner />;
  }

  const errors: FormErrors = form && config ? validate(form, config) : { limits: {}, providers: {} };
  const invalid = hasErrors(errors);
  const isDirty =
    !!form && !!config && JSON.stringify(form) !== JSON.stringify(toFormState(config));

  const update = <K extends keyof AiFormState>(key: K, value: AiFormState[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  /** One write or probe at a time, page-wide — they all replace `config`. */
  const busy = isSaving || keyAction !== null || probingProvider !== null;

  const handleSaveKey = async (providerId: string, displayName: string, apiKey: string) => {
    const ok = await setKey(providerId, apiKey);
    if (ok) setSavedMessage(`${displayName} key verified and saved`);
    return ok;
  };

  const handleRemoveKey = async (providerId: string, displayName: string) => {
    const ok = await removeKey(providerId);
    if (ok) setSavedMessage(`${displayName} key removed`);
    return ok;
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || !config || invalid || !canWrite) return;
    const ok = await save(toInput(form, config));
    if (ok) {
      setSavedMessage('AI configuration saved');
      void sharedAiConfig?.refresh();
    }
  };

  // Providers that would leave the org-fallback policy without a key to fall
  // back to. The API refuses that save with `AI_KEY_REQUIRED`; saying so
  // BEFORE the click is kinder than decoding the refusal after it.
  const keylessEnabledProviders =
    form && config
      ? config.providers.filter(
          (provider) =>
            form.providers[provider.id]?.enabled &&
            !provider.keyStatus.configured &&
            // A keyless server (#448) is served with no key: it needs no fallback.
            !(
              aiProviderSettingsFields(provider).includes('requiresKey') &&
              form.providers[provider.id]?.requiresKey === false
            ),
        )
      : [];

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        {/* Title and description MIRROR the `AI` card in `config/adminSections.tsx`. */}
        <Typography variant="h4" component="h1" gutterBottom>
          AI
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Switch AI on for this deployment, choose whose keys pay for calls, and configure each
          provider.
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
          <Alert severity="info" sx={{ mb: 3 }} data-testid="ai-read-only-notice">
            You can read this configuration but not change it. Saving, storing or testing a key and
            editing models all need <code>ai_config:write</code>.
          </Alert>
        )}

        {form && config && (
          <Box component="form" onSubmit={handleSubmit} noValidate>
            <Paper sx={{ p: { xs: 2, sm: 3 } }}>
              {/* ---------------------------------------------------------
                  THE MASTER SWITCH
                  ------------------------------------------------------- */}
              <FormControlLabel
                control={
                  <Switch
                    checked={form.enabled}
                    onChange={(e) => update('enabled', e.target.checked)}
                    disabled={!canWrite}
                    slotProps={{ input: { 'aria-label': 'Enable AI for this deployment' } }}
                  />
                }
                label="Enable AI for this deployment"
              />
              <FormHelperText sx={{ mt: 0 }}>
                The kill switch. Turning it off stops every AI feature at once, without touching
                keys or models.
              </FormHelperText>
              {!form.enabled && (
                <Alert severity="info" sx={{ mt: 2 }} data-testid="ai-disabled-notice">
                  AI is completely disabled: users see no AI features, and no AI requests are made.
                </Alert>
              )}

              <Divider sx={{ my: 3 }} />

              {/* ---------------------------------------------------------
                  KEY POLICY
                  ------------------------------------------------------- */}
              <FormControl>
                <FormLabel id="ai-key-policy-label">Whose key pays for a call</FormLabel>
                <RadioGroup
                  aria-labelledby="ai-key-policy-label"
                  value={form.keyPolicy}
                  onChange={(e) => update('keyPolicy', e.target.value as AiKeyPolicy)}
                >
                  <FormControlLabel
                    value="byok"
                    control={<Radio />}
                    label="Users bring their own key (recommended)"
                    disabled={!canWrite}
                  />
                  <FormControlLabel
                    value="byok_with_org_fallback"
                    control={<Radio />}
                    label="Users bring their own key; fall back to the organization key"
                    disabled={!canWrite}
                  />
                </RadioGroup>
                <FormHelperText>
                  The organization key below is always used to discover models. This choice decides
                  whether it also pays for users&apos; calls.
                </FormHelperText>
              </FormControl>
              {form.keyPolicy === 'byok_with_org_fallback' && (
                <Alert severity="warning" sx={{ mt: 2 }} data-testid="ai-org-fallback-warning">
                  <AlertTitle>The organization pays for users without a key</AlertTitle>
                  Every user who has not saved their own key will make calls on the organization
                  key, and its provider bill.
                  {keylessEnabledProviders.length > 0 && (
                    <Box sx={{ mt: 1 }}>
                      No organization key is stored yet for{' '}
                      <strong>
                        {keylessEnabledProviders.map((provider) => provider.displayName).join(', ')}
                      </strong>
                      . Save one below first — the configuration cannot be saved with this policy
                      until then.
                    </Box>
                  )}
                </Alert>
              )}

              <Divider sx={{ my: 3 }} />

              {/* ---------------------------------------------------------
                  PRIVACY AND DEFAULTS
                  ------------------------------------------------------- */}
              <FormControlLabel
                control={
                  <Switch
                    checked={form.logPromptContent}
                    onChange={(e) => update('logPromptContent', e.target.checked)}
                    disabled={!canWrite}
                    slotProps={{ input: { 'aria-label': 'Log prompt content' } }}
                  />
                }
                label="Log prompt content"
              />
              <FormHelperText sx={{ mt: 0 }}>
                Off by default. Usage is always recorded; this adds what users actually typed.
              </FormHelperText>
              {form.logPromptContent && (
                <Alert severity="warning" sx={{ mt: 2 }} data-testid="ai-log-prompts-warning">
                  Prompts and responses can contain personal or confidential data. With this on,
                  they are stored in the application&apos;s logs where operators can read them.
                </Alert>
              )}

              <Typography variant="h6" component="h2" sx={{ mt: 3, mb: 1 }}>
                Defaults
              </Typography>
              <Grid container spacing={2} sx={{ alignItems: 'center' }}>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <TextField
                    fullWidth
                    label="Maximum output tokens per call"
                    value={form.maxOutputTokensCap}
                    onChange={(e) => update('maxOutputTokensCap', e.target.value)}
                    disabled={!canWrite}
                    slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                    error={!!errors.maxOutputTokensCap}
                    helperText={
                      errors.maxOutputTokensCap ??
                      'A ceiling applied to every request. Leave blank for no cap.'
                    }
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={form.allowBackgroundRuns}
                        onChange={(e) => update('allowBackgroundRuns', e.target.checked)}
                        disabled={!canWrite}
                        slotProps={{ input: { 'aria-label': 'Allow background runs' } }}
                      />
                    }
                    label="Allow background runs"
                  />
                  <FormHelperText sx={{ mt: 0 }}>
                    Long requests run on the job queue instead of holding a connection open.
                  </FormHelperText>
                </Grid>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={form.allowRealtime}
                        onChange={(e) => update('allowRealtime', e.target.checked)}
                        disabled={!canWrite}
                        slotProps={{ input: { 'aria-label': 'Allow realtime voice sessions' } }}
                      />
                    }
                    label="Allow realtime voice sessions"
                  />
                  <FormHelperText sx={{ mt: 0 }}>
                    Live voice conversations in the playground. The user&apos;s browser connects
                    directly to the provider with a short-lived, single-session secret the server
                    mints; the user&apos;s API key never leaves the server.
                  </FormHelperText>
                </Grid>
              </Grid>

              <Divider sx={{ my: 3 }} />

              {/* ---------------------------------------------------------
                  HOSTED TOOLS (#442)
                  ------------------------------------------------------- */}
              <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
                Hosted tools
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Tools the AI provider runs on its side during an answer. Each one reaches outside
                this deployment and is billed per use by the provider, so every tool is off until
                you switch it on. The model must also support hosted tools.
              </Typography>
              <Grid container spacing={1} data-testid="ai-hosted-tools">
                {AI_HOSTED_TOOL_TYPES.map((tool) => (
                  <Grid key={tool} size={{ xs: 12, sm: 6 }}>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={form.hostedTools[tool]}
                          onChange={(e) =>
                            update('hostedTools', { ...form.hostedTools, [tool]: e.target.checked })
                          }
                          disabled={!canWrite}
                          slotProps={{ input: { 'aria-label': HOSTED_TOOL_COPY[tool].label } }}
                        />
                      }
                      label={HOSTED_TOOL_COPY[tool].label}
                    />
                    <FormHelperText sx={{ mt: 0 }}>{HOSTED_TOOL_COPY[tool].help}</FormHelperText>
                  </Grid>
                ))}
              </Grid>
              <TextField
                fullWidth
                multiline
                minRows={2}
                sx={{ mt: 2 }}
                label="Allowed MCP hosts"
                value={form.mcpAllowedHosts}
                onChange={(e) => update('mcpAllowedHosts', e.target.value)}
                disabled={!canWrite}
                error={!!errors.mcpAllowedHosts}
                helperText={
                  errors.mcpAllowedHosts ??
                  'One host per line, e.g. mcp.example.com, or *.example.com for its subdomains. ' +
                    'Leave empty to allow any https:// server.'
                }
              />
              {form.hostedTools.mcp && parseHosts(form.mcpAllowedHosts).length === 0 && (
                <Alert severity="warning" sx={{ mt: 2 }} data-testid="ai-mcp-any-host-warning">
                  Remote MCP is on with no host allowlist: users can point the model at any
                  https:// server.
                </Alert>
              )}

              <Divider sx={{ my: 3 }} />

              {/* ---------------------------------------------------------
                  LIMITS (#450)
                  ------------------------------------------------------- */}
              <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
                Limits
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Guardrails on how much each user can call AI. Leave a field blank for no limit. A
                user over a limit is refused until the window resets — a minute, or midnight UTC
                for daily limits. Per-model limits are set on each model on the AI Models page.
              </Typography>
              <Grid container spacing={2} data-testid="ai-limits">
                {LIMIT_FIELDS.map((field) => (
                  <Grid key={field} size={{ xs: 12, sm: 6 }}>
                    <TextField
                      fullWidth
                      label={LIMIT_COPY[field].label}
                      value={form.limits[field]}
                      onChange={(e) => update('limits', { ...form.limits, [field]: e.target.value })}
                      disabled={!canWrite}
                      slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                      error={!!errors.limits[field]}
                      helperText={errors.limits[field] ?? LIMIT_COPY[field].help}
                    />
                  </Grid>
                ))}
              </Grid>
            </Paper>

            {/* -------------------------------------------------------------
                PROVIDERS
                ----------------------------------------------------------- */}
            <Typography variant="h5" component="h2" sx={{ mt: 4, mb: 2 }}>
              Providers
            </Typography>
            {config.providers.length === 0 ? (
              <Alert severity="info">No AI providers are registered in this build.</Alert>
            ) : (
              <Stack spacing={2}>
                {config.providers.map((provider) => (
                  <AiProviderCard
                    key={provider.id}
                    provider={provider}
                    value={form.providers[provider.id] ?? EMPTY_PROVIDER_FORM_VALUE}
                    onChange={(next) =>
                      setForm((prev) =>
                        prev ? { ...prev, providers: { ...prev.providers, [provider.id]: next } } : prev,
                      )
                    }
                    canWrite={canWrite}
                    errors={errors.providers[provider.id]}
                    aiEnabled={config.enabled}
                    keyAction={keyAction?.provider === provider.id ? keyAction.action : null}
                    busy={busy}
                    keyError={keyError?.provider === provider.id ? keyError.message : null}
                    onClearKeyError={clearKeyError}
                    onSaveKey={(apiKey) =>
                      handleSaveKey(provider.id, provider.displayName, apiKey)
                    }
                    onRemoveKey={() => handleRemoveKey(provider.id, provider.displayName)}
                    isProbing={probingProvider === provider.id}
                    probeError={probeError?.provider === provider.id ? probeError.message : null}
                    onClearProbeError={clearProbeError}
                    testResult={testResults[provider.id] ?? null}
                    onClearTestResult={() => clearTestResult(provider.id)}
                    onTest={(apiKey) =>
                      void test(provider.id, {
                        apiKey,
                        // The base URL ON SCREEN, saved or not — so a gateway
                        // can be proved before it is committed to.
                        baseUrl: form.providers[provider.id]?.baseUrl.trim() || undefined,
                      })
                    }
                  />
                ))}
              </Stack>
            )}

            {keyWarnings.includes('ORG_FALLBACK_WITHOUT_KEY') && (
              <Alert
                severity="warning"
                sx={{ mt: 3 }}
                onClose={clearKeyWarnings}
                data-testid="ai-org-fallback-without-key"
              >
                <AlertTitle>Users can no longer fall back to the organization key</AlertTitle>
                The key policy still falls back to the organization key, but no key is stored for
                that provider any more. Users without their own key will be refused until a new
                organization key is saved or the policy is changed.
              </Alert>
            )}

            {saveError && (
              <Alert severity="error" sx={{ mt: 3 }} onClose={clearSaveError}>
                <AlertTitle>Could not save</AlertTitle>
                {saveError}
              </Alert>
            )}

            <Box
              sx={{
                mt: 3,
                display: 'flex',
                flexDirection: { xs: 'column', sm: 'row' },
                alignItems: { xs: 'stretch', sm: 'center' },
                gap: 2,
              }}
            >
              <Button
                type="submit"
                variant="contained"
                disabled={!canWrite || !isDirty || invalid || busy}
              >
                {isSaving ? 'Saving…' : 'Save changes'}
              </Button>
              <Typography variant="body2" color="text.secondary">
                Saves the switches, the policy, the defaults, the limits and each
                provider&apos;s settings. Keys are saved separately, on each provider.
              </Typography>
            </Box>
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
