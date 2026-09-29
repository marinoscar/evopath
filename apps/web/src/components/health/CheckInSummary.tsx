/**
 * A check-in's recorded scores as read-only chips ("Energy 4") and its note,
 * issue #56 (E2.4). Shared by the Health page's Daily check-in section and the
 * Today Readiness card. Unrecorded scores are left out; no combined score.
 */

import { Box, Chip, Typography } from '@mui/material';
import {
  CHECK_IN_FIELDS,
  type CheckIn,
  type CheckInField,
  type MetricCatalog,
} from '../../services/health';
import type { ScoreScale } from './ScoreField';

export interface CheckInFieldDef {
  field: CheckInField;
  label: string;
  /** `null` while the catalog is not loaded (or lacks the metric). */
  scale: ScoreScale | null;
}

/** The four fields with their catalog label and scale, in display order. */
export function checkInFieldDefs(catalog: MetricCatalog | null): CheckInFieldDef[] {
  const metrics = new Map((catalog?.metrics ?? []).map((metric) => [metric.key, metric]));
  return CHECK_IN_FIELDS.map(({ field, metricKey, fallbackLabel }) => {
    const metric = metrics.get(metricKey);
    return { field, label: metric?.label ?? fallbackLabel, scale: metric?.scale ?? null };
  });
}

/** "Energy 4 · Sleep quality 3", for a compact one-line list row. */
export function checkInScoresText(checkIn: CheckIn, defs: CheckInFieldDef[]): string {
  return defs
    .filter(({ field }) => checkIn[field] !== null)
    .map(({ field, label }) => `${label} ${checkIn[field]}`)
    .join(' · ');
}

export function CheckInSummary({
  checkIn,
  defs,
  showNote = true,
}: {
  checkIn: CheckIn;
  defs: CheckInFieldDef[];
  showNote?: boolean;
}) {
  const recorded = defs.filter(({ field }) => checkIn[field] !== null);
  return (
    <Box>
      <Box
        component="ul"
        aria-label="Scores"
        sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexWrap: 'wrap', gap: 1 }}
      >
        {recorded.map(({ field, label, scale }) => (
          <Box component="li" key={field}>
            <Chip
              variant="outlined"
              label={`${label} ${checkIn[field]}`}
              title={scale ? `${label} ${checkIn[field]} of ${scale.max}` : undefined}
            />
          </Box>
        ))}
      </Box>
      {showNote && checkIn.note && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1, overflowWrap: 'anywhere' }}>
          {checkIn.note}
        </Typography>
      )}
    </Box>
  );
}

export default CheckInSummary;
