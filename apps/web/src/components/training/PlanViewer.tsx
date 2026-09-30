/**
 * The plan's body, read-only: the week selector, the block's name, focus and
 * rationale, and the week's workouts in weekday order with their exercises.
 * One week renders at a time, so a 24-week plan stays light.
 */
import { Box, Card, CardContent, Chip, Stack, Typography } from '@mui/material';
import type { PlanTreeView, PlanWorkoutView } from '../../services/programs';
import type { WeightUnit } from '../../utils/units';
import { weekdayName } from '../../utils/planDiff';
import { EvidenceChip } from './EvidenceChip';
import { ExerciseRow } from './ExerciseRow';
import { WeekSelector, type WeekOption } from './WeekSelector';
import { refsInText, type PlanEvidence } from './planEvidence';

export function weekOptions(tree: { blocks: Array<{ name: string; weeks: Array<{ weekNumber: number; isDeload?: boolean }> }> }): WeekOption[] {
  return tree.blocks
    .flatMap((block) => block.weeks.map((week) => ({ weekNumber: week.weekNumber, isDeload: week.isDeload, blockName: block.name })))
    .sort((a, b) => a.weekNumber - b.weekNumber);
}

/** Weekday order; unscheduled workouts last, then by position. */
export function byWeekday<T extends { weekday?: number | null; position: number }>(workouts: T[]): T[] {
  return [...workouts].sort((a, b) => (a.weekday ?? 8) - (b.weekday ?? 8) || a.position - b.position);
}

export interface PlanViewerProps {
  tree: PlanTreeView;
  weekNumber: number;
  onWeekChange: (weekNumber: number) => void;
  unit: WeightUnit;
  evidence: PlanEvidence;
  availability: Map<string, boolean>;
  gymName: string | null;
}

function Refs({ refs, evidence }: { refs: string[]; evidence: PlanEvidence }) {
  return (
    <>
      {refs.map((ref) => (
        <EvidenceChip key={ref} refId={ref} evidence={evidence} />
      ))}
    </>
  );
}

function WorkoutCard({ workout, ...rest }: { workout: PlanWorkoutView } & Omit<PlanViewerProps, 'tree' | 'weekNumber' | 'onWeekChange'>) {
  const titleId = `workout-${workout.id}`;
  return (
    <Card variant="outlined" component="section" aria-labelledby={titleId} data-testid="plan-workout">
      <CardContent>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
          <Typography id={titleId} variant="h6" component="h3" sx={{ overflowWrap: 'anywhere' }}>
            {workout.name}
          </Typography>
          <Typography color="text.secondary">
            {workout.weekday ? weekdayName(workout.weekday) : 'Unscheduled'}
            {workout.estimatedMinutes ? ` · about ${workout.estimatedMinutes} min` : ''}
          </Typography>
        </Stack>
        {workout.rationale && (
          <Typography component="div" variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {workout.rationale} <Refs refs={refsInText(workout.rationale, rest.evidence)} evidence={rest.evidence} />
          </Typography>
        )}
        {workout.exercises.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            No exercises yet.
          </Typography>
        ) : (
          <Box component="ul" sx={{ p: 0, m: 0, mt: 1 }} aria-label={`${workout.name} exercises`}>
            {[...workout.exercises]
              .sort((a, b) => a.position - b.position)
              .map((exercise) => (
                <ExerciseRow
                  key={exercise.id}
                  exercise={exercise}
                  name={exercise.exercise?.name ?? 'Unknown exercise'}
                  unit={rest.unit}
                  evidence={rest.evidence}
                  available={rest.availability.get(exercise.exerciseId)}
                  gymName={rest.gymName}
                />
              ))}
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

export function PlanViewer({ tree, weekNumber, onWeekChange, ...rest }: PlanViewerProps) {
  const weeks = weekOptions(tree);
  const block = tree.blocks.find((b) => b.weeks.some((w) => w.weekNumber === weekNumber));
  const week = block?.weeks.find((w) => w.weekNumber === weekNumber);
  const blockRefs = refsInText(block?.rationale, rest.evidence);

  if (weeks.length === 0) return <Typography color="text.secondary">This plan has no weeks yet.</Typography>;

  return (
    <Stack spacing={2}>
      <WeekSelector weeks={weeks} value={weekNumber} onChange={onWeekChange} />
      {block && (
        <Box>
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
            <Typography variant="subtitle1" component="p" sx={{ fontWeight: 600 }}>
              {block.name}
            </Typography>
            {block.focus && <Typography color="text.secondary">{block.focus}</Typography>}
            {week?.isDeload && <Chip size="small" color="info" label="Deload week" />}
          </Stack>
          {block.rationale && (
            <Typography component="div" variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {block.rationale} <Refs refs={blockRefs} evidence={rest.evidence} />
            </Typography>
          )}
        </Box>
      )}
      {week && week.workouts.length === 0 && <Typography color="text.secondary">No workouts this week.</Typography>}
      {week &&
        byWeekday(week.workouts).map((workout) => <WorkoutCard key={workout.id} workout={workout} {...rest} />)}
    </Stack>
  );
}

export default PlanViewer;
