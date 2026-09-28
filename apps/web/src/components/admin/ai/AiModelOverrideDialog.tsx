/**
 * Edit a model's capabilities — an administrator override (issue #429).
 *
 * `PATCH /admin/ai/models/:id { capabilities }` sets `capabilitySource:
 * 'admin_override'`, and a later catalogue refresh never touches an
 * overridden row (`docs/specs/ai-platform.md` §2.17). This is how an
 * `unclassified` model — one the provider's classifier did not recognise —
 * becomes enable-able, and how a wrong classification is corrected.
 *
 * Only the API's own vocabulary is offered (`AI_CAPABILITY_VALUES` and the
 * modality lists), so every save is schema-valid; a string the current row
 * carries that is not in that vocabulary is dropped rather than re-sent.
 *
 * The dialog also edits the model's LIMITS (#450) — an output-token cap and a
 * per-user requests-per-minute limit. They are not model fields: they live in
 * the AI configuration's `limits.perModel['<provider>:<modelId>']`, so the
 * page saves them with a `PUT /admin/ai/config` beside the capability PATCH.
 * This component only reports the entry as typed; blank means unlimited.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormHelperText,
  FormLabel,
  Grid,
  TextField,
} from '@mui/material';
import { AI_LIMIT_MAX } from '../../../services/ai';
import type { AiModel, AiModelCapabilities, AiModelLimits } from '../../../services/ai';
import {
  AI_CAPABILITY_GROUPS,
  AI_CAPABILITY_LABELS,
  AI_CAPABILITY_VALUES,
  AI_INPUT_MODALITY_VALUES,
  AI_OUTPUT_MODALITY_VALUES,
  AI_REASONING_EFFORT_VALUES,
} from '../../ai/aiCapabilities';

interface OverrideForm {
  capabilities: string[];
  inputModalities: string[];
  outputModalities: string[];
  reasoningEfforts: string[];
  contextWindow: string;
  maxOutputTokens: string;
  /** `limits.perModel` (#450) — strings so blank (unlimited) is representable. */
  limitMaxOutputTokens: string;
  limitRequestsPerMinutePerUser: string;
}

function only(values: readonly string[], allowed: readonly string[]): string[] {
  return values.filter((value) => allowed.includes(value));
}

/**
 * The form a model opens with. An unclassified model has `capabilities:
 * null` and starts empty; the row's own `contextWindow`/`maxOutputTokens`
 * (what discovery learned) seed the numbers when the capability set has none.
 */
function toForm(model: AiModel, limits: AiModelLimits | undefined): OverrideForm {
  const capabilities = model.capabilities;
  const contextWindow = capabilities?.contextWindow ?? model.contextWindow;
  const maxOutputTokens = capabilities?.maxOutputTokens ?? model.maxOutputTokens;
  return {
    capabilities: only(capabilities?.capabilities ?? [], AI_CAPABILITY_VALUES),
    inputModalities: only(capabilities?.inputModalities ?? [], AI_INPUT_MODALITY_VALUES),
    outputModalities: only(capabilities?.outputModalities ?? [], AI_OUTPUT_MODALITY_VALUES),
    reasoningEfforts: only(capabilities?.reasoningEfforts ?? [], AI_REASONING_EFFORT_VALUES),
    contextWindow: contextWindow ? String(contextWindow) : '',
    maxOutputTokens: maxOutputTokens ? String(maxOutputTokens) : '',
    limitMaxOutputTokens:
      limits?.maxOutputTokens !== undefined ? String(limits.maxOutputTokens) : '',
    limitRequestsPerMinutePerUser:
      limits?.requestsPerMinutePerUser !== undefined ? String(limits.requestsPerMinutePerUser) : '',
  };
}

function positiveIntError(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  return /^\d+$/.test(value) && Number(value) > 0 ? null : 'A whole number greater than zero.';
}

/** {@link positiveIntError}, plus the API's ceiling on every limit value. */
function limitError(raw: string): string | null {
  const error = positiveIntError(raw);
  if (error) return error;
  return Number(raw.trim()) > AI_LIMIT_MAX
    ? `At most ${AI_LIMIT_MAX.toLocaleString('en-US')}.`
    : null;
}

