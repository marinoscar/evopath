/**
 * One planned exercise, read-only: `sets x reps @ RPE`, rest, the load line
 * (in the user's unit), the one-line rationale with evidence chips, and
 * "Not available at {gym}" when the plan's gym lacks what it needs.
 */
import { Box, Chip, Stack, Typography } from '@mui/material';
import type { LoadGuidance, PlanExercise } from '../../services/programs';
import { formatTargetLoad } from '../../services/programs';
import type { WeightUnit } from '../../utils/units';
import { prescription } from '../../utils/planDiff';
import { EvidenceChip } from './EvidenceChip';
import { resolvableRefs, type PlanEvidence } from './planEvidence';

export function loadLine(guidance: LoadGuidance | undefined, kg: number | null | undefined, unit: WeightUnit): string {
  if (guidance === 'from_history') return 'From your last session';
  if (guidance === 'fixed') return formatTargetLoad(kg, unit) ?? 'Choose a starting load';
  return kg !== null && kg !== undefined ? (formatTargetLoad(kg, unit) as string) : 'Choose a starting load';
}

export function formatRest(seconds: number): string {
  if (seconds < 60) return `${seconds}s rest`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s rest` : `${m} min rest`;
}

export interface ExerciseRowProps {
  exercise: PlanExercise & { exercise?: { name: string } | null; exerciseUnavailable?: boolean };
  name: string;
  unit: WeightUnit;
  evidence: PlanEvidence;
  /** `false` when the plan's gym cannot do it; null or undefined when unknown. */
  available?: boolean | null;
  gymName?: string | null;
}

export function ExerciseRow({ exercise, name, unit, evidence, available, gymName }: ExerciseRowProps) {
  const refs = resolvableRefs(exercise.evidenceRefs, evidence);
  return (
    <Box component="li" sx={{ listStyle: 'none', py: 1, borderTop: 1, borderColor: 'divider' }} data-testid="plan-exercise">
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Typography sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{name}</Typography>
        {exercise.isPriority && <Chip size="small" label="Priority" />}
        {exercise.exerciseUnavailable && <Chip size="small" color="warning" label="No longer in the library" />}
        {available === false && <Chip size="small" color="warning" label={`Not available at ${gymName ?? 'this gym'}`} />}
      </Stack>
      <Typography variant="body2">
        {prescription(exercise)} · {formatRest(exercise.restSeconds)} · {loadLine(exercise.loadGuidance, exercise.targetLoadKg, unit)}
      </Typography>
      {(exercise.rationale || refs.length > 0) && (
        <Stack direction="row" spacing={0.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', mt: 0.25 }}>
          {exercise.rationale && (
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {exercise.rationale}
            </Typography>
          )}
          {refs.map((ref) => (
            <EvidenceChip key={ref} refId={ref} evidence={evidence} />
          ))}
        </Stack>
      )}
    </Box>
  );
}

export default ExerciseRow;
