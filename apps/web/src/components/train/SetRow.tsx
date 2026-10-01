/**
 * One set (E4.3): the fields its exercise's `trackingMode` needs, a large
 * check button, and the evaluator's one-tap inputs (effort chips, discomfort
 * flag) on the row itself; everything else is in {@link SetMoreMenu}.
 *
 * Typed text is a DRAFT until saved: an edit is sent 400 ms after the last
 * keystroke or at once on blur, converted to kilograms / metres / seconds.
 * Text equal to what the stored value already shows is never sent, so a
 * weight is never re-converted (31.751 kg shows as 31.75 kg and stays
 * 31.751). A failed save keeps the draft on screen and offers Retry.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  CheckCircleOutlined as CheckCircleOutlineIcon,
  MoreVert as MoreVertIcon,
  ReportProblem as ReportProblemIcon,
  ReportProblemOutlined as ReportProblemOutlinedIcon,
} from '@mui/icons-material';
import type { SetInput, SetLogView } from '../../services/workouts';
import type { TrackingMode } from '../../services/exercises';
import { useIsMounted } from '../../hooks/useIsMounted';
import type { WeightUnit } from '../../utils/units';
import {
  EFFORT_LABEL,
  EFFORT_RIR,
  EFFORTS,
  distanceInputText,
  distanceUnitFor,
  effortOf,
  formatClock,
  parseClock,
  parseDistance,
  parseReps,
  parseWeight,
  weightInputText,
  type Effort,
} from '../../utils/workoutFormat';
import { SetMoreMenu } from './SetMoreMenu';
import { PR_LABEL, PrChips, orderedPrs, visuallyHidden } from './PrChips';

/** How long a row waits after the last keystroke before saving. */
export const SET_AUTOSAVE_DELAY_MS = 400;

export type SetField = 'weight' | 'reps' | 'duration' | 'distance';

/** The fields a tracking mode shows, in entry order. */
export function fieldsFor(mode: TrackingMode, showAddedWeight: boolean): SetField[] {
  switch (mode) {
    case 'weight_reps':
      return ['weight', 'reps'];
    case 'bodyweight_reps':
      return showAddedWeight ? ['reps', 'weight'] : ['reps'];
    case 'time':
      return ['duration'];
    case 'distance_time':
      return ['distance', 'duration'];
    default:
      return ['weight', 'reps'];
  }
}

export interface SetRowProps {
  set: SetLogView;
  trackingMode: TrackingMode;
  unit: WeightUnit;
  canWrite: boolean;
  /**
   * The plan's per-set target (#263): an empty duration or distance field of
   * an uncompleted set starts with it, as a draft saved like typed text
   * (on completion, blur or an edit). Ignored for completed sets.
   */
  target?: { durationSeconds: number | null; distanceMeters: number | null } | null;
  /** Focus the first field once mounted (a row just added). */
  autoFocus?: boolean;
  onAutoFocused?: () => void;
  onSave: (setId: string, input: SetInput) => Promise<SetLogView>;
  /** After the set was saved as completed. */
  onCompleted?: (set: SetLogView) => void;
  onDelete: (setId: string) => void;
}

type RowStatus = 'idle' | 'saving' | 'error';

/**
 * The text a polite live region reads when a set EARNS a record: once, when
 * its PRs go from none to some while the row is on screen. PRs already there
 * when the row mounts (a reload) are shown but not announced.
 */
function usePrAnnouncement(setNumber: number, prs: SetLogView['prs']): string {
  const key = orderedPrs(prs ?? [])
    .map((pr) => pr.type)
    .join(',');
  const previous = useRef(key);
  const [text, setText] = useState('');
  useEffect(() => {
    const before = previous.current;
    previous.current = key;
    if (key === before) return;
    if (key === '') {
      setText('');
      return;
    }
    if (before !== '') return;
    const labels = key.split(',').map((type) => PR_LABEL[type as keyof typeof PR_LABEL]);
    setText(`Set ${setNumber}: ${labels.join(', ')}`);
  }, [key, setNumber]);
  return text;
}

