/**
 * Admin → AI → Coach (`/admin/settings/coach`), E7.3 (#243);
 * docs/specs/ai-coach.md §2.13, §3.2.
 *
 * The deployment's coach policy, from `GET`/`PUT /api/admin/coach/settings`:
 * the coach switch, whether Sarge's adult-language level may be unlocked,
 * whether spoken messages are allowed, the ceiling on a user's daily nudges,
 * audio retention, the auto-silence threshold and the inactivity stop.
 *
 * A REGISTRY CARD of its own (`ADMIN_SECTIONS`, AI group,
 * `permission: 'ai_config:read'`, `feature: 'ai'`). Without `ai_config:write`
 * every control stays visible and DISABLED; the API refuses the PUT anyway.
 *
 * The models the coach uses are chosen on AI Model Assignments (its Coach
 * section), not here. The Engagement panel (`CoachEngagementPanel`, E7.11)
 * reads `GET /api/admin/coach/stats`; an empty state when nothing was sent.
 */
import { useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Container,
  FormControlLabel,
  FormHelperText,
  Link,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { Link as RouterLink, Navigate } from 'react-router-dom';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { CoachEngagementPanel } from '../../components/coach/CoachEngagementPanel';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemCoachSettings } from '../../hooks/useSystemCoachSettings';
import { SYSTEM_COACH_NUMBER_BOUNDS, type SystemCoachSettings } from '../../services/coach';

/** Mirrors the `Coach` card in `config/adminSections.tsx`. */
export const COACH_ADMIN_TITLE = 'Coach';
export const AI_ASSIGNMENTS_PATH = '/admin/settings/ai/assignments';

type NumberField = keyof typeof SYSTEM_COACH_NUMBER_BOUNDS;

interface FormState {
  enabled: boolean;
  allowProfanePersonas: boolean;
  allowAudio: boolean;
  maxNudgesPerDayCeiling: number;
  /** Text, so a half-typed number can be shown and validated inline. */
  audioRetentionDays: string;
  autoSilenceAfterIgnored: string;
  inactiveStopDays: string;
}

function toForm(settings: SystemCoachSettings): FormState {
  return {
    enabled: settings.enabled,
    allowProfanePersonas: settings.allowProfanePersonas,
    allowAudio: settings.allowAudio,
    maxNudgesPerDayCeiling: settings.maxNudgesPerDayCeiling,
    audioRetentionDays: String(settings.audioRetentionDays),
    autoSilenceAfterIgnored: String(settings.autoSilenceAfterIgnored),
    inactiveStopDays: String(settings.inactiveStopDays),
  };
}

/** The parsed value, or `null` when it is not a whole number in range. */
function parseBounded(value: string, field: NumberField): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  const { min, max } = SYSTEM_COACH_NUMBER_BOUNDS[field];
  return parsed >= min && parsed <= max ? parsed : null;
}

function patchOf(form: FormState, settings: SystemCoachSettings): Partial<SystemCoachSettings> | null {
  const patch: Partial<SystemCoachSettings> = {};
  if (form.enabled !== settings.enabled) patch.enabled = form.enabled;
  if (form.allowProfanePersonas !== settings.allowProfanePersonas) patch.allowProfanePersonas = form.allowProfanePersonas;
  if (form.allowAudio !== settings.allowAudio) patch.allowAudio = form.allowAudio;
  if (form.maxNudgesPerDayCeiling !== settings.maxNudgesPerDayCeiling) {
    patch.maxNudgesPerDayCeiling = form.maxNudgesPerDayCeiling;
  }
  for (const field of ['audioRetentionDays', 'autoSilenceAfterIgnored', 'inactiveStopDays'] as const) {
    const parsed = parseBounded(form[field], field);
    if (parsed === null) return null;
    if (parsed !== settings[field]) patch[field] = parsed;
  }
  return patch;
}

const NUMBER_FIELDS: Array<{ field: Exclude<NumberField, 'maxNudgesPerDayCeiling'>; label: string; help: string }> = [
  {
    field: 'audioRetentionDays',
    label: 'Keep spoken audio for (days)',
    help: 'Older audio files are deleted; the message text is kept.',
  },
  {
    field: 'autoSilenceAfterIgnored',
    label: 'Back off after ignored nudges',
    help: 'After this many ignored nudges in a row, the coach sends one back-off message and goes quiet.',
  },
  {
    field: 'inactiveStopDays',
    label: 'Stop after inactive days',
    help: 'After this many days without activity, the coach sends one win-back message and stops.',
  },
];

