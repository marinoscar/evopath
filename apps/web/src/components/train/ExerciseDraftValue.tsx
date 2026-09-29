/**
 * The read view of one `workout_prefill` draft item (E4.5), the
 * `renderValue` the prefill page hands to `AiDraftReview`: the exercise
 * name (with "New custom exercise" when it is not in the library), what the
 * AI read on the photo ("read as: …", so a guess is always next to its
 * source), and the sets in the user's display unit ("135 lb × 10, 10, 8").
 */
import { Box, Chip, Typography } from '@mui/material';
import type { WeightUnit } from '../../utils/units';
import { formatDraftSets, type ExerciseDraftValue as Value } from '../../services/workoutPrefill';

export interface ExerciseDraftValueProps {
  value: Value;
  unit: WeightUnit;
}

export function ExerciseDraftValue({ value, unit }: ExerciseDraftValueProps) {
  const sets = formatDraftSets(value.sets, unit);
  return (
    <Box data-testid="exercise-draft-value">
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 1, rowGap: 0.5 }}>
        <Typography component="span" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
          {value.name || 'Unnamed exercise'}
        </Typography>
        {value.exerciseSlug === null && value.name !== '' && (
          <Chip size="small" variant="outlined" label="New custom exercise" />
        )}
      </Box>
      {value.rawText && (
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }} data-testid="exercise-draft-raw">
          read as: {value.rawText}
        </Typography>
      )}
      <Typography variant="body2" sx={{ mt: 0.5, overflowWrap: 'anywhere' }} data-testid="exercise-draft-sets">
        {sets ? (
          <>
            {value.sets.length} {value.sets.length === 1 ? 'set' : 'sets'}: {sets}
          </>
        ) : (
          <Box component="span" sx={{ color: 'text.secondary' }}>
            No sets
          </Box>
        )}
      </Typography>
    </Box>
  );
}

export default ExerciseDraftValue;
