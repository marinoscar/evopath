/**
 * Admin → AI → AI Model Assignments (`/admin/settings/ai/assignments`), #173.
 *
 * Every AI model choice in this app is an administrator's: an organization
 * default, and a model per feature (the photo features and the training
 * agents). Users never pick one. Backed by `GET`/`PUT
 * /api/admin/ai/assignments`; the API decides which models are eligible for
 * each feature and refuses an ineligible save with per-field errors.
 *
 * A REGISTRY CARD of its own (`ADMIN_SECTIONS`, AI group), nested under the AI
 * route like AI Models and feature-gated on AI. `ai_config:read` reaches the
 * page; without `ai_config:write` every control stays visible and DISABLED.
 *
 * The form is one full replace: Save sends the default and every feature,
 * with `If-Match: version`. A 409 keeps the edits on screen and offers a
 * reload; a 400 `AI_ASSIGNMENT_INVALID` puts each refusal on its own row.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Container,
  Divider,
  Link,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { Link as RouterLink, Navigate } from 'react-router-dom';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { aiCapabilityLabel } from '../../components/ai/aiCapabilities';
import { usePermissions } from '../../hooks/usePermissions';
import { useAiAssignments } from '../../hooks/useAiAssignments';
import type {
  AiAssignmentFeatureRow,
  AiAssignmentFieldError,
  AiAssignments,
  AiAssignmentsView,
  AiAssignmentWarning,
  AiEligibleModel,
  AiFeatureId,
  AiModelRef,
} from '../../services/aiAssignments';
import type { TaskReasoningEffort } from '../../types';

/** Mirrors the `AI Model Assignments` card in `config/adminSections.tsx`, word for word. */
const PAGE_TITLE = 'AI Model Assignments';
const PAGE_DESCRIPTION =
  'Choose the AI model the organization uses by default and for each feature. Users do not choose models.';

export const AI_MODELS_PATH = '/admin/settings/ai/models';

const NONE = '';
const SEP = '\u0000';

const keyOf = (ref: AiModelRef) => `${ref.provider}${SEP}${ref.modelId}`;
function refOf(key: string): AiModelRef | null {
  if (key === NONE) return null;
  const [provider, modelId] = key.split(SEP);
  return { provider, modelId };
}

const EFFORT_ORDER: readonly TaskReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

interface FeatureForm {
  model: string;
  /** `''` = the feature default. */
  effort: string;
}

interface FormState {
  default: string;
  features: Partial<Record<AiFeatureId, FeatureForm>>;
}

function toForm(view: AiAssignmentsView): FormState {
  const features: FormState['features'] = {};
  for (const row of view.features) {
    const stored = view.assignments.features[row.featureId] ?? row.assignment ?? null;
    features[row.featureId] = {
      model: stored ? keyOf(stored) : NONE,
      effort: stored?.reasoningEffort ?? '',
    };
  }
  return { default: view.assignments.default ? keyOf(view.assignments.default) : NONE, features };
}

function toInput(form: FormState, view: AiAssignmentsView): AiAssignments {
  const features: AiAssignments['features'] = {};
  for (const row of view.features) {
    const entry = form.features[row.featureId];
    const ref = entry ? refOf(entry.model) : null;
    if (!ref) {
      features[row.featureId] = null;
      continue;
    }
    features[row.featureId] =
      row.defaultReasoningEffort !== null
        ? { ...ref, reasoningEffort: entry?.effort ? (entry.effort as TaskReasoningEffort) : null }
        : ref;
  }
  return { default: refOf(form.default), features };
}

function modelLabel(model: AiEligibleModel): string {
  return `${model.displayName || model.modelId} (${model.provider})`;
}

