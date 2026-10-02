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
 *
 * COLLAPSIBLE (#324). The persona row is always visible; collapsed it is one
 * compact row with a weekly-target chip, a streak chip and a toggle, and the
 * tagline, ring, streak line and next session fold away.
 * Collapsed by default below `sm`, expanded from `sm` up; an explicit toggle is
 * remembered in `localStorage` under `HEADER_EXPANDED_STORAGE_KEY`. The paused
 * banner and the coach-off notice sit outside the fold, so they show in both
 * states. The `down('sm')`
 * query here is local presentation only and is not one of the five coupled
 * breakpoint gates (docs/specs/settings-ui.md).
 */
import { useId, useState } from 'react';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  IconButton,
  Paper,
  Stack,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import LocalFireDepartmentIcon from '@mui/icons-material/LocalFireDepartment';
import EventIcon from '@mui/icons-material/Event';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
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

/** Where the user's explicit expand/collapse choice is remembered. */
export const HEADER_EXPANDED_STORAGE_KEY = 'coach.headerExpanded';

function readStoredExpanded(): boolean | null {
  try {
    const value = window.localStorage.getItem(HEADER_EXPANDED_STORAGE_KEY);
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

function writeStoredExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(HEADER_EXPANDED_STORAGE_KEY, String(expanded));
  } catch {
    // Storage unavailable (private window, blocked site data): the choice
    // lasts for this mount only.
  }
}

/** The compact weekly-target chip label: "2/3 this week", or "No plan". */
export function weeklyTargetChipText(target: CoachStateView['weeklyTarget']): string {
  if (target.planned === 0) return 'No plan';
  return `${target.done}/${target.planned} this week`;
}

const visuallyHidden = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  padding: 0,
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: '1px',
} as const;

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
  const theme = useTheme();
  // `noSsr` answers on the first render, so a phone never flashes expanded.
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'), { noSsr: true });
  const [storedExpanded, setStoredExpanded] = useState<boolean | null>(readStoredExpanded);
  const expanded = storedExpanded ?? !isCompactWindow;
  const detailsId = useId();

  const Icon = personaIcon(persona?.avatar ?? '');
  const pausedUntil = state?.pausedUntil && new Date(state.pausedUntil).getTime() > Date.now() ? state.pausedUntil : null;

  const toggle = () => {
    const next = !expanded;
    setStoredExpanded(next);
    writeStoredExpanded(next);
  };

  return (
    <Paper
      variant="outlined"
      component="header"
      aria-label="Your coach"
      data-expanded={expanded ? 'true' : 'false'}
      sx={{ p: expanded ? 2 : 1.25, mb: 2, minWidth: 0, transition: theme.transitions.create('padding') }}
    >
      <Stack direction="row" spacing={expanded ? 1.5 : 1} sx={{ alignItems: 'center', minWidth: 0 }}>
        <Avatar
          sx={{
            bgcolor: 'primary.container',
            color: 'primary.onContainer',
            width: expanded ? 48 : 32,
            height: expanded ? 48 : 32,
            flexShrink: 0,
            transition: theme.transitions.create(['width', 'height']),
          }}
          aria-hidden
        >
          <Icon fontSize={expanded ? 'medium' : 'small'} />
        </Avatar>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography
            variant={expanded ? 'h5' : 'subtitle1'}
            component="h1"
            noWrap={!expanded}
            sx={{ overflowWrap: expanded ? 'anywhere' : undefined, fontWeight: expanded ? undefined : 600 }}
          >
            {persona?.name ?? 'Coach'}
          </Typography>
          <Collapse in={expanded && Boolean(persona?.tagline)} timeout="auto">
            {persona?.tagline && (
              <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                {persona.tagline}
              </Typography>
            )}
          </Collapse>
        </Box>
        {!expanded && state && (
          <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0, alignItems: 'center' }} data-testid="coach-header-chips">
            <Chip size="small" variant="outlined" label={weeklyTargetChipText(state.weeklyTarget)} data-testid="coach-target-chip" />
            <Chip
              size="small"
              variant="outlined"
              icon={<LocalFireDepartmentIcon color={state.weeklyStreak > 0 ? 'warning' : 'disabled'} aria-hidden />}
              label={
                <>
                  <span aria-hidden>{state.weeklyStreak}</span>
                  <Box component="span" sx={visuallyHidden}>
                    {state.weeklyStreak}-week streak
                  </Box>
                </>
              }
              data-testid="coach-streak-chip"
            />
          </Stack>
        )}
        <IconButton
          size="small"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={expanded ? 'Hide coach details' : 'Show coach details'}
          sx={{ flexShrink: 0 }}
        >
          {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        </IconButton>
      </Stack>

      <Collapse in={expanded} timeout="auto" id={detailsId} data-testid="coach-header-details">
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
      </Collapse>

      {state && !state.enabled && (
        <Alert
          severity="info"
          sx={{ mt: expanded ? 2 : 1.25 }}
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
        <Alert severity="info" sx={{ mt: expanded ? 2 : 1.25 }} data-testid="coach-paused">
          Coach paused until {formatInstant(pausedUntil)}. You can still chat.
        </Alert>
      )}
    </Paper>
  );
}

export default CoachHeader;
