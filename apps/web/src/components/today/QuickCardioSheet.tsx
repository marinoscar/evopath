/**
 * "Log a walk / run" (#264): one sheet that logs a finished walk, run or hike
 * as a workout, `POST /api/workouts/quick-cardio`. Pick the activity, give
 * the minutes and/or the distance (km or mi from the Health Profile), when
 * (now by default, at most 7 days back) and an optional note.
 *
 * A bottom sheet (Drawer anchored bottom) below `sm`, a dialog otherwise:
 * the dialog-presentation idiom of `useCompactDialog`, not one of the five
 * navigation breakpoint gates.
 *
 * The checks mirror the API's schema so the sheet can explain a problem
 * before the round trip ("Enter the minutes or the distance"); the API
 * decides, and its refusal is shown in place.
 */
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Drawer,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useCompactDialog } from '../gyms/useCompactDialog';
import { useWeightUnit } from '../../hooks/useWeightUnit';
import {
  logQuickCardio,
  QUICK_CARDIO_BOUNDS,
  quickCardioErrorMessage,
  type QuickCardioExercise,
  type QuickCardioInput,
  type QuickCardioResult,
} from '../../services/workouts';
import { isoToLocalInput, localInputToIso } from '../../services/broadcasts';
import { distanceUnitFor, METERS_PER_MILE, parseDistance, type DistanceUnit } from '../../utils/workoutFormat';

export const QUICK_CARDIO_TITLE = 'Log a walk / run';

export const QUICK_CARDIO_ACTIVITIES: ReadonlyArray<{ key: QuickCardioExercise; label: string }> = [
  { key: 'outdoor_walk', label: 'Walk' },
  { key: 'outdoor_run', label: 'Run' },
  { key: 'hike', label: 'Hike' },
];

export function activityLabel(key: QuickCardioExercise): string {
  return QUICK_CARDIO_ACTIVITIES.find((a) => a.key === key)?.label ?? 'Activity';
}

export interface QuickCardioDraft {
  exerciseKey: QuickCardioExercise;
  minutes: string;
  distance: string;
  /** A `datetime-local` value; '' (or untouched) means now. */
  when: string;
  whenTouched: boolean;
  note: string;
}

export type QuickCardioField = 'minutes' | 'distance' | 'when' | 'form';

export type QuickCardioCheck =
  | { ok: true; input: QuickCardioInput }
  | { ok: false; problems: Partial<Record<QuickCardioField, string>> };

function maxDistanceText(unit: DistanceUnit): string {
  const max = QUICK_CARDIO_BOUNDS.distanceMeters.max / (unit === 'mi' ? METERS_PER_MILE : 1000);
  return `${Math.floor(max * 100) / 100} ${unit}`;
}

/** The draft as the API's body, or why not. Mirrors the API's checks; the API decides. */
export function checkQuickCardio(draft: QuickCardioDraft, unit: DistanceUnit, now: Date = new Date()): QuickCardioCheck {
  const problems: Partial<Record<QuickCardioField, string>> = {};
  const input: QuickCardioInput = { exerciseKey: draft.exerciseKey };
  const { durationSeconds: D, distanceMeters: M } = QUICK_CARDIO_BOUNDS;

  const minutesText = draft.minutes.trim();
  if (minutesText !== '') {
    const value = Number(minutesText);
    const seconds = Math.round(value * 60);
    if (!Number.isFinite(value) || minutesText.includes(',')) problems.minutes = 'Enter a number of minutes.';
    else if (seconds < D.min || seconds > D.max) problems.minutes = `Minutes: ${D.min / 60} to ${D.max / 60}.`;
    else input.durationSeconds = seconds;
  }

  const parsed = parseDistance(draft.distance, unit);
  if (!parsed.ok) problems.distance = parsed.message;
  else if (parsed.value !== null) {
    // The API requires more than 0 m (a value that rounds to 0 m counts as 0).
    if (parsed.value <= M.min) problems.distance = 'Enter a distance greater than 0.';
    else if (parsed.value > M.max) problems.distance = `At most ${maxDistanceText(unit)}.`;
    else input.distanceMeters = parsed.value;
  }

  if (minutesText === '' && draft.distance.trim() === '') problems.form = 'Enter the minutes or the distance.';

  if (draft.whenTouched) {
    const iso = localInputToIso(draft.when);
    if (!iso) problems.when = 'Pick a date and time.';
    else {
      const at = new Date(iso).getTime();
      // A minute of slack: the field has minute precision.
      if (at > now.getTime() + 60_000) problems.when = 'That is in the future.';
      else if (at < now.getTime() - QUICK_CARDIO_BOUNDS.daysBack * 86_400_000) {
        problems.when = `At most ${QUICK_CARDIO_BOUNDS.daysBack} days back.`;
      } else input.performedAt = new Date(Math.min(at, now.getTime())).toISOString();
    }
  }

  const note = draft.note.trim();
  if (note) input.note = note.slice(0, QUICK_CARDIO_BOUNDS.noteMax);

  return Object.keys(problems).length > 0 ? { ok: false, problems } : { ok: true, input };
}

function freshDraft(): QuickCardioDraft {
  return { exerciseKey: 'outdoor_walk', minutes: '', distance: '', when: isoToLocalInput(new Date().toISOString()), whenTouched: false, note: '' };
}

export interface QuickCardioSheetProps {
  open: boolean;
  onClose: () => void;
  /** After the API created the workout; the sheet has closed itself. */
  onLogged: (result: QuickCardioResult, exerciseKey: QuickCardioExercise) => void;
}