export default function CoachAdminPage() {
  const { hasPermission } = usePermissions();
  const { settings, isLoading, loadError, isSaving, refresh, save } = useSystemCoachSettings();
  const [form, setForm] = useState<FormState | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) setForm(toForm(settings));
  }, [settings]);

  // Defence, not the gate: `App.tsx` wraps the route with this same string.
  if (!hasPermission('ai_config:read')) {
    return <Navigate to="/" replace />;
  }

  const canWrite = hasPermission('ai_config:write');
  if (isLoading && !settings) return <LoadingSpinner />;

  const disabled = !canWrite || isSaving;
  const patch = form && settings ? patchOf(form, settings) : null;
  const invalid = !!form && patch === null;
  const dirty = !!patch && Object.keys(patch).length > 0;

  const update = (next: Partial<FormState>) => setForm((prev) => (prev ? { ...prev, ...next } : prev));

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canWrite || !patch || !dirty) return;
    setSaveError(null);
    const result = await save(patch);
    if (result.ok) setSaved(true);
    else setSaveError(result.message);
  };

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: { xs: 2, md: 4 } }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {COACH_ADMIN_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Set what the AI Coach may do for everyone on this deployment: whether it runs, adult language, spoken
          messages and how often it may nudge.
          {!canWrite && ' (read-only)'}
        </Typography>

        {loadError && (
          <Alert
            severity="error"
            sx={{ mb: 3 }}
            action={
              <Button color="inherit" size="small" onClick={() => void refresh()}>
                Retry
              </Button>
            }
          >
            {loadError}
          </Alert>
        )}

        {!canWrite && !loadError && (
          <Alert severity="info" sx={{ mb: 3 }} data-testid="coach-admin-read-only-notice">
            You can read these settings but not change them. Saving needs <code>ai_config:write</code>.
          </Alert>
        )}

        {form && settings && (
          <Box component="form" onSubmit={(event) => void handleSubmit(event)} noValidate>
            <Stack spacing={3}>
              <Paper component="section" aria-labelledby="coach-admin-policy-title" sx={{ p: { xs: 2, sm: 3 } }}>
                <Typography id="coach-admin-policy-title" variant="h6" component="h2" gutterBottom>
                  Policy
                </Typography>
                <Stack spacing={2}>
                  <Box>
                    <FormControlLabel
                      control={
                        <Switch checked={form.enabled} disabled={disabled} onChange={(e) => update({ enabled: e.target.checked })} />
                      }
                      label="Coach enabled"
                    />
                    <FormHelperText>Switches the coach on or off for everyone. AI must also be on.</FormHelperText>
                  </Box>
                  <Box>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={form.allowProfanePersonas}
                          disabled={disabled}
                          onChange={(e) => update({ allowProfanePersonas: e.target.checked })}
                        />
                      }
                      label="Allow adult language"
                    />
                    <FormHelperText>
                      Lets adults who opt in unlock Sarge at Unhinged, which swears. Turning it off silences
                      profanity from the next message; users&apos; own settings are kept.
                    </FormHelperText>
                  </Box>
                  <Box>
                    <FormControlLabel
                      control={
                        <Switch checked={form.allowAudio} disabled={disabled} onChange={(e) => update({ allowAudio: e.target.checked })} />
                      }
                      label="Allow spoken messages"
                    />
                    <FormHelperText>Lets users hear their coach. Speech uses the Coach voice model and costs per message.</FormHelperText>
                  </Box>
                </Stack>
              </Paper>

              <Paper component="section" aria-labelledby="coach-admin-limits-title" sx={{ p: { xs: 2, sm: 3 } }}>
                <Typography id="coach-admin-limits-title" variant="h6" component="h2" gutterBottom>
                  Limits
                </Typography>
                <Stack spacing={2.5} sx={{ maxWidth: 420 }}>
                  <TextField
                    select
                    size="small"
                    id="coach-admin-ceiling"
                    label="Nudges per user per day, at most"
                    value={form.maxNudgesPerDayCeiling}
                    disabled={disabled}
                    onChange={(e) => update({ maxNudgesPerDayCeiling: Number(e.target.value) })}
                    helperText="A user who chose more gets this many."
                  >
                    {Array.from(
                      { length: SYSTEM_COACH_NUMBER_BOUNDS.maxNudgesPerDayCeiling.max },
                      (_, index) => index + 1,
                    ).map((count) => (
                      <MenuItem key={count} value={count}>
                        {count}
                      </MenuItem>
                    ))}
                  </TextField>
                  {NUMBER_FIELDS.map(({ field, label, help }) => {
                    const { min, max } = SYSTEM_COACH_NUMBER_BOUNDS[field];
                    const error = parseBounded(form[field], field) === null;
                    return (
                      <TextField
                        key={field}
                        size="small"
                        id={`coach-admin-${field}`}
                        label={label}
                        value={form[field]}
                        disabled={disabled}
                        error={error}
                        onChange={(e) => update({ [field]: e.target.value } as Partial<FormState>)}
                        helperText={error ? `Enter a whole number from ${min} to ${max}.` : help}
                        slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                      />
                    );
                  })}
                </Stack>
              </Paper>

              <Paper component="section" aria-labelledby="coach-admin-models-title" sx={{ p: { xs: 2, sm: 3 } }}>
                <Typography id="coach-admin-models-title" variant="h6" component="h2" gutterBottom>
                  Models
                </Typography>
                <Typography variant="body2">
                  The models for coach decisions, chat and voice are chosen on{' '}
                  <Link component={RouterLink} to={AI_ASSIGNMENTS_PATH}>
                    AI Model Assignments
                  </Link>{' '}
                  (Coach section).
                </Typography>
              </Paper>

              {saveError && (
                <Alert severity="error" role="alert" onClose={() => setSaveError(null)}>
                  <AlertTitle>Could not save</AlertTitle>
                  {saveError}
                </Alert>
              )}

              <Box
                sx={{
                  display: 'flex',
                  flexDirection: { xs: 'column', sm: 'row' },
                  alignItems: { xs: 'stretch', sm: 'center' },
                  gap: 2,
                }}
              >
                <Button type="submit" variant="contained" disabled={!canWrite || !dirty || invalid || isSaving}>
                  {isSaving ? 'Saving…' : 'Save changes'}
                </Button>
                <Typography variant="body2" color="text.secondary">
                  Takes effect for every user from the next message.
                </Typography>
              </Box>
            </Stack>
          </Box>
        )}

        <CoachEngagementPanel />

        <Snackbar open={saved} autoHideDuration={3000} onClose={() => setSaved(false)} message="Coach settings saved" />
      </Box>
    </Container>
  );
}
