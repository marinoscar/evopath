/**
 * The `/coach` header (E7.8, #248; docs/specs/ai-coach.md §2.13): the persona's
 * avatar and name, the weekly target ring ("2 of 3 this week"), the weekly
 * streak with its passes, and the next planned session.
 *
 * EVERY NUMBER IS `GET /api/coach/state` AS SENT. The ring's fill is the one
 * piece of arithmetic here, and it is display only; the counts in the text are
 * the server's. Without the state (still loading, or a `403` for a user
 * without `programs:read`) the persona row still renders and the plan signals
 * are left out.
 */
import { Alert, Avatar, Box, Button, CircularProgress, Paper, Stack, Typography } from '@mui/material';
import LocalFireDepartmentIcon from '@mui/icons-material/LocalFireDepartment';
import EventIcon from '@mui/icons-material/Event';
import { Link as RouterLink } from 'react-router-dom';
import type { CoachPersonaCard, CoachStateView } from '../../services/coach';
import { personaIcon } from './personaAvatar';

export interface CoachHeaderProps {
  persona: CoachPersonaCard | null;
  state: CoachStateView | null;
}

export function weeklyTargetText(target: CoachStateView['weeklyTarget']): string {
  if (target.planned === 0) return 'No sessions planned this week';
  return `${target.done} of ${target.planned} this week`;
}

function formatDay(isoDate: string): string {
  // A local calendar day (`YYYY-MM-DD`): parse as local noon so no time zone
  // moves it across midnight.
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) return isoDate;
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(
    new Date(y, m - 1, d, 12),
  );
}

function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(date);
}

function TargetRing({ target }: { target: CoachStateView['weeklyTarget'] }) {
  const percent = target.planned > 0 ? Math.min(100, Math.round((target.done / target.planned) * 100)) : 0;
  const text = weeklyTargetText(target);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }} data-testid="coach-weekly-target">
      <Box sx={{ position: 'relative', display: 'inline-flex' }}>
        <CircularProgress variant="determinate" value={100} size={44} thickness={5} sx={{ color: 'action.hover' }} aria-hidden />
        <CircularProgress
          variant="determinate"
          value={percent}
          size={44}
          thickness={5}
          sx={{ position: 'absolute', left: 0 }}
          aria-label="Weekly target"
          aria-valuetext={text}
        />
        <Box
          sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          aria-hidden
        >
          <Typography variant="caption" sx={{ fontWeight: 600 }}>
            {target.planned > 0 ? `${target.done}/${target.planned}` : '–'}
          </Typography>
        </Box>
      </Box>
      <Typography variant="body2">{text}</Typography>
    </Box>
  );
}

export function CoachHeader({ persona, state }: CoachHeaderProps) {
  const Icon = personaIcon(persona?.avatar ?? '');
  const pausedUntil = state?.pausedUntil && new Date(state.pausedUntil).getTime() > Date.now() ? state.pausedUntil : null;

  return (
    <Paper variant="outlined" component="header" aria-label="Your coach" sx={{ p: 2, mb: 2, minWidth: 0 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', minWidth: 0 }}>
        <Avatar sx={{ bgcolor: 'primary.container', color: 'primary.onContainer', width: 48, height: 48 }} aria-hidden>
          <Icon />
        </Avatar>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h5" component="h1" sx={{ overflowWrap: 'anywhere' }}>
            {persona?.name ?? 'Coach'}
          </Typography>
          {persona?.tagline && (
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {persona.tagline}
            </Typography>
          )}
        </Box>
      </Stack>

      {state && (
        <Box
          sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center', mt: 2 }}
          data-testid="coach-header-signals"
        >
          <TargetRing target={state.weeklyTarget} />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }} data-testid="coach-streak">
            <LocalFireDepartmentIcon color={state.weeklyStreak > 0 ? 'warning' : 'disabled'} aria-hidden />
            <Typography variant="body2">
              {state.weeklyStreak}-week streak
              <Typography component="span" variant="body2" color="text.secondary">
                {' · '}
                {state.streakPassesLeft} {state.streakPassesLeft === 1 ? 'pass' : 'passes'} left
              </Typography>
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }} data-testid="coach-next-session">
            <EventIcon color="action" aria-hidden />
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
              {state.nextSession
                ? `Next: ${state.nextSession.name} · ${formatDay(state.nextSession.date)}`
                : 'No session planned in the next 7 days'}
            </Typography>
          </Box>
        </Box>
      )}

      {state && !state.enabled && (
        <Alert
          severity="info"
          sx={{ mt: 2 }}
          action={
            <Button component={RouterLink} to="/settings/coach" color="inherit" size="small">
              Coach settings
            </Button>
          }
        >
          Your coach is off, so it will not send you nudges.
        </Alert>
      )}
      {pausedUntil && (
        <Alert severity="info" sx={{ mt: 2 }} data-testid="coach-paused">
          Coach paused until {formatInstant(pausedUntil)}. You can still chat.
        </Alert>
      )}
    </Paper>
  );
}

export default CoachHeader;