export function SetRow({
  set,
  trackingMode,
  unit,
  canWrite,
  target = null,
  autoFocus = false,
  onAutoFocused,
  onSave,
  onCompleted,
  onDelete,
}: SetRowProps) {
  const n = set.setNumber;
  const distanceUnit = distanceUnitFor(unit);
  const [drafts, setDrafts] = useState<Partial<Record<SetField, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<SetField, string>>>({});
  const [status, setStatus] = useState<RowStatus>('idle');
  const [failedPatch, setFailedPatch] = useState<SetInput | null>(null);
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const [addedWeight, setAddedWeight] = useState(set.weightKg !== null);
  const isMounted = useIsMounted();
  const prs = set.prs ?? [];
  const announcement = usePrAnnouncement(n, prs);

  const showAddedWeight = trackingMode === 'bodyweight_reps' && (addedWeight || set.weightKg !== null);
  const fields = fieldsFor(trackingMode, showAddedWeight);

  const setRef = useRef(set);
  setRef.current = set;
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputs = useRef<Partial<Record<SetField, HTMLInputElement | null>>>({});

  const format = useCallback(
    (field: SetField, s: SetLogView): string => {
      switch (field) {
        case 'weight':
          return weightInputText(s.weightKg, unit);
        case 'reps':
          return s.reps === null ? '' : String(s.reps);
        case 'duration':
          return formatClock(s.durationSeconds);
        case 'distance':
          return distanceInputText(s.distanceMeters, distanceUnit);
      }
    },
    [unit, distanceUnit],
  );

  const parseInto = useCallback(
    (field: SetField, text: string, patch: SetInput): string | null => {
      switch (field) {
        case 'weight': {
          const r = parseWeight(text, unit);
          if (!r.ok) return r.message;
          patch.weightKg = r.kg;
          return null;
        }
        case 'reps': {
          const r = parseReps(text);
          if (!r.ok) return r.message;
          patch.reps = r.value;
          return null;
        }
        case 'duration': {
          const r = parseClock(text);
          if (!r.ok) return r.message;
          patch.durationSeconds = r.value;
          return null;
        }
        case 'distance': {
          const r = parseDistance(text, distanceUnit);
          if (!r.ok) return r.message;
          patch.distanceMeters = r.value;
          return null;
        }
      }
    },
    [unit, distanceUnit],
  );

  const save = useCallback(
    async (patch: SetInput, sent: Partial<Record<SetField, string>>): Promise<SetLogView | null> => {
      setStatus('saving');
      try {
        const saved = await onSave(setRef.current.id, patch);
        if (isMounted()) {
          setDrafts((prev) => {
            const next = { ...prev };
            for (const key of Object.keys(sent) as SetField[]) {
              if (next[key] === sent[key]) delete next[key];
            }
            return next;
          });
          setStatus('idle');
          setFailedPatch(null);
        }
        return saved;
      } catch {
        if (isMounted()) {
          setStatus('error');
          setFailedPatch(patch);
        }
        return null;
      }
    },
    [onSave, isMounted],
  );

  /**
   * Save the drafts (plus `extra`). Resolves with the saved set, `undefined`
   * when there was nothing to send, or `null` when invalid or failed.
   */
  const flush = useCallback(
    async (extra?: SetInput): Promise<SetLogView | null | undefined> => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      const current = draftsRef.current;
      const patch: SetInput = {};
      const sent: Partial<Record<SetField, string>> = {};
      const nextErrors: Partial<Record<SetField, string>> = {};
      const unchanged: SetField[] = [];
      for (const key of Object.keys(current) as SetField[]) {
        const text = current[key] ?? '';
        if (text.trim() === format(key, setRef.current)) {
          unchanged.push(key);
          continue;
        }
        const message = parseInto(key, text, patch);
        if (message) nextErrors[key] = message;
        else sent[key] = text;
      }
      if (unchanged.length > 0) {
        setDrafts((prev) => {
          const next = { ...prev };
          for (const key of unchanged) if (next[key] === current[key]) delete next[key];
          return next;
        });
      }
      setErrors(nextErrors);
      if (Object.keys(nextErrors).length > 0 && extra?.completed) return null;
      const body = { ...patch, ...(extra ?? {}) };
      if (Object.keys(body).length === 0) return undefined;
      return save(body, sent);
    },
    [format, parseInto, save],
  );

  // A row that goes away (navigated from) still sends what was typed.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        void flushRef.current();
      }
    },
    [],
  );

  // #263: pre-fill an empty time or distance field with the plan's target, once
  // per field (a draft the user clears stays cleared).
  const prefilled = useRef<Partial<Record<SetField, boolean>>>({});
  const targetDuration = target?.durationSeconds ?? null;
  const targetDistance = target?.distanceMeters ?? null;
  useEffect(() => {
    if (!canWrite || set.completed) return;
    const next: Partial<Record<SetField, string>> = {};
    if (fields.includes('duration') && targetDuration !== null && set.durationSeconds === null && !prefilled.current.duration) {
      next.duration = formatClock(targetDuration);
    }
    if (fields.includes('distance') && targetDistance !== null && set.distanceMeters === null && !prefilled.current.distance) {
      next.distance = distanceInputText(targetDistance, distanceUnit);
    }
    const keys = Object.keys(next) as SetField[];
    if (keys.length === 0) return;
    for (const key of keys) prefilled.current[key] = true;
    setDrafts((prev) => {
      const merged = { ...prev };
      for (const key of keys) if (merged[key] === undefined) merged[key] = next[key];
      draftsRef.current = merged;
      return merged;
    });
    // `fields` is derived from the tracking mode; the targets and stored values decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canWrite, set.completed, set.durationSeconds, set.distanceMeters, targetDuration, targetDistance, distanceUnit]);

  useEffect(() => {
    if (!autoFocus) return;
    const first = inputs.current[fields[0]];
    if (first) {
      first.focus();
      first.select();
    }
    onAutoFocused?.();
    // Once, when asked.
  }, [autoFocus]);

  const onChangeField = (field: SetField, text: string) => {
    setDrafts((prev) => ({ ...prev, [field]: text }));
    draftsRef.current = { ...draftsRef.current, [field]: text };
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void flush();
    }, SET_AUTOSAVE_DELAY_MS);
  };

  const toggleComplete = async () => {
    const completing = !setRef.current.completed;
    const saved = await flush({ completed: completing });
    if (saved && completing) onCompleted?.(saved);
  };

  const onKeyDownField = (field: SetField) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const index = fields.indexOf(field);
    const next = fields[index + 1];
    if (next) {
      inputs.current[next]?.focus();
    } else if (!setRef.current.completed && canWrite) {
      void toggleComplete();
    } else {
      void flush();
    }
  };

  const patchNow = (patch: SetInput) => {
    void flush(patch);
  };

  const effort = effortOf(set);
  const onEffort = (_: unknown, value: Effort | null) => {
    if (value === null) patchNow({ rir: null, rpe: null });
    else if (value !== effort) patchNow({ rir: EFFORT_RIR[value] });
  };

  const fieldLabel = (field: SetField): { aria: string; suffix: string; mode: 'decimal' | 'numeric' } => {
    switch (field) {
      case 'weight':
        return {
          aria: trackingMode === 'bodyweight_reps' ? `Set ${n} added weight in ${unit}` : `Set ${n} weight in ${unit}`,
          suffix: trackingMode === 'bodyweight_reps' ? `+${unit}` : unit,
          mode: 'decimal',
        };
      case 'reps':
        return { aria: `Set ${n} reps`, suffix: 'reps', mode: 'numeric' };
      case 'duration':
        return { aria: `Set ${n} time (minutes:seconds)`, suffix: 'm:s', mode: 'numeric' };
      case 'distance':
        return { aria: `Set ${n} distance in ${distanceUnit}`, suffix: distanceUnit, mode: 'decimal' };
    }
  };

  const errorText = Object.values(errors).filter(Boolean).join(' ');

  return (
    <Box
      role="group"
      aria-label={`Set ${n}`}
      data-testid={`set-row-${n}`}
      sx={{
        py: 1,
        borderTop: 1,
        borderColor: 'divider',
        bgcolor: set.completed ? 'action.selected' : undefined,
        px: 0.5,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box
          sx={{ width: 28, flexShrink: 0, textAlign: 'center', fontWeight: 600, color: 'text.secondary' }}
          title={set.isWarmup ? 'Warm-up set' : undefined}
        >
          {set.isWarmup ? 'W' : n}
        </Box>
        {fields.map((field) => {
          const meta = fieldLabel(field);
          const value = drafts[field] ?? format(field, set);
          return (
            <TextField
              key={field}
              size="small"
              value={value}
              disabled={!canWrite}
              error={Boolean(errors[field])}
              onChange={(e) => onChangeField(field, e.target.value)}
              onBlur={() => void flush()}
              onFocus={(e) => e.target.select()}
              onKeyDown={onKeyDownField(field)}
              inputRef={(el: HTMLInputElement | null) => {
                inputs.current[field] = el;
              }}
              sx={{ flex: 1, minWidth: 0, '& .MuiInputBase-root': { minHeight: 44 } }}
              slotProps={{
                htmlInput: {
                  'aria-label': meta.aria,
                  inputMode: meta.mode,
                  enterKeyHint: 'next',
                  autoComplete: 'off',
                  'aria-invalid': Boolean(errors[field]) || undefined,
                },
                input: {
                  endAdornment: (
                    <InputAdornment position="end" sx={{ ml: 0.25 }}>
                      <Typography variant="caption" color="text.secondary">
                        {meta.suffix}
                      </Typography>
                    </InputAdornment>
                  ),
                },
              }}
            />
          );
        })}
        <IconButton
          aria-label={`Complete set ${n}`}
          aria-pressed={set.completed}
          onClick={() => void toggleComplete()}
          disabled={!canWrite}
          color={set.completed ? 'success' : 'default'}
          sx={{ width: 48, height: 48, flexShrink: 0 }}
        >
          {set.completed ? <CheckCircleIcon fontSize="large" /> : <CheckCircleOutlineIcon fontSize="large" />}
        </IconButton>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5, pl: { xs: 0, sm: 4.5 } }}>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={effort}
          onChange={onEffort}
          disabled={!canWrite}
          aria-label={`Effort for set ${n}`}
        >
          {EFFORTS.map((e) => (
            <ToggleButton key={e} value={e} sx={{ minHeight: 44, minWidth: 52, px: 1, textTransform: 'none' }}>
              {EFFORT_LABEL[e]}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Box sx={{ flexGrow: 1 }} />
        {status === 'saving' && <CircularProgress size={16} aria-label={`Saving set ${n}`} />}
        <IconButton
          aria-label={`Flag discomfort on set ${n}`}
          aria-pressed={set.painFlag}
          disabled={!canWrite}
          color={set.painFlag ? 'warning' : 'default'}
          onClick={() => patchNow({ painFlag: !set.painFlag })}
          sx={{ width: 44, height: 44 }}
        >
          {set.painFlag ? <ReportProblemIcon /> : <ReportProblemOutlinedIcon />}
        </IconButton>
        <IconButton
          aria-label={`More for set ${n}`}
          aria-haspopup="dialog"
          onClick={(e) => setMoreAnchor(e.currentTarget)}
          sx={{ width: 44, height: 44 }}
        >
          <MoreVertIcon />
        </IconButton>
      </Box>

      {prs.length > 0 && (
        <Box sx={{ mt: 0.5, pl: { xs: 0, sm: 4.5 } }}>
          <PrChips prs={prs} unit={unit} />
        </Box>
      )}
      <Box role="status" aria-live="polite" sx={visuallyHidden}>
        {announcement}
      </Box>

      {set.painFlag && (
        <Typography
          variant="body2"
          color="warning.main"
          sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5, overflowWrap: 'anywhere' }}
        >
          <ReportProblemIcon fontSize="small" aria-hidden />
          Discomfort flagged{set.painNote ? `: ${set.painNote}` : ''}
        </Typography>
      )}
      {set.notes && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
          {set.notes}
        </Typography>
      )}
      {errorText && (
        <Typography variant="caption" color="error" role="alert" sx={{ display: 'block', mt: 0.5 }}>
          {errorText}
        </Typography>
      )}
      {status === 'error' && (
        <Box role="alert" sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
          <Typography variant="body2" color="error">
            Set {n} not saved.
          </Typography>
          <Button size="small" onClick={() => void flush(failedPatch ?? undefined)}>
            Retry
          </Button>
        </Box>
      )}

      <SetMoreMenu
        anchorEl={moreAnchor}
        open={moreAnchor !== null}
        onClose={() => setMoreAnchor(null)}
        set={set}
        trackingMode={trackingMode}
        canWrite={canWrite}
        showAddedWeight={showAddedWeight}
        onToggleAddedWeight={(show) => {
          setAddedWeight(show);
          if (!show && set.weightKg !== null) patchNow({ weightKg: null });
        }}
        onPatch={patchNow}
        onDelete={() => {
          setMoreAnchor(null);
          onDelete(set.id);
        }}
      />
    </Box>
  );
}
