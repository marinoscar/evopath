/**
 * Admin → Settings → Storage (`/admin/settings/storage`).
 *
 * Issue #376, epic #372. A STANDALONE PAGE, exactly like `EmailSettingsPage`
 * and `PushConfigPage` and for the same reason: it hits its own controller
 * (`/api/admin/storage-config`) with its own document and its own permission
 * pair, not the generic `system_settings` blob the `SettingsHub` pages share.
 * One entry in `ADMIN_SECTIONS` (`config/adminSections.tsx`), one route in
 * `App.tsx` gated on the same `storage_config:read` string, no tab anywhere —
 * `CLAUDE.md`'s "MANDATORY: Settings UI Pattern" rules 1–3.
 *
 * =============================================================================
 * SNACKBAR vs. ALERT, AND THE RULE THAT DECIDES
 * =============================================================================
 *
 * `EmailSettingsPage`'s header argues this explicitly and it holds here twice
 * over. A SAVE is the ordinary, expected outcome and says nothing an admin has
 * to read twice — `Snackbar`. Anything they must actually READ is a persistent,
 * dismissible `Alert`: a failed check, the provider's verbatim error string,
 * and above all the `guided` command block, which is a multi-line shell
 * snippet nobody can copy out of a toast that slides away in five seconds.
 *
 * =============================================================================
 * THE SECRET ACCESS KEY IS WRITE-ONLY, AND BLANK PRESERVES
 * =============================================================================
 *
 * It lives OUTSIDE `form`, in its own state, because it is not a value this
 * page ever read — it is a write-only instruction. Keeping it in the form
 * object would put it in the dirty comparison's baseline, where an empty
 * string would have to mean both "unchanged" and "erase": the exact ambiguity
 * the API's contract exists to remove. The field renders empty because the
 * stored key is encrypted and unreadable, never because nothing is stored, so
 * `secretStatus` — the only non-secret thing the API says about it — writes
 * the helper text rather than a fixed placeholder guessing at it.
 *
 * =============================================================================
 * `forcePathStyle` IS THREE-STATE, AND A SWITCH CANNOT SAY IT
 * =============================================================================
 *
 * `boolean | null`, where `null` is "use this vendor's convention" — path style
 * for `s3compatible`, virtual-host style for `s3` and `r2`. That is NOT the
 * same as `false`, and #374 shipped the bug that proves it: a `false` nobody
 * chose reached the driver as an operator's explicit answer, suppressed the
 * vendor default and broke MinIO. A two-position `Switch` has no way to render
 * "unset", so it would have to invent one of the two booleans on load and
 * write it back on the next save — silently converting every deployment's
 * "unset" into an explicit choice. The control is therefore a three-option
 * radio group, and `null` is a first-class, selectable answer.
 *
 * =============================================================================
 * THE TWO PROBES RUN AGAINST WHAT IS ON SCREEN, NOT WHAT IS SAVED
 * =============================================================================
 *
 * The opposite of `EmailSettingsPage`, deliberately, and it is the API's
 * contract rather than a UI preference: `POST /test` and `POST /bucket` both
 * take the configuration in the REQUEST BODY, so a new bucket can be proved
 * before the deployment is committed to it. There is therefore no "save first"
 * gate on the test button — gating it on a clean form would remove the one
 * workflow these endpoints were built for.
 */

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Container,
  Divider,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  Grid,
  IconButton,
  Paper,
  Radio,
  RadioGroup,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutlined';
import NetworkCheckIcon from '@mui/icons-material/NetworkCheck';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useStorageConfig } from '../../hooks/useStorageConfig';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { StorageSwitchConfirmDialog } from '../../components/admin/StorageSwitchConfirmDialog';
import { reportsBucketMissing } from '../../services/storageConfig';
import type {
  StorageBucketProvisionResult,
  StorageConfigInput,
  StorageConfigView,
  StorageConnectionCheck,
  StorageProviderKind,
  StorageSecretStatus,
} from '../../services/storageConfig';

/**
 * The form's own state: the seven settings fields, flat, exactly as the wire
 * carries them. Flat because every field is edited independently and the
 * payload is flat too, so there is no regrouping step in either direction to
 * get wrong.
 *
 * `forcePathStyle` is the one non-string, and it keeps its `boolean | null`
 * type all the way through rather than being flattened to a radio string and
 * converted at submit — see `FORCE_PATH_STYLE_CHOICES`.
 */
interface StorageFormState {
  provider: StorageProviderKind;
  bucket: string;
  region: string;
  /** The operator's endpoint OVERRIDE. For R2 this is normally empty. */
  endpoint: string;
  accountId: string;
  accessKeyId: string;
  forcePathStyle: boolean | null;
}

/** Mirrors `deriveR2Endpoint` / `R2_ENDPOINT_HOST_SUFFIX` in `apps/api/src/storage/config/storage-config.ts`. */
const R2_ENDPOINT_HOST_SUFFIX = 'r2.cloudflarestorage.com';

