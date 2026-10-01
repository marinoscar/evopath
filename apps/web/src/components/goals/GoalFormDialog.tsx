/**
 * Create or edit an activity goal (#268).
 *
 * Create: pick one of the server's templates (it fills the form) or fill in a
 * custom goal. Edit: the same form over the stored goal; only the changed
 * fields are sent, with `If-Match: <version>` (the parent's `onSubmit`).
 *
 * The checks here mirror the API's rules (sessions are counted per week, a
 * custom goal needs a label, the target is a positive whole number); the API
 * decides. `409 GOAL_LIMIT_REACHED` and a stale `412` are shown in the dialog.
 */
import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { useCompactDialog } from '../gyms/useCompactDialog';
import {
  GOAL_ACTIVITY_KINDS,
  GOAL_CUSTOM_LABEL_MAX,
  GOAL_METRICS,
  GOAL_PERIODS,
  GOAL_TITLE_MAX,
  goalErrorMessage,
  isGoalOutdated,
  isGoalStale,
  type CreateGoalInput,
  type Goal,
  type GoalActivityKind,
  type GoalMetric,
  type GoalPeriod,
  type GoalTemplate,
  type UpdateGoalInput,
} from '../../services/goals';
import {
  ACTIVITY_KIND_LABELS,
  EMPTY_GOAL_DRAFT,
  METRIC_LABELS,
  PERIOD_LABELS,
  draftFromGoal,
  formatGoalTarget,
  targetToDraft,
  targetUnitLabel,
  validateGoalDraft,
  type DistanceUnit,
  type GoalDraft,
  type GoalDraftErrors,
} from '../../utils/goalFormat';

export interface GoalFormDialogProps {
  open: boolean;
  /** The goal being edited; absent to create one. */
  goal?: Goal | null;
  templates?: readonly GoalTemplate[];
  templatesLoading?: boolean;
  unit: DistanceUnit;
  onClose: () => void;
  /** Create or update; throw to show the error in the dialog. */
  onSubmit: (input: CreateGoalInput) => Promise<void>;
  /** A `412`: reload the goal (the dialog resets to the reloaded version). */
  onStale?: () => Promise<void> | void;
}