/** What a feature needs, as a one-line hint. */
function needsHint(row: AiAssignmentFeatureRow): string {
  const parts = row.needs.map((need) => aiCapabilityLabel(need).toLowerCase());
  for (const modality of row.inputModalities) parts.push(`${modality} input`);
  let hint = `Needs ${parts.join(', ')}`;
  if (row.providers && row.providers.length > 0) hint += `; ${row.providers.join(' or ')} models only`;
  if (row.requiresWebSearch) hint += '; also needs web search switched on under AI → Hosted tools';
  return `${hint}.`;
}

/** The select's options: the eligible models, plus a stored choice that is no longer eligible. */
function optionsFor(eligible: AiEligibleModel[], storedKey: string) {
  const options = eligible.map((model) => ({ key: keyOf(model), label: modelLabel(model) }));
  if (storedKey !== NONE && !options.some((option) => option.key === storedKey)) {
    const ref = refOf(storedKey);
    if (ref) options.push({ key: storedKey, label: `${ref.modelId} (${ref.provider}) — no longer eligible` });
  }
  return options;
}

function WarningAlert({ warning }: { warning: AiAssignmentWarning }) {
  return (
    <Alert severity="warning">
      {warning.message}
      {warning.missing && warning.missing.length > 0 && ` Missing: ${warning.missing.join(', ')}.`}
    </Alert>
  );
}

function FieldErrorAlert({ error }: { error: AiAssignmentFieldError }) {
  return (
    <Alert severity="error" role="alert">
      {error.message}
      {error.missing && error.missing.length > 0 && ` Missing: ${error.missing.join(', ')}.`}
    </Alert>
  );
}

function NoEligibleModels({ what }: { what: string }) {
  return (
    <Alert severity="info">
      No enabled model can serve {what} yet. Models may exist in the catalog without being enabled:{' '}
      <Link component={RouterLink} to={AI_MODELS_PATH}>
        review and enable models on AI Models
      </Link>
      .
    </Alert>
  );
}

interface FeatureRowProps {
  row: AiAssignmentFeatureRow;
  value: FeatureForm;
  onChange: (next: FeatureForm) => void;
  error: AiAssignmentFieldError | undefined;
  disabled: boolean;
}