function deriveR2Endpoint(accountId: string): string {
  return `https://${accountId.trim()}.${R2_ENDPOINT_HOST_SUFFIX}`;
}

/** The API's own ceilings (`updateStorageConfigSchema`), so the obvious typo does not round-trip. */
const MAX_FIELD_LENGTH = 255;
const MAX_ENDPOINT_LENGTH = 512;

const PROVIDER_LABELS: Record<StorageProviderKind, string> = {
  s3: 'Amazon S3',
  r2: 'Cloudflare R2',
  s3compatible: 'S3-compatible (MinIO, Wasabi, Backblaze B2…)',
};

/**
 * The three answers `forcePathStyle` can hold, as radio values.
 *
 * The mapping is the whole point of this table: `'vendor'` is `null`, and it is
 * a REAL saved value meaning "I have not overridden this", not the absence of
 * an answer. See the file header for why a `Switch` cannot express it.
 */
const FORCE_PATH_STYLE_CHOICES = {
  vendor: null,
  on: true,
  off: false,
} as const;

type ForcePathStyleChoice = keyof typeof FORCE_PATH_STYLE_CHOICES;

function forcePathStyleChoice(value: boolean | null): ForcePathStyleChoice {
  if (value === null) return 'vendor';
  return value ? 'on' : 'off';
}

/**
 * What the vendor convention actually IS for the selected provider, named in
 * prose next to the control.
 *
 * "Use this vendor's convention" is meaningless on its own — an operator
 * choosing it deserves to know what they just chose. The two answers come from
 * `buildS3ClientConfig` on the API side, which is the only place that knows
 * them; this sentence reports that table rather than duplicating the decision.
 */
function vendorConventionFor(provider: StorageProviderKind): string {
  return provider === 's3compatible'
    ? 'path-style addressing (https://host/bucket/key)'
    : 'virtual-host addressing (https://bucket.host/key)';
}

function toFormState(config: StorageConfigView): StorageFormState {
  return {
    provider: config.provider,
    bucket: config.bucket,
    region: config.region,
    endpoint: config.endpoint,
    accountId: config.accountId,
    accessKeyId: config.accessKeyId,
    forcePathStyle: config.forcePathStyle,
  };
}

/**
 * What to say about the stored secret access key.
 *
 * `hint` is the credential store's own mask, derived on write by the code that
 * held the plaintext. It beats a fixed placeholder outright: an admin who has
 * just rotated a key can see WHICH one is live, not merely that one exists. It
 * can still be null — for a secret too short to mask safely, or a row written
 * outside `CredentialsService` — so the sentence is assembled to read correctly
 * without it rather than assuming it is there. Mirrors
 * `smtpPasswordHelperText` in `EmailSettingsPage`.
 */
function secretHelperText(status: StorageSecretStatus): string {
  if (!status.configured) {
    return 'No secret access key is stored yet. Storage cannot work without one.';
  }
  const which = status.hint ? ` (${status.hint})` : '';
  const when = status.updatedAt
    ? `, last changed ${new Date(status.updatedAt).toLocaleDateString()}`
    : '';
  return `A secret access key is saved${which}${when}. Leave this blank to keep it, or type a new one to replace it.`;
}

/**
 * Field-level validation, client-side only and deliberately thin.
 *
 * The API validates for real — it must, since this page is not the only
 * possible caller — and this exists to stop the obvious typo round-tripping.
 * NOTE WHAT IS NOT REQUIRED: an empty `bucket` is how a deployment is
 * un-configured, so blanking the form is a legitimate save rather than an
 * error. What IS checked is anything that would produce a confusing failure
 * several layers down: an endpoint that is not a URL (the S3 client rejects it
 * at construction, far from this form), and an R2 account id missing while a
 * bucket is named (the endpoint would be derived from an empty string and the
 * request would go to a host that cannot exist).
 */
