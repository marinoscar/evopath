/**
 * The Memory panel of Admin → AI → Coach (#325; docs/specs/user-memory.md).
 *
 * The deployment's user memory policy lives in the SYSTEM SETTINGS document
 * (`memory` namespace), not in the coach's own settings, so this panel reads
 * and writes `GET`/`PATCH /api/system-settings`. Those routes enforce
 * `system_settings:read` / `system_settings:write`
 * (`system-settings.controller.ts`), which is a different grant from the
 * page's `ai_config:read`: without read the panel explains why it is empty;
 * without write every control stays visible and DISABLED. The API refuses the
 * PATCH anyway.
 *
 * A section of the Coach page rather than a card of its own: memory is how the
 * coach personalises, configured next to the rest of the coach policy.
 */
import { useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  FormControlLabel,
  FormHelperText,
  Paper,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { ApiError } from '../../services/api';
import { SYSTEM_MEMORY_NUMBER_BOUNDS, type SystemMemorySettings, type SystemSettings } from '../../types';

type NumberField = keyof typeof SYSTEM_MEMORY_NUMBER_BOUNDS;

interface FormState {
  enabled: boolean;
  autoExtract: boolean;
  maxPerUser: string;
  extractDailyCapPerUser: string;
  purgeAfterDays: string;
}

const NUMBER_FIELDS: Array<{ field: NumberField; label: string; help: string }> = [
  {
    field: 'maxPerUser',
    label: 'Memories per user, at most',
    help: 'Adding one past this is refused until the user deletes some.',
  },
  {
    field: 'extractDailyCapPerUser',
    label: 'Learning runs per user per day',
    help: 'How often the coach may look through a user’s chats for new facts each day.',
  },
  {
    field: 'purgeAfterDays',
    label: 'Purge deleted memories after (days)',
    help: 'Deleted memories can be undone until then; after that they are erased.',
  },
];

function toForm(memory: SystemMemorySettings): FormState {
  return {
    enabled: memory.enabled,
    autoExtract: memory.autoExtract,
    maxPerUser: String(memory.maxPerUser),
    extractDailyCapPerUser: String(memory.extractDailyCapPerUser),
    purgeAfterDays: String(memory.purgeAfterDays),
  };
}

function parseBounded(value: string, field: NumberField): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  const { min, max } = SYSTEM_MEMORY_NUMBER_BOUNDS[field];
  return parsed >= min && parsed <= max ? parsed : null;
}

/** Only what changed, or `null` when a number is invalid. */
function patchOf(form: FormState, memory: SystemMemorySettings): Partial<SystemMemorySettings> | null {
  const patch: Partial<SystemMemorySettings> = {};
  if (form.enabled !== memory.enabled) patch.enabled = form.enabled;
  if (form.autoExtract !== memory.autoExtract) patch.autoExtract = form.autoExtract;
  for (const { field } of NUMBER_FIELDS) {
    const parsed = parseBounded(form[field], field);
    if (parsed === null) return null;
    if (parsed !== memory[field]) patch[field] = parsed;
  }
  return patch;
}

const TITLE_ID = 'coach-admin-memory-title';

export function MemoryAdminPanel() {
  const { hasPermission } = usePermissions();
  const canRead = hasPermission('system_settings:read');

  return (
    <Paper
      component="section"
      aria-labelledby={TITLE_ID}
      sx={{ p: { xs: 2, sm: 3 }, mt: 3 }}
      data-testid="coach-admin-memory-panel"
    >
      <Typography id={TITLE_ID} variant="h6" component="h2" gutterBottom>
        Memory
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        What the coach may remember about each user. Users see, edit and delete their memories under Settings →
        Memory, and can turn memory off for themselves.
      </Typography>
      {canRead ? (
        <MemoryAdminForm canWrite={hasPermission('system_settings:write')} />
      ) : (
        <Alert severity="info" data-testid="coach-admin-memory-no-access">
          The memory policy is part of the system settings. Viewing it needs <code>system_settings:read</code>.
        </Alert>
      )}
    </Paper>
  );
}

