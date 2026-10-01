/**
 * A planned time or distance exercise's progress in the logger (#263): the
 * plan's target ("Target: 5 km · 30 min") and what the completed working
 * sets add up to, with a bar. Completion is logged / target per metric (the
 * training signals' rule); with both targets the better of the two counts,
 * so 5 km in 25 minutes is done. Presentation only.
 */
import { Box, LinearProgress, Typography } from '@mui/material';
import type { PlannedTarget } from '../../hooks/usePlannedTargets';
import type { SetLogView } from '../../services/workouts';
import { formatCardioTarget, formatTargetDistance } from '../../utils/prescription';
import { distanceUnitFor, formatClock, type DistanceUnit } from '../../utils/workoutFormat';
import type { WeightUnit } from '../../utils/units';

export interface CardioProgress {
  /** Sum over completed working sets. */
  loggedSeconds: number;
  loggedMeters: number;
  /** The plan's target: the exercise's TOTAL for the session (the API's contract), never multiplied by sets. */
  targetSeconds: number | null;
  targetMeters: number | null;
  /** 0..100, whole percent; the better metric when both are set. */
  percent: number;
}

export function cardioProgress(target: PlannedTarget, sets: ReadonlyArray<Pick<SetLogView, 'completed' | 'isWarmup' | 'durationSeconds' | 'distanceMeters'>>): CardioProgress {
  const working = sets.filter((s) => s.completed && !s.isWarmup);
  const loggedSeconds = working.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0);
  const loggedMeters = working.reduce((sum, s) => sum + (s.distanceMeters ?? 0), 0);
  // The API's targets are totals for the session (`cardioCompletionRatio`):
  // logged over all working sets / target, whatever the planned set count.
  const targetSeconds = target.durationSeconds;
  const targetMeters = target.distanceMeters;
  const ratios = [
    targetSeconds ? loggedSeconds / targetSeconds : null,
    targetMeters ? loggedMeters / targetMeters : null,
  ].filter((r): r is number => r !== null);
  const best = ratios.length > 0 ? Math.max(...ratios) : 0;
  return { loggedSeconds, loggedMeters, targetSeconds, targetMeters, percent: Math.min(100, Math.round(best * 100)) };
}

function loggedText(p: CardioProgress, unit: DistanceUnit): string {
  const parts: string[] = [];
  if (p.targetMeters !== null) parts.push(formatTargetDistance(p.loggedMeters, unit));
  if (p.targetSeconds !== null) parts.push(formatClock(p.loggedSeconds));
  return parts.join(' · ');
}

export function PlannedTargetProgress({
  target,
  sets,
  unit,
  exerciseName,
}: {
  target: PlannedTarget;
  sets: SetLogView[];
  unit: WeightUnit;
  exerciseName: string;
}) {
  const distanceUnit = distanceUnitFor(unit);
  const progress = cardioProgress(target, sets);
  const targetText = formatCardioTarget(
    { targetDurationSeconds: progress.targetSeconds, targetDistanceMeters: progress.targetMeters },
    distanceUnit,
  );
  if (!targetText) return null;
  return (
    <Box data-testid="planned-target" sx={{ mt: 0.5 }}>
      <Typography variant="body2">
        Target: {targetText}
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <LinearProgress
          variant="determinate"
          value={progress.percent}
          aria-label={`${exerciseName} progress toward the target`}
          color={progress.percent >= 100 ? 'success' : 'primary'}
          sx={{ flex: 1, minWidth: 0, height: 6, borderRadius: 3 }}
        />
        <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
          {`${loggedText(progress, distanceUnit)} · ${progress.percent}%`}
        </Typography>
      </Box>
    </Box>
  );
}

export default PlannedTargetProgress;