function validate(form: StorageFormState): Partial<Record<keyof StorageFormState, string>> {
  const errors: Partial<Record<keyof StorageFormState, string>> = {};

  if (form.bucket.trim().length > MAX_FIELD_LENGTH) {
    errors.bucket = `Keep the bucket name to ${MAX_FIELD_LENGTH} characters or fewer.`;
  }
  if (form.region.trim().length > MAX_FIELD_LENGTH) {
    errors.region = `Keep the region to ${MAX_FIELD_LENGTH} characters or fewer.`;
  }
  if (form.accessKeyId.trim().length > MAX_FIELD_LENGTH) {
    errors.accessKeyId = `Keep the access key id to ${MAX_FIELD_LENGTH} characters or fewer.`;
  }

  const endpoint = form.endpoint.trim();
  if (endpoint) {
    if (endpoint.length > MAX_ENDPOINT_LENGTH) {
      errors.endpoint = `Keep the endpoint to ${MAX_ENDPOINT_LENGTH} characters or fewer.`;
    } else if (!/^https?:\/\/\S+$/i.test(endpoint)) {
      errors.endpoint = 'Must be a full URL, e.g. https://minio.example.com:9000.';
    }
  }

  if (form.provider === 's3compatible' && form.bucket.trim() && !endpoint) {
    errors.endpoint = 'An S3-compatible provider needs an endpoint — there is no default host.';
  }

  if (form.provider === 'r2') {
    const accountId = form.accountId.trim();
    if (!accountId && form.bucket.trim() && !endpoint) {
      errors.accountId = 'R2 needs an account id — the endpoint is derived from it.';
    }
    if (accountId.length > MAX_FIELD_LENGTH) {
      errors.accountId = `Keep the account id to ${MAX_FIELD_LENGTH} characters or fewer.`;
    }
  }

  if (form.provider === 's3' && form.bucket.trim() && !form.region.trim()) {
    errors.region = 'Amazon S3 needs a region, e.g. us-east-1.';
  }

  return errors;
}

