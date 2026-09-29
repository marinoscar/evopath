/**
 * "Last time" for one exercise card (E4.4): what the user did for this
 * exercise in their most recent earlier completed workout, as the API chose
 * it (`GET /exercises/:id/history`), in the display unit, with **Copy sets**
 * to pre-fill this workout's rows with those values, not marked done.
 *
 *   Last time (Mon, Sep 22, Home Gym): 70 lb × 10, 10, 9
 *
 * Nothing here computes a record or picks the workout; the API decides.
 */
import { useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { ContentCopy as ContentCopyIcon } from '@mui/icons-material';
import type { ExerciseHistory, LastTimeSet, TrackingMode } from '../../services/exercises';
import {
  MAX_SETS_PER_EXERCISE,
  workoutErrorMessage,
  type SetInput,
  type SetLogView,
  type Workout,
  type WorkoutExerciseView,
} from '../../services/workouts';
import { useExerciseHistory } from '../../hooks/useExerciseHistory';
import { formatWeight, type WeightUnit } from '../../utils/units';
import { distanceInputText, distanceUnitFor, formatClock, setHasValues } from '../../utils/workoutFormat';
import { formatDayLabel } from '../../utils/localDates';
import { visuallyHidden } from './PrChips';

export const FIRST_TIME_TEXT = 'First time logging this exercise';

function tracksWeight(mode: TrackingMode): boolean {
  return mode === 'weight_reps' || mode === 'bodyweight_reps';
}

/** One set's value without the weight: `'10'`, `'1:30'`, `'5 km in 25:00'`. */
function setValueText(set: LastTimeSet, mode: TrackingMode, unit: WeightUnit): string {
  switch (mode) {
    case 'time':
      return formatClock(set.durationSeconds) || '—';
    case 'distance_time': {
      const du = distanceUnitFor(unit);
      const distance = set.distanceMeters !== null ? `${distanceInputText(set.distanceMeters, du)} ${du}` : '';
      const time = set.durationSeconds !== null ? formatClock(set.durationSeconds) : '';
      if (distance && time) return `${distance} in ${time}`;
      return distance || time || '—';
    }
    default:
      return set.reps !== null ? String(set.reps) : '—';
  }
}

/**
 * The working sets of "last time" as one line in `unit`. Consecutive sets at
 * the same weight share it: `70 lb × 10, 10, 9`; a new weight is written
 * again: `60 kg × 10, 62.5 kg × 8`. Bodyweight sets without added weight
 * read `10, 8 reps`; with added weight `+10 kg × 8`. Warm-ups are counted,
 * not listed.
 */
export function formatLastTimeSets(sets: readonly LastTimeSet[], mode: TrackingMode, unit: WeightUnit): string {
  const working = sets.filter((s) => !s.isWarmup);
  const warmups = sets.length - working.length;
  const parts: string[] = [];

  if (tracksWeight(mode)) {
    const groups: Array<{ weight: string; reps: string[] }> = [];
    for (const set of working) {
      const weight =
        set.weightKg === null ? '' : `${mode === 'bodyweight_reps' ? '+' : ''}${formatWeight(set.weightKg, unit)}`;
      const last = groups[groups.length - 1];
      if (last && last.weight === weight) last.reps.push(setValueText(set, mode, unit));
      else groups.push({ weight, reps: [setValueText(set, mode, unit)] });
    }
    for (const g of groups) {
      parts.push(g.weight ? `${g.weight} × ${g.reps.join(', ')}` : `${g.reps.join(', ')} reps`);
    }
  } else {
    for (const set of working) parts.push(setValueText(set, mode, unit));
  }

  let text = parts.join(', ');
  if (warmups > 0) {
    const w = `${warmups} warm-up${warmups === 1 ? '' : 's'}`;
    text = text ? `${text} (+${w})` : w;
  }
  return text || 'no sets';
}

/** A last-time set as a new row's body: its values, not marked done. */
export function lastTimeSetInput(set: LastTimeSet): SetInput {
  return {
    weightKg: set.weightKg,
    reps: set.reps,
    durationSeconds: set.durationSeconds,
    distanceMeters: set.distanceMeters,
    isWarmup: set.isWarmup,
  };
}

export interface CopyPlan {
  /** Existing empty, not-done rows filled in place. */
  updates: Array<{ setId: string; input: SetInput }>;
  /** Rows added after the existing ones. */
  adds: SetInput[];
}

/**
 * What **Copy sets** does, row by row: last time's set `i` goes into this
 * workout's row `i` when that row is empty and not done (the row a new
 * exercise starts with, or the one added after completing a set); a row the
 * user already typed into or completed is kept. Sets beyond the existing
 * rows are added, up to the per-exercise limit. Nothing is marked done.
 */
export function planCopy(current: readonly SetLogView[], lastSets: readonly LastTimeSet[]): CopyPlan {
  const plan: CopyPlan = { updates: [], adds: [] };
  lastSets.forEach((last, i) => {
    const row = current[i];
    if (row) {
      if (!row.completed && !setHasValues(row)) plan.updates.push({ setId: row.id, input: lastTimeSetInput(last) });
    } else if (current.length + plan.adds.length < MAX_SETS_PER_EXERCISE) {
      plan.adds.push({ ...lastTimeSetInput(last), completed: false });
    }
  });
  return plan;
}

export interface LastTimeLineProps {
  history: ExerciseHistory | null;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  trackingMode: TrackingMode;
  unit: WeightUnit;
  /** The day of the workout being logged, so last time reads "Today" / "Yesterday". */
  today?: string | null;
  exerciseName: string;
  /** Present when Copy sets is offered. */
  onCopy?: () => void;
  copying?: boolean;
}

/** The presentational line; {@link ExerciseLastTime} feeds it. */
export function LastTimeLine({
  history,
  isLoading = false,
  error = null,
  onRetry,
  trackingMode,
  unit,
  today,
  exerciseName,
  onCopy,
  copying = false,
}: LastTimeLineProps) {
  if (!history) {
    if (error) {
      return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Last time could not be loaded.
          </Typography>
          {onRetry && (
            <Button size="small" onClick={onRetry} aria-label={`Retry loading last time for ${exerciseName}`}>
              Retry
            </Button>
          )}
        </Box>
      );
    }
    if (isLoading) {
      return (
        <Typography variant="body2" color="text.secondary" aria-busy="true">
          Loading last time…
        </Typography>
      );
    }
    return null;
  }

  const { lastTime, records } = history;
  const best = tracksWeight(trackingMode) ? records.bestE1rmKg : null;

  if (!lastTime) {
    return (
      <Typography variant="body2" color="text.secondary" data-testid="last-time">
        {FIRST_TIME_TEXT}
      </Typography>
    );
  }

  const where = [formatDayLabel(lastTime.date, today ?? null), lastTime.gym?.name].filter(Boolean).join(', ');
  const setsText = formatLastTimeSets(lastTime.sets, trackingMode, unit);

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 1 }}>
      <Typography
        variant="body2"
        color="text.secondary"
        data-testid="last-time"
        sx={{ overflowWrap: 'anywhere', minWidth: 0, flex: '1 1 12rem' }}
      >
        <Box component="span" sx={{ fontWeight: 600 }}>
          Last time ({where}):
        </Box>{' '}
        {setsText}
        {best && (
          <Box component="span" sx={{ display: 'block' }}>
            Best est. 1RM {formatWeight(best.value, unit)}
          </Box>
        )}
      </Typography>
      {onCopy && (
        <Button
          size="small"
          startIcon={<ContentCopyIcon aria-hidden />}
          onClick={onCopy}
          disabled={copying}
          aria-label={`Copy last time's sets into ${exerciseName}`}
          sx={{ minHeight: 44 }}
        >
          Copy sets
        </Button>
      )}
    </Box>
  );
}