export function GoalFormDialog({
  open,
  goal = null,
  templates = [],
  templatesLoading = false,
  unit,
  onClose,
  onSubmit,
  onStale,
}: GoalFormDialogProps) {
  const fullScreen = useCompactDialog();
  const titleId = useId();
  const editing = goal !== null;
  const [draft, setDraft] = useState<GoalDraft>(EMPTY_GOAL_DRAFT);
  const [errors, setErrors] = useState<GoalDraftErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [templateKey, setTemplateKey] = useState<string | null>(null);

  // Reset on open, and to the latest version when a stale edit reloaded it.
  const goalKey = goal ? `${goal.id}:${goal.version}` : null;
  useEffect(() => {
    if (!open) return;
    setDraft(goal ? draftFromGoal(goal, unit) : EMPTY_GOAL_DRAFT);
    setErrors({});
    setTemplateKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on id:version
  }, [open, goalKey, unit]);

  useEffect(() => {
    if (open) setSubmitError(null);
  }, [open]);

  const set = <K extends keyof GoalDraft>(key: K, value: GoalDraft[K]) => {
    setDraft((prev) => {
      const next = { ...prev, [key]: value };
      // Sessions are counted per week (the API refuses a daily sessions goal).
      if (key === 'metric' && value === 'sessions') next.period = 'week';
      return next;
    });
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const applyTemplate = (template: GoalTemplate) => {
    setTemplateKey(template.key);
    setDraft({
      title: template.title,
      activityKind: template.activityKind,
      customLabel: '',
      metric: template.metric,
      target: targetToDraft(template.metric, template.target, unit),
      period: template.period,
    });
    setErrors({});
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = validateGoalDraft(draft, unit);
    setErrors(result.errors);
    if (!result.input) return;
    setSaving(true);
    setSubmitError(null);
    try {
      await onSubmit(result.input);
    } catch (err) {
      setSubmitError(goalErrorMessage(err, editing ? 'Could not save the goal.' : 'Could not create the goal.'));
      if (isGoalStale(err) || isGoalOutdated(err)) await onStale?.();
    } finally {
      setSaving(false);
    }
  };

  const sessions = draft.metric === 'sessions';

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby={titleId}
    >
      <Box component="form" noValidate onSubmit={submit} sx={{ display: 'contents' }}>
        <DialogTitle id={titleId}>{editing ? 'Edit goal' : 'New goal'}</DialogTitle>
        <DialogContent>
          {submitError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {submitError}
            </Alert>
          )}
          {!editing && (templatesLoading || templates.length > 0) && (
            <Box component="section" aria-labelledby={`${titleId}-ideas`} sx={{ mb: 2 }}>
              <Typography id={`${titleId}-ideas`} variant="subtitle2" component="h3">
                Start from an idea
              </Typography>
              {templatesLoading ? (
                <Typography variant="body2" color="text.secondary">
                  Loading ideas…
                </Typography>
              ) : (
                <List dense disablePadding>
                  {templates.map((template) => (
                    <ListItemButton
                      key={template.key}
                      selected={templateKey === template.key}
                      onClick={() => applyTemplate(template)}
                      aria-pressed={templateKey === template.key}
                      sx={{ borderRadius: 1, minHeight: 44 }}
                    >
                      <ListItemText
                        primary={template.title}
                        secondary={formatGoalTarget(template, unit)}
                        slotProps={{ primary: { sx: { overflowWrap: 'anywhere' } } }}
                      />
                    </ListItemButton>
                  ))}
                </List>
              )}
              <Typography variant="subtitle2" component="h3" sx={{ mt: 2 }}>
                Or make your own
              </Typography>
            </Box>
          )}
          <Box sx={{ display: 'grid', gap: 2, pt: editing ? 1 : 0 }}>
            <TextField
              label="Goal name"
              value={draft.title}
              onChange={(e) => set('title', e.target.value)}
              error={Boolean(errors.title)}
              helperText={errors.title}
              required
              fullWidth
              slotProps={{ htmlInput: { maxLength: GOAL_TITLE_MAX } }}
            />
            <TextField
              select
              label="Activity"
              value={draft.activityKind}
              onChange={(e) => set('activityKind', e.target.value as GoalActivityKind)}
              fullWidth
            >
              {GOAL_ACTIVITY_KINDS.map((kind) => (
                <MenuItem key={kind} value={kind}>
                  {ACTIVITY_KIND_LABELS[kind]}
                </MenuItem>
              ))}
            </TextField>
            {draft.activityKind === 'custom' && (
              <TextField
                label="Activity name"
                placeholder="e.g. Yoga"
                value={draft.customLabel}
                onChange={(e) => set('customLabel', e.target.value)}
                error={Boolean(errors.customLabel)}
                helperText={errors.customLabel}
                required
                fullWidth
                slotProps={{ htmlInput: { maxLength: GOAL_CUSTOM_LABEL_MAX } }}
              />
            )}
            <TextField
              select
              label="Measure"
              value={draft.metric}
              onChange={(e) => set('metric', e.target.value as GoalMetric)}
              fullWidth
            >
              {GOAL_METRICS.map((metric) => (
                <MenuItem key={metric} value={metric}>
                  {METRIC_LABELS[metric]}
                </MenuItem>
              ))}
            </TextField>
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
              <TextField
                label="Target"
                type="number"
                value={draft.target}
                onChange={(e) => set('target', e.target.value)}
                error={Boolean(errors.target)}
                helperText={errors.target}
                required
                fullWidth
                slotProps={{
                  htmlInput: {
                    min: draft.metric === 'distance_m' ? 0.1 : 1,
                    step: draft.metric === 'distance_m' ? 0.1 : 1,
                    inputMode: draft.metric === 'distance_m' ? 'decimal' : 'numeric',
                  },
                  input: {
                    endAdornment: (
                      <InputAdornment position="end">{targetUnitLabel(draft.metric, unit)}</InputAdornment>
                    ),
                  },
                }}
              />
              <TextField
                select
                label="How often"
                value={draft.period}
                onChange={(e) => set('period', e.target.value as GoalPeriod)}
                disabled={sessions}
                error={Boolean(errors.period)}
                helperText={errors.period ?? (sessions ? 'Sessions are counted per week.' : undefined)}
                fullWidth
              >
                {GOAL_PERIODS.map((period) => (
                  <MenuItem key={period} value={period}>
                    {PERIOD_LABELS[period]}
                  </MenuItem>
                ))}
              </TextField>
            </Box>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={saving}>
            {editing ? 'Save' : 'Create goal'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

/** The fields of `next` that differ from `goal` (an edit sends only these). */
export function goalPatch(goal: Goal, next: CreateGoalInput): UpdateGoalInput {
  const patch: UpdateGoalInput = {};
  if (next.title !== goal.title) patch.title = next.title;
  if (next.activityKind !== goal.activityKind) patch.activityKind = next.activityKind;
  const nextLabel = next.activityKind === 'custom' ? (next.customLabel ?? null) : null;
  if (nextLabel !== (goal.customLabel ?? null)) patch.customLabel = nextLabel;
  if (next.metric !== goal.metric) patch.metric = next.metric;
  if (next.target !== goal.target) patch.target = next.target;
  if (next.period !== goal.period) patch.period = next.period;
  return patch;
}

export default GoalFormDialog;