/** A multi-line shell block: monospace, selectable, and copied whole. Mirrors `DbBackupRestoreDialog`'s. */
function CopyableBlock({ value, label, testId }: { value: string; label: string; testId: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Clipboard access denied or unavailable. The block below is still
      // complete and still selectable, which is the right fallback.
    }
  };

  return (
    <Box sx={{ mt: 1 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          {label}
        </Typography>
        <Tooltip title={copied ? 'Copied' : `Copy ${label.toLowerCase()}`}>
          <IconButton size="small" onClick={() => void handleCopy()} aria-label={`Copy ${label}`}>
            {copied ? (
              <CheckIcon fontSize="small" color="success" />
            ) : (
              <ContentCopyIcon fontSize="small" />
            )}
          </IconButton>
        </Tooltip>
      </Stack>
      <Paper variant="outlined" sx={{ p: 1.5, overflowX: 'auto', backgroundColor: 'action.hover' }}>
        <Typography
          component="pre"
          data-testid={testId}
          sx={{ m: 0, fontFamily: 'monospace', fontSize: '0.8125rem', whiteSpace: 'pre' }}
        >
          {value}
        </Typography>
      </Paper>
    </Box>
  );
}

/**
 * The extra sentence that turns a code into an action.
 *
 * ⚠ THE WHOLE REASON THE CHECKS ARE REPORTED SEPARATELY. `bucket_missing` (404)
 * and `bucket_forbidden` (403) are the pair the API refuses to collapse, and
 * they need OPPOSITE fixes: create the bucket, versus stop trying to create a
 * bucket that already belongs to somebody else and fix the policy or the typo.
 * A page that rendered both as "bucket check failed" would send an admin to
 * `POST /bucket` for a bucket that exists and is not theirs.
 *
 * `null` for everything else — the API's own `detail` is already actionable,
 * and adding a second sentence to every row would bury the two that matter.
 */
function remedyFor(check: StorageConnectionCheck): string | null {
  switch (check.code) {
    case 'bucket_missing':
      return 'The bucket does not exist. Create it below, or point the configuration at one that does.';
    case 'bucket_forbidden':
      return 'The bucket exists and this key may not see it. Widen the credential’s policy — or check for a typo that landed on somebody else’s bucket. Do NOT try to create it.';
    case 'bucket_region_mismatch':
      return 'The bucket is real but lives in another region. Correct the region rather than the bucket name.';
    case 'credentials_rejected':
      return 'The provider rejected the key pair itself. Check the access key id above, and retype the secret.';
    case 'endpoint_unreachable':
      return 'Nothing answered at the endpoint. Check the host, the port and that this deployment can reach it at all.';
    case 'not_configured':
      return 'Fill in the fields above first — there is not enough here to build a client.';
    default:
      return null;
  }
}

const CHECK_ICONS = {
  passed: <CheckCircleIcon color="success" fontSize="small" />,
  failed: <ErrorOutlineIcon color="error" fontSize="small" />,
  skipped: <RemoveCircleOutlineIcon color="disabled" fontSize="small" />,
} as const;

/**
 * ONE ROW PER CHECK, never a rolled-up verdict.
 *
 * The `code` is rendered as a chip beside the label, in full, because it is the
 * word an operator will search for in the runbook and in an issue — and because
 * it is what makes two rows that both say "failed" legibly different.
 */
function CheckRow({ check }: { check: StorageConnectionCheck }) {
  const remedy = remedyFor(check);

  return (
    <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }} data-testid={`storage-check-${check.id}`}>
      <Box sx={{ pt: 0.25 }}>{CHECK_ICONS[check.status]}</Box>
      <Box sx={{ minWidth: 0, flexGrow: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="subtitle2">{check.label}</Typography>
          <Chip
            size="small"
            variant="outlined"
            label={check.code}
            data-testid={`storage-check-code-${check.id}`}
            color={
              check.status === 'passed' ? 'success' : check.status === 'failed' ? 'error' : 'default'
            }
          />
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {check.detail}
        </Typography>
        {remedy && (
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            {remedy}
          </Typography>
        )}
        {/* VERBATIM, wrapping rather than truncating. Provider errors carry
            codes, bucket names and quoted regions that ARE the diagnosis; an
            ellipsis in the middle of one costs the admin the answer. */}
        {check.error && (
          <Box
            component="pre"
            data-testid={`storage-check-error-${check.id}`}
            sx={{
              m: 0,
              mt: 1,
              fontFamily: 'monospace',
              fontSize: '0.8125rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {check.error}
          </Box>
        )}
      </Box>
    </Box>
  );
}

/** Severity for a bucket action's outcome. `guided` is INFO — it is a successful 200, not a fault. */
function bucketAlertSeverity(
  outcome: StorageBucketProvisionResult['outcome'],
): 'success' | 'info' | 'warning' | 'error' {
  switch (outcome) {
    case 'created':
    case 'already_exists':
      return 'success';
    case 'guided':
      return 'info';
    case 'partial':
      return 'warning';
    default:
      return 'error';
  }
}

const BUCKET_OUTCOME_TITLES: Record<StorageBucketProvisionResult['outcome'], string> = {
  created: 'Bucket created and configured',
  already_exists: 'Bucket already existed — settings re-applied',
  partial: 'Bucket created, but not everything could be applied',
  guided: 'This credential cannot create buckets — here is how to do it',
  failed: 'The bucket could not be created',
};

export default function StorageConfigPage() {
  const { hasPermission } = usePermissions();
  const {
    config,
    isLoading,
    loadError,
    isSaving,
    saveError,
    switchRequired,
    clearSwitchRequired,
    save,
    clearSaveError,
    isProbing,
    probeError,
    clearProbeError,
    testResult,
    clearTestResult,
    bucketResult,
    clearBucketResult,
    test,
    createBucket,
  } = useStorageConfig();

  const [form, setForm] = useState<StorageFormState | null>(null);
  /** WRITE-ONLY, and held outside `form` on purpose — see the file header. */
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  // The server's response is the new baseline after every load AND every save,
  // so this also clears the secret box once a save has consumed it. Leaving a
  // typed key on screen after a successful save would imply it is still
  // pending, and the next save would send it again.
  useEffect(() => {
    if (config) {
      setForm(toFormState(config));
      setSecretAccessKey('');
    }
  }, [config]);

  // Defence, not the gate — `App.tsx` wraps the route in `RequirePermission`
  // with this same string. This one catches the page mounted from anywhere
  // else. It sits after every hook so the hook order never changes.
  if (!hasPermission('storage_config:read')) {
    return <Navigate to="/" replace />;
  }

  const canWrite = hasPermission('storage_config:write');

  if (isLoading || (!form && !loadError)) {
    return <LoadingSpinner />;
  }

  const errors = form ? validate(form) : {};
  const hasErrors = Object.keys(errors).length > 0;

  // A typed secret counts as a change even when every other field matches: it
  // is the one edit that leaves no visible trace in the form baseline.
  const isDirty =
    !!form &&
    !!config &&
    (JSON.stringify(form) !== JSON.stringify(toFormState(config)) || secretAccessKey !== '');

  const update = <K extends keyof StorageFormState>(key: K, value: StorageFormState[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  /**
   * The body all three write endpoints take.
   *
   * EMPTY BOXES GO AS `''`, NOT AS OMITTED KEYS — that is how an operator drops
   * an endpoint override, or un-configures storage entirely by clearing the
   * bucket. Fields belonging to a provider that is NOT selected are still
   * submitted from form state rather than blanked, so switching between
   * providers and back loses nothing.
   *
   * THE ONE EXCEPTION, AND THE OPPOSITE MEANING: `secretAccessKey` is omitted
   * entirely when it was not retyped. The intent reaches the API as an absence
   * rather than as a value it has to interpret, and no code path can ever send
   * an empty secret that a future server revision might read as "clear it".
   */
  const toInput = (state: StorageFormState): StorageConfigInput => ({
    provider: state.provider,
    bucket: state.bucket.trim(),
    region: state.region.trim(),
    endpoint: state.endpoint.trim(),
    accountId: state.accountId.trim(),
    accessKeyId: state.accessKeyId.trim(),
    forcePathStyle: state.forcePathStyle,
    ...(secretAccessKey ? { secretAccessKey } : {}),
  });

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || hasErrors || !canWrite) return;
    const ok = await save(toInput(form));
    if (ok) {
      setSavedMessage('Storage configuration saved');
      // The previous probes described a configuration that may no longer be the
      // one on screen. Keeping them would leave a green "connected" — or a red
      // error the admin has just fixed — sitting next to settings it never
      // exercised. (Deliberately asymmetric with plain EDITING, which does NOT
      // clear them: reading the provider's error is precisely what the admin is
      // doing while typing the fix.)
      clearTestResult();
      clearBucketResult();
    }
  };

  /** The confirmed re-send: the identical body, plus the typed literal. */
  const handleConfirmSwitch = async () => {
    if (!form) return;
    const ok = await save(toInput(form), { confirmSwitch: true });
    if (ok) {
      clearSwitchRequired();
      setSavedMessage('Storage configuration saved — this deployment now uses the new location');
      clearTestResult();
      clearBucketResult();
    }
  };

  /**
   * Why a probe is unavailable, or `null` when it is available.
   *
   * Rendered as prose next to the buttons rather than left as a mysteriously
   * greyed control: "disabled with no explanation" is indistinguishable from
   * "broken", and these are the buttons anybody came here to press.
   *
   * NOTE WHAT IS ABSENT: a dirty check. Unlike the email test, these endpoints
   * take the configuration in the request body, so testing unsaved fields is
   * the intended workflow rather than a trap.
   */
  const probeBlockedReason: string | null = !canWrite
    ? 'Testing writes a throwaway object and asks the provider to do work, so it needs permission to change the storage configuration.'
    : isSaving
      ? 'Saving — wait for the save to finish, then test.'
      : hasErrors
        ? 'Fix the highlighted fields first.'
        : null;

  const bucketMissing = reportsBucketMissing(testResult);
  const effectiveEndpointPreview =
    form && form.provider === 'r2'
      ? form.endpoint.trim() || (form.accountId.trim() ? deriveR2Endpoint(form.accountId) : '')
      : '';

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        {/* Title and description MIRROR the `Storage` card in
            `config/adminSections.tsx` so the hub card, the rail row, the
            compact AppBar title and this `h1` all name the page identically. */}
        <Typography variant="h4" component="h1" gutterBottom>
          Storage
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Point this deployment at an object store, prove the credentials work, and create the
          bucket if it is not there yet.
          {!canWrite && ' (read-only)'}
        </Typography>

        {config?.updatedBy && config.updatedAt && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Last updated by {config.updatedBy.email} on{' '}
            {new Date(config.updatedAt).toLocaleString()}
          </Typography>
        )}

        {loadError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {loadError}
          </Alert>
        )}

        {/* READ-ONLY IS STATED, NOT MIMED. Every control below stays visible and
            disabled rather than being hidden: a read-only admin diagnosing
            "why did that upload fail" needs to SEE the bucket and the endpoint,
            and a page that hid half its fields would read as broken. */}
        {!canWrite && !loadError && (
          <Alert severity="info" sx={{ mb: 3 }} data-testid="storage-read-only-notice">
            You can read this configuration but not change it. Saving, testing the connection and
            creating a bucket all need <code>storage_config:write</code>.
          </Alert>
        )}

        {/* WHETHER STORAGE WORKS AT ALL, ANSWERED BY THE API AND NOT RE-DERIVED
            HERE. `configured` is the same function the upload path asks, and
            `missing` names every field standing in the way — recomputing either
            from the form would be a second copy of the rule, free to disagree
            with the one that actually decides whether a file can be stored. */}
        {config && !config.configured && !loadError && (
          <Alert severity="warning" sx={{ mb: 3 }} data-testid="storage-not-configured">
            <AlertTitle>Object storage is not configured</AlertTitle>
            Uploads, avatars, job artifacts and database backups all fail until this is complete.
            {config.missing.length > 0 && (
              <Box sx={{ mt: 1 }}>
                Still needed: <strong>{config.missing.join(', ')}</strong>
              </Box>
            )}
          </Alert>
        )}

        {form && config && (
          <Paper sx={{ mt: 2, p: { xs: 2, sm: 3 } }}>
            <Box component="form" onSubmit={handleSubmit} noValidate>
              <FormControl sx={{ mb: 1 }}>
                <FormLabel id="storage-provider-label">Provider</FormLabel>
                {/* Column on phones, row from `sm` up, expressed in `sx` rather
                    than a `useMediaQuery` — this is pure layout and must not
                    become a sixth breakpoint gate alongside the five coupled
                    ones documented in `common/Layout.tsx`. */}
                <RadioGroup
                  aria-labelledby="storage-provider-label"
                  value={form.provider}
                  onChange={(e) => update('provider', e.target.value as StorageProviderKind)}
                  sx={{ flexDirection: { xs: 'column', sm: 'row' }, columnGap: 3 }}
                >
                  <FormControlLabel
                    value="s3"
                    control={<Radio />}
                    label={PROVIDER_LABELS.s3}
                    disabled={!canWrite}
                  />
                  <FormControlLabel
                    value="r2"
                    control={<Radio />}
                    label={PROVIDER_LABELS.r2}
                    disabled={!canWrite}
                  />
                  <FormControlLabel
                    value="s3compatible"
                    control={<Radio />}
                    label={PROVIDER_LABELS.s3compatible}
                    disabled={!canWrite}
                  />
                </RadioGroup>
                <FormHelperText>
                  Which object store this deployment talks to. Fields for the providers you are
                  not using are kept, so switching back loses nothing.
                </FormHelperText>
              </FormControl>

              <Grid container spacing={2} sx={{ mt: 1 }}>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <TextField
                    fullWidth
                    label="Bucket"
                    value={form.bucket}
                    onChange={(e) => update('bucket', e.target.value)}
                    disabled={!canWrite}
                    error={!!errors.bucket}
                    helperText={
                      errors.bucket ??
                      'Clearing this un-configures storage for the whole deployment.'
                    }
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <TextField
                    fullWidth
                    label="Region"
                    value={form.region}
                    onChange={(e) => update('region', e.target.value)}
                    disabled={!canWrite}
                    error={!!errors.region}
                    helperText={
                      errors.region ??
                      (form.provider === 'r2'
                        ? 'Leave blank for R2 — it signs with "auto". Set one only for a jurisdiction-restricted bucket (eu, fedramp).'
                        : form.provider === 's3compatible'
                          ? 'Leave blank to sign with us-east-1, which most S3-compatible servers ignore.'
                          : 'The region holding the bucket, e.g. us-east-1.')
                    }
                  />
                </Grid>
              </Grid>

              {/* ================================================================
                  PROVIDER-SPECIFIC FIELDS. Rendered per provider, but their
                  VALUES live in one form state and are resubmitted untouched, so
                  switching provider never discards a configuration the admin may
                  switch back to. (The same rule `SettingsHub` follows for its two
                  responsive treatments: what is not shown is not mounted, because
                  a hidden duplicate doubles the tab order with targets a keyboard
                  user can reach but not see.)
                  ============================================================= */}
              {form.provider === 'r2' && (
                <>
                  <Divider sx={{ my: 3 }} />
                  <Typography variant="h6" gutterBottom>
                    Cloudflare R2
                  </Typography>
                  <Grid container spacing={2}>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <TextField
                        fullWidth
                        label="Account ID"
                        value={form.accountId}
                        onChange={(e) => update('accountId', e.target.value)}
                        disabled={!canWrite}
                        error={!!errors.accountId}
                        helperText={
                          errors.accountId ??
                          'Your Cloudflare account id. The endpoint is built from it.'
                        }
                      />
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      {/* ⚠ READ-ONLY, AND NEVER A FIELD TO TYPE INTO. R2's
                          endpoint is a pure function of the account id
                          (`deriveR2Endpoint`), so asking an operator to type it
                          is asking them to reproduce a derivation the server
                          already performs — and to get it subtly wrong once,
                          permanently, in a place nothing else looks. */}
                      <TextField
                        fullWidth
                        label="Endpoint (derived)"
                        value={effectiveEndpointPreview}
                        disabled
                        slotProps={{ htmlInput: { readOnly: true, 'data-testid': 'r2-derived-endpoint' } }}
                        placeholder={`https://<account id>.${R2_ENDPOINT_HOST_SUFFIX}`}
                        helperText={
                          form.endpoint.trim()
                            ? 'A stored endpoint override is in force and takes precedence over the derived host.'
                            : 'Built from the account id — there is nothing to type here.'
                        }
                      />
                      {/* The override is invisible on this provider otherwise,
                          which is exactly how a value left behind by an earlier
                          S3-compatible configuration silently keeps winning. */}
                      {form.endpoint.trim() && (
                        <Button
                          size="small"
                          sx={{ mt: 1 }}
                          disabled={!canWrite}
                          onClick={() => update('endpoint', '')}
                        >
                          Clear the override and use the derived endpoint
                        </Button>
                      )}
                    </Grid>
                  </Grid>
                </>
              )}

              {form.provider === 's3compatible' && (
                <>
                  <Divider sx={{ my: 3 }} />
                  <Typography variant="h6" gutterBottom>
                    S3-compatible endpoint
                  </Typography>
                  <Grid container spacing={2}>
                    <Grid size={{ xs: 12 }}>
                      <TextField
                        fullWidth
                        label="Endpoint"
                        value={form.endpoint}
                        onChange={(e) => update('endpoint', e.target.value)}
                        disabled={!canWrite}
                        error={!!errors.endpoint}
                        helperText={
                          errors.endpoint ??
                          'The full URL of the server, e.g. https://minio.example.com:9000.'
                        }
                      />
                    </Grid>
                  </Grid>
                </>
              )}

              {form.provider === 's3' && (
                <>
                  <Divider sx={{ my: 3 }} />
                  <Typography variant="h6" gutterBottom>
                    Amazon S3
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    No endpoint is needed — the AWS SDK builds one from the region and the bucket.
                  </Typography>
                </>
              )}

              <Divider sx={{ my: 3 }} />
              <Typography variant="h6" gutterBottom>
                Credentials
              </Typography>
              <Grid container spacing={2}>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <TextField
                    fullWidth
                    label="Access key ID"
                    value={form.accessKeyId}
                    onChange={(e) => update('accessKeyId', e.target.value)}
                    disabled={!canWrite}
                    autoComplete="off"
                    error={!!errors.accessKeyId}
                    helperText={
                      errors.accessKeyId ??
                      'Shown in full on purpose: it travels in the clear in every signed request, and it is what tells a rotated key from a mistyped one.'
                    }
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 6 }}>
                  {/* THE BLANK-PRESERVES CONTRACT, SAID OUT LOUD. The field
                      renders empty because the stored secret is encrypted and
                      unreadable — not because there is nothing stored. An empty
                      box that silently means "keep" confuses; one that silently
                      means "erase" destroys. So the helper text states which it
                      is, and `secretStatus` decides the wording so the sentence
                      is never a guess. */}
                  <TextField
                    fullWidth
                    type="password"
                    label="Secret access key"
                    value={secretAccessKey}
                    onChange={(e) => setSecretAccessKey(e.target.value)}
                    disabled={!canWrite}
                    // A password manager filling this box would silently
                    // re-send a credential the admin never typed.
                    autoComplete="new-password"
                    placeholder={
                      config.secretStatus.configured
                        ? (config.secretStatus.hint ?? '••••••••')
                        : ''
                    }
                    helperText={secretHelperText(config.secretStatus)}
                  />
                </Grid>
              </Grid>

              <Divider sx={{ my: 3 }} />

              {/* THREE OPTIONS, NOT A SWITCH — see the file header. `null` is a
                  first-class, selectable answer here rather than a state the
                  control has to invent a boolean for. */}
              <FormControl>
                <FormLabel id="storage-force-path-style-label">Path-style addressing</FormLabel>
                <RadioGroup
                  aria-labelledby="storage-force-path-style-label"
                  value={forcePathStyleChoice(form.forcePathStyle)}
                  onChange={(e) =>
                    update(
                      'forcePathStyle',
                      FORCE_PATH_STYLE_CHOICES[e.target.value as ForcePathStyleChoice],
                    )
                  }
                  sx={{ flexDirection: { xs: 'column', sm: 'row' }, columnGap: 3 }}
                >
                  <FormControlLabel
                    value="vendor"
                    control={<Radio />}
                    label="Use this provider's convention"
                    disabled={!canWrite}
                  />
                  <FormControlLabel
                    value="on"
                    control={<Radio />}
                    label="Force path-style on"
                    disabled={!canWrite}
                  />
                  <FormControlLabel
                    value="off"
                    control={<Radio />}
                    label="Force path-style off"
                    disabled={!canWrite}
                  />
                </RadioGroup>
                <FormHelperText>
                  {PROVIDER_LABELS[form.provider]} uses {vendorConventionFor(form.provider)} unless
                  you override it. Leaving this on the provider&apos;s convention is not the same
                  as forcing it off — an explicit &quot;off&quot; suppresses the default and is
                  what breaks a MinIO deployment.
                </FormHelperText>
              </FormControl>

              {saveError && (
                <Alert severity="error" sx={{ mt: 3 }} onClose={clearSaveError}>
                  <AlertTitle>Could not save</AlertTitle>
                  {saveError}
                </Alert>
              )}

              <Divider sx={{ my: 3 }} />

              {/* Column on phones so no button is squeezed to an unreadable
                  width; a row from `sm` up, where there is space. */}
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: { xs: 'column', sm: 'row' },
                  alignItems: { xs: 'stretch', sm: 'center' },
                  gap: 2,
                  flexWrap: 'wrap',
                }}
              >
                <Button
                  type="submit"
                  variant="contained"
                  disabled={!canWrite || !isDirty || hasErrors || isSaving || isProbing}
                >
                  {isSaving ? 'Saving…' : 'Save changes'}
                </Button>
                <Button
                  variant="outlined"
                  startIcon={<NetworkCheckIcon />}
                  onClick={() => void test(toInput(form))}
                  disabled={!!probeBlockedReason || isProbing}
                >
                  {isProbing ? 'Working…' : 'Test connection'}
                </Button>
                {/* OFFERED ONLY WHEN THE TEST SAID THE BUCKET IS NOT THERE.
                    `bucket_forbidden` deliberately does NOT offer it: creating a
                    bucket that already exists and belongs to somebody else is
                    not the fix, and offering the button would send an admin
                    down exactly the wrong path. See `remedyFor`. */}
                {bucketMissing && (
                  <Button
                    variant="outlined"
                    color="secondary"
                    startIcon={<CreateNewFolderOutlinedIcon />}
                    onClick={() => void createBucket(toInput(form))}
                    disabled={!!probeBlockedReason || isProbing}
                    data-testid="storage-create-bucket"
                  >
                    Create bucket
                  </Button>
                )}
                <Typography variant="body2" color="text.secondary">
                  {probeBlockedReason ??
                    'Tests what is on screen, saved or not — so a new bucket can be proved before you commit to it. One small object is written and deleted again.'}
                </Typography>
              </Box>
            </Box>
          </Paper>
        )}

        {/* THE DIAGNOSTIC SURFACE, persistent and dismissible rather than a
            snackbar. `NoSuchBucket: The specified bucket does not exist` and a
            paste-ready `aws s3api create-bucket` block are the entire reason an
            admin opened this page, and neither fits in a toast. */}
        {probeError && (
          <Alert severity="error" sx={{ mt: 3 }} onClose={clearProbeError}>
            <AlertTitle>The request itself failed</AlertTitle>
            {probeError}
          </Alert>
        )}

        {testResult && (
          <Alert
            severity={testResult.success ? 'success' : 'error'}
            sx={{ mt: 3 }}
            onClose={clearTestResult}
            data-testid="storage-test-result"
          >
            <AlertTitle>
              {testResult.success
                ? 'Storage is reachable and writable'
                : 'The storage configuration did not pass'}
            </AlertTitle>
            <Typography variant="body2" sx={{ mb: 1 }}>
              {testResult.provider} · {testResult.bucket}
              {testResult.effectiveEndpoint ? ` at ${testResult.effectiveEndpoint}` : ''} ·{' '}
              {testResult.usedStoredSecret
                ? 'tested with the stored secret key'
                : 'tested with the key typed above'}
            </Typography>
            {/* ONE ROW PER CHECK. The API refuses to collapse them and so does
                this: `bucket_missing` and `bucket_forbidden` need opposite
                actions, and a single rolled-up verdict cannot say which. */}
            <Stack spacing={1.5} sx={{ mt: 1 }}>
              {testResult.checks.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </Stack>
          </Alert>
        )}

        {bucketResult && (
          <Alert
            severity={bucketAlertSeverity(bucketResult.outcome)}
            sx={{ mt: 3 }}
            onClose={clearBucketResult}
            data-testid="storage-bucket-result"
          >
            <AlertTitle>{BUCKET_OUTCOME_TITLES[bucketResult.outcome]}</AlertTitle>

            {/* ⚠ `guided` IS NOT A FAILURE. A least-privilege credential without
                `s3:CreateBucket` is the ORDINARY configuration — an IAM policy
                scoped to one bucket's objects, or an R2 token minted
                object-read-write. So it renders as INFO carrying a block with
                this deployment's real names already substituted, because a
                block with a placeholder in it is homework, not a deliverable. */}
            {bucketResult.guidance && (
              <>
                <Typography variant="body2" sx={{ mt: 1 }}>
                  {bucketResult.guidance.reason}
                </Typography>
                <CopyableBlock
                  label="Run these, then test the connection again"
                  value={bucketResult.guidance.commands}
                  testId="storage-bucket-guidance-commands"
                />
                {bucketResult.guidance.runbook && (
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    More detail: {bucketResult.guidance.runbook}
                  </Typography>
                )}
              </>
            )}

            {/* PER-STEP OUTCOMES, because partial success is the common case: a
                bucket that was created but could not be hardened must say which
                step failed rather than reporting a success that hides it. */}
            <Stack spacing={1.5} sx={{ mt: 2 }}>
              {bucketResult.steps.map((step) => (
                <Box
                  key={step.id}
                  sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}
                  data-testid={`storage-bucket-step-${step.id}`}
                >
                  <Box sx={{ pt: 0.25 }}>{CHECK_ICONS[step.status]}</Box>
                  <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                    <Typography variant="subtitle2">{step.label}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {step.detail}
                    </Typography>
                    {step.error && (
                      <Box
                        component="pre"
                        sx={{
                          m: 0,
                          mt: 1,
                          fontFamily: 'monospace',
                          fontSize: '0.8125rem',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {step.error}
                      </Box>
                    )}
                  </Box>
                </Box>
              ))}
            </Stack>

            {bucketResult.corsOrigin && (
              <Typography variant="body2" sx={{ mt: 2 }}>
                Browser uploads were allowed from <strong>{bucketResult.corsOrigin}</strong>.
              </Typography>
            )}
          </Alert>
        )}

        {/* Opened only once the API has already refused with
            `STORAGE_LOCATION_IN_USE` — the row counts behind that refusal are
            the server's to know, not this page's to guess. */}
        <StorageSwitchConfirmDialog
          open={!!switchRequired}
          message={switchRequired?.message ?? ''}
          details={switchRequired?.details ?? null}
          isWorking={isSaving}
          onConfirm={() => void handleConfirmSwitch()}
          onClose={clearSwitchRequired}
        />

        {/* Saving is the ordinary, expected outcome, so it gets the transient
            snackbar the sibling settings pages use. The probe results
            deliberately do NOT — see the file header. */}
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
