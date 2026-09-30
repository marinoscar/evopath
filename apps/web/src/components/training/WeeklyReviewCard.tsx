/**
 * The latest review (E5.8): a `reviewed` change log entry, written when the
 * coach looked at the plan and decided no change was needed (the weekly
 * review, or an evaluation after a workout). Presentation only.
 */
import { Card, CardContent, Typography } from '@mui/material';
import type { ChangeLogEntry } from '../../services/programs';
import { formatRelativeTime } from '../../utils/relativeTime';

export function WeeklyReviewCard({ entry }: { entry: ChangeLogEntry }) {
  return (
    <Card variant="outlined" component="section" aria-labelledby="weekly-review-heading" data-testid="weekly-review">
      <CardContent>
        <Typography id="weekly-review-heading" variant="h6" component="h2" gutterBottom>
          Latest review
        </Typography>
        <Typography sx={{ overflowWrap: 'anywhere' }}>{entry.summary}</Typography>
        {entry.rationale && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
            {entry.rationale}
          </Typography>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {entry.actor === 'system' ? 'Safety check' : 'Reviewed by your coach'} · {formatRelativeTime(entry.createdAt)}
        </Typography>
      </CardContent>
    </Card>
  );
}

export default WeeklyReviewCard;