/** The typed limits as a `perModel` entry; blank fields are omitted (unlimited). */
function toLimits(form: OverrideForm): AiModelLimits {
  const maxOutputTokens = form.limitMaxOutputTokens.trim();
  const requestsPerMinutePerUser = form.limitRequestsPerMinutePerUser.trim();
  return {
    ...(maxOutputTokens ? { maxOutputTokens: Number(maxOutputTokens) } : {}),
    ...(requestsPerMinutePerUser
      ? { requestsPerMinutePerUser: Number(requestsPerMinutePerUser) }
      : {}),
  };
}

function toCapabilities(form: OverrideForm): AiModelCapabilities {
  const contextWindow = form.contextWindow.trim();
  const maxOutputTokens = form.maxOutputTokens.trim();
  return {
    capabilities: form.capabilities,
    inputModalities: form.inputModalities,
    outputModalities: form.outputModalities,
    ...(form.capabilities.includes('reasoning') && form.reasoningEfforts.length > 0
      ? { reasoningEfforts: form.reasoningEfforts }
      : {}),
    ...(contextWindow ? { contextWindow: Number(contextWindow) } : {}),
    ...(maxOutputTokens ? { maxOutputTokens: Number(maxOutputTokens) } : {}),
  };
}

function CheckboxGroup({
  label,
  options,
  selected,
  onChange,
  labelFor = (value) => value,
  disabled,
}: {
  label: string;
  options: readonly string[];
  selected: string[];
  onChange: (next: string[]) => void;
  labelFor?: (value: string) => string;
  disabled?: boolean;
}) {
  const toggle = (value: string, checked: boolean) =>
    onChange(checked ? [...selected, value] : selected.filter((entry) => entry !== value));

  return (
    <FormControl component="fieldset" disabled={disabled} sx={{ mb: 2, display: 'block' }}>
      <FormLabel component="legend">{label}</FormLabel>
      <FormGroup row>
        {options.map((value) => (
          <FormControlLabel
            key={value}
            control={
              <Checkbox
                checked={selected.includes(value)}
                onChange={(e) => toggle(value, e.target.checked)}
              />
            }
            label={labelFor(value)}
          />
        ))}
      </FormGroup>
    </FormControl>
  );
}

export interface AiModelOverrideDialogProps {
  /** `null` closes the dialog. */
  model: AiModel | null;
  isSaving: boolean;
  error: string | null;
  /** The model's current `limits.perModel` entry, if any — prefills the limit fields. */
  limits?: AiModelLimits;
  /**
   * `true` when the AI configuration (where limits live) is not loaded, so
   * the limit fields cannot be read or saved; they are shown disabled.
   */
  limitsUnavailable?: boolean;
  /** `limits` is the entry as typed; `{}` when both fields are blank. */
  onSave: (capabilities: AiModelCapabilities, limits: AiModelLimits) => void;
  onClose: () => void;
}

