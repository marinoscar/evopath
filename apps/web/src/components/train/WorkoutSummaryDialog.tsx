/**
 * After Finish (E4.3): duration, exercises, sets and volume in the display
 * unit, as the API totalled them, and (E4.4) the personal records of the
 * workout: the best set per PR type per exercise (`summary.prs`).
 *
 * `children` go under the records: the page puts the E6.2 "Save this gym
 * for future use?" prompt there when the workout was at a temporary gym.
 */
import type { ReactNode } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '@mui/material';
import { EmojiEvents as TrophyIcon } from '@mui/icons-material';
import type { Workout, WorkoutPrSummary } from '../../services/workouts';
import type { WeightUnit } from '../../utils/units';
import { formatDuration, formatVolume } from '../../utils/workoutFormat';
import { PR_LABEL, orderedPrs, prPreviousText, prValueText } from './PrChips';

/**
 * `summary.prs` grouped by exercise: "Weight PR 75.0 lb (set 2), previous
 * best 70.0 lb". "First time logged" lines are listed after the records.
 * Nothing renders without any.
 */
export function PrSummaryList({
  prs,
  unit,
  headingId,
  headingComponent = 'h3',
}: {
  prs: readonly WorkoutPrSummary[] | undefined;
  unit: WeightUnit;
  headingId: string;
  headingComponent?: 'h2' | 'h3';
}) {
  const all = prs ?? [];
  if (all.length === 0) return null;
  const groups: Array<{ id: string; name: string; prs: WorkoutPrSummary[] }> = [];
  for (const pr of all) {
    const group = groups.find((g) => g.id === pr.workoutExerciseId);
    if (group) group.prs.push(pr);
    else groups.push({ id: pr.workoutExerciseId, name: pr.exerciseName, prs: [pr] });
  }
  const records = groups
    .map((g) => ({ ...g, prs: orderedPrs(g.prs.filter((p) => p.type !== 'first_time')) }))
    .filter((g) => g.prs.length > 0);
  const firsts = groups.filter((g) => g.prs.some((p) => p.type === 'first_time'));
  return (
    <Box component="section" aria-labelledby={headingId} data-testid="pr-summary">
      <Typography id={headingId} variant="subtitle2" component={headingComponent} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
        <TrophyIcon fontSize="small" color="success" aria-hidden />
        Personal records
      </Typography>
      {records.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          No new records this time.
        </Typography>
      )}
      {records.map((g) => (
        <Box key={g.id} sx={{ mb: 1 }}>
          <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
            {g.name}
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {g.prs.map((pr) => (
              <Typography component="li" variant="body2" key={pr.type}>
                {PR_LABEL[pr.type]} {prValueText(pr, unit)} (set {pr.setNumber}). {prPreviousText(pr, unit)}.
              </Typography>
            ))}
          </Box>
        </Box>
      ))}
      {firsts.length > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {PR_LABEL.first_time}: {firsts.map((g) => g.name).join(', ')}
        </Typography>
      )}
    </Box>
  );
}

export function SummaryStats({ workout, unit }: { workout: Workout; unit: WeightUnit }) {
  const { summary } = workout;
  const stats: Array<[string, string]> = [
    ['Duration', summary.durationSeconds !== null ? formatDuration(summary.durationSeconds) : '—'],
    ['Exercises', String(summary.exerciseCount)],
    ['Sets', String(summary.setCount)],
    ['Volume', formatVolume(summary.volumeKg, unit)],
  ];
  return (
    <Box
      component="dl"
      sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 2, m: 0 }}
    >
      {stats.map(([label, value]) => (
        <Box key={label}>
          <Typography component="dt" variant="caption" color="text.secondary">
            {label}
          </Typography>
          <Typography component="dd" variant="h6" sx={{ m: 0 }}>
            {value}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

export interface WorkoutSummaryDialogProps {
  open: boolean;
  workout: Workout | null;
  unit: WeightUnit;
  onClose: () => void;
  children?: ReactNode;
}

export function WorkoutSummaryDialog({ open, workout, unit, onClose, children }: WorkoutSummaryDialogProps) {
  return (
    <Dialog open={open && workout !== null} onClose={onClose} fullWidth maxWidth="xs" aria-labelledby="workout-summary-title">
      <DialogTitle id="workout-summary-title">Workout finished</DialogTitle>
      <DialogContent>
        {workout && (
          <>
            <Typography sx={{ mb: 2, overflowWrap: 'anywhere' }}>{workout.name}</Typography>
            <SummaryStats workout={workout} unit={unit} />
            <Box sx={{ mt: 2 }}>
              <PrSummaryList prs={workout.summary.prs} unit={unit} headingId="workout-summary-prs-heading" headingComponent="h3" />
            </Box>
            {children && <Box sx={{ mt: 2 }}>{children}</Box>}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={onClose}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}