export interface ExerciseLastTimeProps {
  entry: WorkoutExerciseView;
  workout: Pick<Workout, 'id' | 'gymId' | 'date' | 'status'>;
  unit: WeightUnit;
  /** `workouts:read`: false requests nothing. */
  enabled?: boolean;
  canWrite: boolean;
  onAddSet: (weId: string, input?: SetInput) => Promise<SetLogView>;
  onSaveSet: (setId: string, input: SetInput) => Promise<SetLogView>;
}

/**
 * The card's "Last time" slot: reads the history once per exercise per
 * workout (cached), and offers Copy sets while the workout is in progress and
 * there is a row to fill.
 */
export function ExerciseLastTime({
  entry,
  workout,
  unit,
  enabled = true,
  canWrite,
  onAddSet,
  onSaveSet,
}: ExerciseLastTimeProps) {
  const { history, isLoading, error, refresh } = useExerciseHistory(entry.exerciseId, {
    workoutId: workout.id,
    gymId: workout.gymId,
    contextKey: workout.date,
    enabled,
  });
  const [copying, setCopying] = useState(false);
  const [message, setMessage] = useState('');
  const [copyError, setCopyError] = useState<string | null>(null);

  const lastSets = history?.lastTime?.sets ?? [];
  const plan = planCopy(entry.sets, lastSets);
  const offerCopy =
    canWrite && workout.status === 'in_progress' && lastSets.length > 0 && plan.updates.length + plan.adds.length > 0;

  const copy = async () => {
    setCopying(true);
    setCopyError(null);
    setMessage('');
    let done = 0;
    try {
      for (const { setId, input } of plan.updates) {
        await onSaveSet(setId, input);
        done += 1;
      }
      for (const input of plan.adds) {
        await onAddSet(entry.id, input);
        done += 1;
      }
      setMessage(`Copied ${done} ${done === 1 ? 'set' : 'sets'} from last time. Not marked done.`);
    } catch (err) {
      setCopyError(workoutErrorMessage(err, 'Could not copy the sets'));
    } finally {
      setCopying(false);
    }
  };

  return (
    <>
      <LastTimeLine
        history={history}
        isLoading={isLoading}
        error={error}
        onRetry={() => void refresh()}
        trackingMode={entry.exercise.trackingMode}
        unit={unit}
        today={workout.date}
        exerciseName={entry.exercise.name}
        onCopy={offerCopy ? () => void copy() : undefined}
        copying={copying}
      />
      {copyError && (
        <Typography variant="body2" color="error" role="alert">
          {copyError}
        </Typography>
      )}
      <Box role="status" aria-live="polite" sx={visuallyHidden}>
        {message}
      </Box>
    </>
  );
}