export function AiModelOverrideDialog({
  model,
  isSaving,
  error,
  limits,
  limitsUnavailable = false,
  onSave,
  onClose,
}: AiModelOverrideDialogProps) {
  const [form, setForm] = useState<OverrideForm | null>(null);

  // Seeded when a model is opened (or the configuration holding its limits
  // arrives) — not on every `limits` identity change, which would wipe what
  // the admin is typing.
  useEffect(() => {
    setForm(model ? toForm(model, limits) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, limitsUnavailable]);

  if (!model || !form) return null;

  const update = <K extends keyof OverrideForm>(key: K, value: OverrideForm[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const contextError = positiveIntError(form.contextWindow);
  const maxOutputError = positiveIntError(form.maxOutputTokens);
  const missing =
    form.capabilities.length === 0
      ? 'Choose at least one capability.'
      : form.inputModalities.length === 0 || form.outputModalities.length === 0
        ? 'Choose at least one input and one output modality.'
        : null;
  const limitMaxOutputError = limitError(form.limitMaxOutputTokens);
  const limitRpmError = limitError(form.limitRequestsPerMinutePerUser);
  const invalid =
    !!missing || !!contextError || !!maxOutputError || !!limitMaxOutputError || !!limitRpmError;

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Edit capabilities and limits — {model.modelId}</DialogTitle>
      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Alert severity="info" sx={{ mb: 2 }}>
          Saving marks this model as an admin override. Catalogue refreshes will not change it
          again.
        </Alert>

        {/* Grouped exactly as the table's chips are, so the dialog reads as
            the long form of what the row shows. */}
        {AI_CAPABILITY_GROUPS.map((group) => {
          const options = group.members.filter((member) =>
            (AI_CAPABILITY_VALUES as readonly string[]).includes(member),
          );
          if (options.length === 0) return null;
          return (
            <CheckboxGroup
              key={group.id}
              label={group.label}
              options={options}
              selected={form.capabilities.filter((value) => options.includes(value))}
              onChange={(next) =>
                update('capabilities', [
                  ...form.capabilities.filter((value) => !options.includes(value)),
                  ...next,
                ])
              }
              labelFor={(value) => AI_CAPABILITY_LABELS[value] ?? value}
            />
          );
        })}

        <CheckboxGroup
          label="Input modalities"
          options={AI_INPUT_MODALITY_VALUES}
          selected={form.inputModalities}
          onChange={(next) => update('inputModalities', next)}
        />
        <CheckboxGroup
          label="Output modalities"
          options={AI_OUTPUT_MODALITY_VALUES}
          selected={form.outputModalities}
          onChange={(next) => update('outputModalities', next)}
        />
        <CheckboxGroup
          label="Reasoning efforts"
          options={AI_REASONING_EFFORT_VALUES}
          selected={form.reasoningEfforts}
          onChange={(next) => update('reasoningEfforts', next)}
          disabled={!form.capabilities.includes('reasoning')}
        />

        <Grid container spacing={2}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              label="Context window (tokens)"
              value={form.contextWindow}
              onChange={(e) => update('contextWindow', e.target.value)}
              slotProps={{ htmlInput: { inputMode: 'numeric' } }}
              error={!!contextError}
              helperText={contextError ?? 'Optional.'}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              label="Maximum output tokens"
              value={form.maxOutputTokens}
              onChange={(e) => update('maxOutputTokens', e.target.value)}
              slotProps={{ htmlInput: { inputMode: 'numeric' } }}
              error={!!maxOutputError}
              helperText={maxOutputError ?? 'Optional.'}
            />
          </Grid>
        </Grid>

        {missing && (
          <Box sx={{ mt: 1 }}>
            <FormHelperText error>{missing}</FormHelperText>
          </Box>
        )}

        <FormControl
          component="fieldset"
          disabled={limitsUnavailable}
          sx={{ mt: 3, display: 'block' }}
          data-testid="ai-model-limits"
        >
          <FormLabel component="legend">Limits</FormLabel>
          <FormHelperText sx={{ mt: 0, mb: 2 }}>
            {limitsUnavailable
              ? 'The AI configuration could not be loaded, so this model’s limits cannot be changed here.'
              : 'Leave a field blank for no limit. These apply to every user of this model, on any key.'}
          </FormHelperText>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                label="Max output tokens per call"
                value={form.limitMaxOutputTokens}
                onChange={(e) => update('limitMaxOutputTokens', e.target.value)}
                disabled={limitsUnavailable}
                slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                error={!!limitMaxOutputError}
                helperText={
                  limitMaxOutputError ??
                  'Caps each answer. The lower of this and the deployment-wide cap applies.'
                }
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                label="Requests per minute per user"
                value={form.limitRequestsPerMinutePerUser}
                onChange={(e) => update('limitRequestsPerMinutePerUser', e.target.value)}
                disabled={limitsUnavailable}
                slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                error={!!limitRpmError}
                helperText={limitRpmError ?? 'How often each user may call this model.'}
              />
            </Grid>
          </Grid>
        </FormControl>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isSaving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={invalid || isSaving}
          onClick={() => onSave(toCapabilities(form), toLimits(form))}
        >
          {isSaving ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