export function QuickCardioSheet({ open, onClose, onLogged }: QuickCardioSheetProps) {
  const compact = useCompactDialog();
  const distanceUnit = distanceUnitFor(useWeightUnit());
  const titleId = useId();
  const [draft, setDraft] = useState<QuickCardioDraft>(freshDraft);
  const [showProblems, setShowProblems] = useState(false);
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(freshDraft());
      setShowProblems(false);
      setApiError(null);
      setBusy(false);
    }
  }, [open]);

  const check = useMemo(() => checkQuickCardio(draft, distanceUnit), [draft, distanceUnit]);
  const problems = !check.ok && showProblems ? check.problems : {};
  const limits = useMemo(() => {
    const now = new Date();
    return {
      min: isoToLocalInput(new Date(now.getTime() - QUICK_CARDIO_BOUNDS.daysBack * 86_400_000).toISOString()),
      max: isoToLocalInput(now.toISOString()),
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (next: Partial<QuickCardioDraft>) => {
    setDraft((d) => ({ ...d, ...next }));
    setApiError(null);
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    setShowProblems(true);
    const result = checkQuickCardio(draft, distanceUnit);
    if (!result.ok) return;
    setBusy(true);
    setApiError(null);
    try {
      const logged = await logQuickCardio(result.input);
      setBusy(false);
      onClose();
      onLogged(logged, draft.exerciseKey);
    } catch (err) {
      setBusy(false);
      setApiError(quickCardioErrorMessage(err, "Couldn't log it. Try again."));
    }
  };

  const close = busy ? undefined : onClose;

  const fields = (
    <Stack spacing={2.5}>
      {apiError && <Alert severity="error">{apiError}</Alert>}
      <Box>
        <Typography id={`${titleId}-activity`} variant="subtitle2" component="p" sx={{ mb: 1 }}>
          Activity
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }} role="radiogroup" aria-labelledby={`${titleId}-activity`}>
          {QUICK_CARDIO_ACTIVITIES.map((a) => {
            const selected = draft.exerciseKey === a.key;
            return (
              <Chip
                key={a.key}
                label={a.label}
                role="radio"
                aria-checked={selected}
                color={selected ? 'primary' : 'default'}
                variant={selected ? 'filled' : 'outlined'}
                onClick={() => patch({ exerciseKey: a.key })}
                sx={{ minHeight: 40, px: 1 }}
              />
            );
          })}
        </Stack>
      </Box>
      <Stack direction="row" spacing={1.5}>
        <TextField
          label="Minutes"
          value={draft.minutes}
          onChange={(e) => patch({ minutes: e.target.value })}
          error={!!problems.minutes || !!problems.form}
          helperText={problems.minutes}
          sx={{ flex: 1, minWidth: 0 }}
          slotProps={{
            input: { endAdornment: <InputAdornment position="end">min</InputAdornment> },
            htmlInput: { inputMode: 'decimal', autoComplete: 'off' },
          }}
        />
        <TextField
          label="Distance (optional)"
          value={draft.distance}
          onChange={(e) => patch({ distance: e.target.value })}
          error={!!problems.distance || !!problems.form}
          helperText={problems.distance}
          sx={{ flex: 1, minWidth: 0 }}
          slotProps={{
            input: { endAdornment: <InputAdornment position="end">{distanceUnit}</InputAdornment> },
            htmlInput: { inputMode: 'decimal', autoComplete: 'off', 'aria-label': `Distance in ${distanceUnit} (optional)` },
          }}
        />
      </Stack>
      {problems.form && (
        <Typography variant="body2" color="error" role="alert">
          {problems.form}
        </Typography>
      )}
      <TextField
        label="When"
        type="datetime-local"
        value={draft.when}
        onChange={(e) => patch({ when: e.target.value, whenTouched: true })}
        error={!!problems.when}
        helperText={problems.when ?? `Now, or up to ${QUICK_CARDIO_BOUNDS.daysBack} days back.`}
        fullWidth
        slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: limits.min, max: limits.max } }}
      />
      <TextField
        label="Note (optional)"
        value={draft.note}
        onChange={(e) => patch({ note: e.target.value })}
        multiline
        minRows={2}
        fullWidth
        slotProps={{ htmlInput: { maxLength: QUICK_CARDIO_BOUNDS.noteMax } }}
      />
    </Stack>
  );

  const actions = (
    <>
      <Button onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <Button type="submit" variant="contained" disabled={busy}>
        {busy ? 'Saving…' : 'Log it'}
      </Button>
    </>
  );

  if (compact) {
    return (
      <Drawer
        anchor="bottom"
        open={open}
        onClose={close}
        slotProps={{
          paper: {
            component: 'form',
            onSubmit: (e: FormEvent) => void submit(e),
            noValidate: true,
            role: 'dialog',
            'aria-modal': true,
            'aria-labelledby': titleId,
            sx: {
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              maxHeight: '90dvh',
              px: 2,
              pt: 1,
              pb: 'calc(16px + env(safe-area-inset-bottom))',
            },
          } as object,
        }}
      >
        <Box aria-hidden sx={{ width: 36, height: 4, borderRadius: 2, bgcolor: 'divider', mx: 'auto', mb: 1 }} />
        <Typography id={titleId} variant="h6" component="h2" sx={{ mb: 2 }}>
          {QUICK_CARDIO_TITLE}
        </Typography>
        <Box sx={{ overflowY: 'auto' }}>{fields}</Box>
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 2 }}>{actions}</Box>
      </Drawer>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      fullWidth
      maxWidth="xs"
      aria-labelledby={titleId}
      slotProps={{ paper: { component: 'form', onSubmit: (e: FormEvent) => void submit(e), noValidate: true } as object }}
    >
      <DialogTitle id={titleId}>{QUICK_CARDIO_TITLE}</DialogTitle>
      <DialogContent dividers>{fields}</DialogContent>
      <DialogActions>{actions}</DialogActions>
    </Dialog>
  );
}

export default QuickCardioSheet;