function MemoryAdminForm({ canWrite }: { canWrite: boolean }) {
  const { settings, isLoading, error, isSaving, updateSettings, refresh } = useSystemSettings();
  const memory = settings?.memory ?? null;
  const [form, setForm] = useState<FormState | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (memory) setForm(toForm(memory));
  }, [memory]);

  if (isLoading && !settings) {
    return (
      <Typography variant="body2" color="text.secondary" role="status">
        Loading memory settings…
      </Typography>
    );
  }

  if (error && !settings) {
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void refresh()}>
            Retry
          </Button>
        }
      >
        {error}
      </Alert>
    );
  }

  if (!memory || !form) {
    return <Alert severity="warning">This server does not report a memory policy yet.</Alert>;
  }

  const disabled = !canWrite || isSaving;
  const patch = patchOf(form, memory);
  const invalid = patch === null;
  const dirty = !!patch && Object.keys(patch).length > 0;
  const update = (next: Partial<FormState>) => setForm((prev) => (prev ? { ...prev, ...next } : prev));

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canWrite || !patch || !dirty) return;
    setSaveError(null);
    try {
      // PATCH merges `memory` field by field server-side; the hook's type is
      // the full document, so the partial namespace is widened here.
      await updateSettings({ memory: patch } as unknown as Partial<SystemSettings>);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof ApiError || err instanceof Error ? err.message : 'Failed to save settings');
    }
  };

  return (
    <Box component="form" onSubmit={(event) => void handleSubmit(event)} noValidate>
      <Stack spacing={2.5}>
        {!canWrite && (
          <Alert severity="info" data-testid="coach-admin-memory-read-only-notice">
            You can read the memory policy but not change it. Saving needs <code>system_settings:write</code>.
          </Alert>
        )}
        <Box>
          <FormControlLabel
            control={
              <Switch checked={form.enabled} disabled={disabled} onChange={(e) => update({ enabled: e.target.checked })} />
            }
            label="Memory enabled"
          />
          <FormHelperText>Lets the coach use and save memories for everyone. AI must also be on.</FormHelperText>
        </Box>
        <Box>
          <FormControlLabel
            control={
              <Switch
                checked={form.autoExtract}
                disabled={disabled}
                onChange={(e) => update({ autoExtract: e.target.checked })}
              />
            }
            label="Learn from conversations"
          />
          <FormHelperText>
            Lets the coach pick up facts from chats in the background, using the Memory extraction model. Each run
            costs per call.
          </FormHelperText>
        </Box>
        <Stack spacing={2.5} sx={{ maxWidth: 420 }}>
          {NUMBER_FIELDS.map(({ field, label, help }) => {
            const { min, max } = SYSTEM_MEMORY_NUMBER_BOUNDS[field];
            const fieldError = parseBounded(form[field], field) === null;
            return (
              <TextField
                key={field}
                size="small"
                id={`coach-admin-memory-${field}`}
                label={label}
                value={form[field]}
                disabled={disabled}
                error={fieldError}
                onChange={(e) => update({ [field]: e.target.value } as Partial<FormState>)}
                helperText={fieldError ? `Enter a whole number from ${min} to ${max}.` : help}
                slotProps={{ htmlInput: { inputMode: 'numeric' } }}
              />
            );
          })}
        </Stack>

        {saveError && (
          <Alert severity="error" role="alert" onClose={() => setSaveError(null)}>
            <AlertTitle>Could not save</AlertTitle>
            {saveError}
          </Alert>
        )}

        <Box>
          <Button type="submit" variant="contained" disabled={!canWrite || !dirty || invalid || isSaving}>
            {isSaving ? 'Saving…' : 'Save memory settings'}
          </Button>
        </Box>
      </Stack>
      <Snackbar open={saved} autoHideDuration={3000} onClose={() => setSaved(false)} message="Memory settings saved" />
    </Box>
  );
}
