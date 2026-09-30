/**
 * "This week" on the Train page (E5.9): the active plan's sessions done of
 * this week's planned sessions, adherence so far, and a link to the plan's
 * Progress view. Renders nothing without an active plan (Today's plan card
 * already offers to create one). Quiet on errors: this is a summary.
 */
import { Link as RouterLink } from 'react-router-dom';
import {
  Button,
  Card,
  CardActions,
  CardContent,
  Skeleton,
  Typography,
  type SxProps,
  type Theme,
} from '@mui/material';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import { useSignals } from '../../hooks/useSignals';
import { formatPct } from './AdherenceChart';

export function ThisWeekCard({ sx }: { sx?: SxProps<Theme> }) {
  const { signals, isLoading, error } = useSignals({ weeks: 1, toEndOfWeek: true });

  if (isLoading)
    return <Skeleton variant="rounded" height={96} data-testid="this-week-skeleton" sx={sx} />;
  if (error || !signals || signals.programId === null) return null;

  const done = signals.sessions.filter((s) => s.status === 'done' || s.status === 'partial').length;
  const total = signals.sessions.length;
  const { adherencePct, planned } = signals.adherence.totals;

  return (
    <Card variant="outlined" component="section" aria-labelledby="this-week-heading" sx={sx}>
      <CardContent sx={{ pb: 0 }}>
        <Typography id="this-week-heading" variant="h6" component="h2">
          This week
        </Typography>
        <Typography>
          {done} of {total} planned {total === 1 ? 'session' : 'sessions'} done
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {planned === 0
            ? 'No session was due yet.'
            : `Adherence so far ${formatPct(adherencePct)}`}
        </Typography>
      </CardContent>
      <CardActions sx={{ px: 2, pb: 2 }}>
        <Button
          component={RouterLink}
          to={`/train/plans/${encodeURIComponent(signals.programId)}/progress`}
          startIcon={<InsightsOutlinedIcon />}
          sx={{ minHeight: 44 }}
        >
          See progress
        </Button>
      </CardActions>
    </Card>
  );
}