function FeatureRow({ row, value, onChange, error, disabled }: FeatureRowProps) {
  const selectId = `assignment-${row.featureId}`;
  const hintId = `${selectId}-hint`;
  const options = optionsFor(row.eligibleModels, value.model);
  const selectedModel = row.eligibleModels.find((model) => keyOf(model) === value.model) ?? null;
  const efforts = EFFORT_ORDER.filter((effort) => selectedModel?.reasoningEfforts.includes(effort));
  const takesEffort = row.defaultReasoningEffort !== null;
  const effortHelp =
    value.model === NONE
      ? 'Assign a model to choose its reasoning effort.'
      : efforts.length === 0
        ? 'This model has no adjustable reasoning.'
        : undefined;

  return (
    <Box component="section" aria-labelledby={`${selectId}-title`} data-testid={`assignment-row-${row.featureId}`} sx={{ py: 2 }}>
      <Typography id={`${selectId}-title`} variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
        {row.label}
      </Typography>
      <Typography id={hintId} variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {needsHint(row)}
      </Typography>
      <Stack spacing={1.5}>
        {row.eligibleModels.length === 0 && <NoEligibleModels what="this feature" />}
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          <TextField
            select
            fullWidth
            size="small"
            id={selectId}
            label="Model"
            value={value.model}
            disabled={disabled}
            error={!!error}
            onChange={(event) => {
              const model = event.target.value;
              const next = row.eligibleModels.find((entry) => keyOf(entry) === model);
              // Keep the effort only when the new model offers it.
              const keep = value.effort && next?.reasoningEfforts.includes(value.effort) ? value.effort : '';
              onChange({ model, effort: keep });
            }}
            slotProps={{ htmlInput: { 'aria-describedby': hintId } }}
          >
            <MenuItem value={NONE}>
              <em>Not assigned — use organization default</em>
            </MenuItem>
            {options.map((option) => (
              <MenuItem key={option.key} value={option.key}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
          {takesEffort && (
            <TextField
              select
              fullWidth
              size="small"
              id={`${selectId}-effort`}
              label="Reasoning effort"
              value={value.effort && efforts.includes(value.effort as TaskReasoningEffort) ? value.effort : ''}
              disabled={disabled || efforts.length === 0}
              helperText={effortHelp}
              onChange={(event) => onChange({ ...value, effort: event.target.value })}
              sx={{ maxWidth: { md: 280 } }}
            >
              <MenuItem value="">Feature default ({row.defaultReasoningEffort})</MenuItem>
              {efforts.map((effort) => (
                <MenuItem key={effort} value={effort}>
                  {effort}
                </MenuItem>
              ))}
            </TextField>
          )}
        </Stack>
        {row.warning && <WarningAlert warning={row.warning} />}
        {error && <FieldErrorAlert error={error} />}
      </Stack>
    </Box>
  );
}

interface FeatureSectionProps {
  title: string;
  description: string;
  rows: AiAssignmentFeatureRow[];
  form: FormState;
  setFeature: (id: AiFeatureId, next: FeatureForm) => void;
  errors: Map<string, AiAssignmentFieldError>;
  disabled: boolean;
}

function FeatureSection({ title, description, rows, form, setFeature, errors, disabled }: FeatureSectionProps) {
  if (rows.length === 0) return null;
  const id = `assignments-${title.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <Paper component="section" aria-labelledby={id} sx={{ p: { xs: 2, sm: 3 } }}>
      <Typography id={id} variant="h6" component="h2">
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {description}
      </Typography>
      {rows.map((row, index) => (
        <Box key={row.featureId}>
          {index > 0 && <Divider />}
          <FeatureRow
            row={row}
            value={form.features[row.featureId] ?? { model: NONE, effort: '' }}
            onChange={(next) => setFeature(row.featureId, next)}
            error={errors.get(`features.${row.featureId}`)}
            disabled={disabled}
          />
        </Box>
      ))}
    </Paper>
  );
}

export default function AiAssignmentsPage() {
  const { hasPermission } = usePermissions();
  const { view, isLoading, loadError, isSaving, refresh, save } = useAiAssignments();
  const [form, setForm] = useState<FormState | null>(null);
  const [fieldErrors, setFieldErrors] = useState<AiAssignmentFieldError[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);

  // Rebuild the form from every new baseline (load, save, reload).
  useEffect(() => {
    if (view) setForm(toForm(view));
  }, [view]);

  const errors = useMemo(() => new Map(fieldErrors.map((error) => [error.field, error])), [fieldErrors]);

  // Defence, not the gate — `App.tsx` wraps the route in `RequirePermission`
  // with this same string. After every hook, so the hook order never changes.
  if (!hasPermission('ai_config:read')) {
    return <Navigate to="/" replace />;
  }

  const canWrite = hasPermission('ai_config:write');

  if (isLoading && !view) return <LoadingSpinner />;

  const isDirty = !!form && !!view && JSON.stringify(form) !== JSON.stringify(toForm(view));
  const disabled = !canWrite || isSaving;

  const setFeature = (id: AiFeatureId, next: FeatureForm) =>
    setForm((prev) => (prev ? { ...prev, features: { ...prev.features, [id]: next } } : prev));

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || !view || !canWrite) return;
    setSaveError(null);
    setFieldErrors([]);
    setConflict(false);
    const result = await save(toInput(form, view));
    if (result.ok) {
      setSaved(true);
    } else if ('conflict' in result) {
      setConflict(true);
    } else if ('fieldErrors' in result) {
      setFieldErrors(result.fieldErrors);
      setSaveError('Some assignments were refused, so nothing was saved. Fix the rows marked below.');
    } else {
      setSaveError(result.message);
    }
  };

  const reload = async () => {
    setConflict(false);
    setFieldErrors([]);
    setSaveError(null);
    await refresh();
  };

  const photoRows = view?.features.filter((row) => row.group === 'photo') ?? [];
  const trainingRows = view?.features.filter((row) => row.group === 'training') ?? [];
  const defaultError = errors.get('default');
  const defaultOptions = view && form ? optionsFor(view.default.eligibleModels, form.default) : [];

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: { xs: 2, md: 4 } }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {PAGE_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          {PAGE_DESCRIPTION}
          {!canWrite && ' (read-only)'}
        </Typography>

        {view?.updatedBy && view.updatedAt && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Last updated by {view.updatedBy.email} on {new Date(view.updatedAt).toLocaleString()}
          </Typography>
        )}

        {loadError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {loadError}
          </Alert>
        )}

        {!canWrite && !loadError && (
          <Alert severity="info" sx={{ mb: 3 }} data-testid="ai-assignments-read-only-notice">
            You can read these assignments but not change them. Saving needs <code>ai_config:write</code>.
          </Alert>
        )}

        {form && view && (
          <Box component="form" onSubmit={handleSubmit} noValidate>
            <Stack spacing={3}>
              <Paper component="section" aria-labelledby="assignments-default-title" sx={{ p: { xs: 2, sm: 3 } }}>
                <Typography id="assignments-default-title" variant="h6" component="h2">
                  Organization default
                </Typography>
                <Typography id="assignments-default-hint" variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Used by every feature below that has no model of its own, when this model can serve it. A
                  feature it cannot serve falls back to an automatic pick.
                </Typography>
                <Stack spacing={1.5}>
                  {view.default.eligibleModels.length === 0 && <NoEligibleModels what="as the default" />}
                  <TextField
                    select
                    fullWidth
                    size="small"
                    id="assignment-default"
                    label="Default model"
                    value={form.default}
                    disabled={disabled}
                    error={!!defaultError}
                    onChange={(event) => setForm({ ...form, default: event.target.value })}
                    slotProps={{ htmlInput: { 'aria-describedby': 'assignments-default-hint' } }}
                  >
                    <MenuItem value={NONE}>
                      <em>No default</em>
                    </MenuItem>
                    {defaultOptions.map((option) => (
                      <MenuItem key={option.key} value={option.key}>
                        {option.label}
                      </MenuItem>
                    ))}
                  </TextField>
                  {view.default.warning && <WarningAlert warning={view.default.warning} />}
                  {defaultError && <FieldErrorAlert error={defaultError} />}
                </Stack>
              </Paper>

              <FeatureSection
                title="Photo features"
                description="Reading photos: scanning gym equipment, prefilling a workout and reading a body metric."
                rows={photoRows}
                form={form}
                setFeature={setFeature}
                errors={errors}
                disabled={disabled}
              />

              <FeatureSection
                title="Training agents"
                description="The agents that research, write, review and evaluate training plans."
                rows={trainingRows}
                form={form}
                setFeature={setFeature}
                errors={errors}
                disabled={disabled}
              />

              {conflict && (
                <Alert
                  severity="warning"
                  action={
                    <Button color="inherit" size="small" onClick={() => void reload()}>
                      Reload
                    </Button>
                  }
                >
                  <AlertTitle>Someone else changed these assignments</AlertTitle>
                  Your changes were not saved. Reload to see the current assignments (your unsaved edits will be
                  replaced), then make them again.
                </Alert>
              )}

              {saveError && (
                <Alert severity="error" onClose={() => setSaveError(null)}>
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
                <Button type="submit" variant="contained" disabled={!canWrite || !isDirty || isSaving}>
                  {isSaving ? 'Saving…' : 'Save changes'}
                </Button>
                <Typography variant="body2" color="text.secondary">
                  Takes effect for every user straight away.
                </Typography>
              </Box>
            </Stack>
          </Box>
        )}

        <Snackbar
          open={saved}
          autoHideDuration={3000}
          onClose={() => setSaved(false)}
          message="AI model assignments saved"
        />
      </Box>
    </Container>
  );
}
