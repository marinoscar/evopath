/**
 * "Choose another session" (#335): this plan week's sessions, so the user
 * can do a different one than the calendar suggests. It only lists what
 * `GET /api/training/today` answers in `week`; starting goes through the
 * card's own start path (the API builds the workout and enforces the rules).
 *
 * A done session is shown but cannot be started again (View opens it); an
 * in-progress one offers Resume; any other one starts on select.
 */
import { Link as RouterLink } from 'react-router-dom';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  useMediaQuery,
  useTheme,
  type ChipProps,
} from '@mui/material';
import type { TodayWeekSession, TodayWeekSessionStatus } from '../../services/programs';

const STATUS: Record<TodayWeekSessionStatus, { label: string; color: ChipProps['color'] }> = {
  done: { label: 'Done', color: 'success' },
  in_progress: { label: 'In progress', color: 'primary' },
  missed: { label: 'Missed', color: 'warning' },
  today: { label: 'Today', color: 'info' },
  upcoming: { label: 'Upcoming', color: 'default' },
};

/** "Mon 5 Oct" for a `YYYY-MM-DD` day, formatted as a calendar date (no time-zone shift). */
export function formatShortDay(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return [parts.weekday, parts.day, parts.month].filter(Boolean).join(' ');
}

/** Sessions the picker can act on: anything not already done. */
export function selectableSessions(week: TodayWeekSession[] | undefined): TodayWeekSession[] {
  return (week ?? []).filter((s) => s.status !== 'done');
}

function metaLine(s: TodayWeekSession): string {
  const { estimatedMinutes, exerciseCount } = s.programWorkout;
  return [
    formatShortDay(s.date),
    estimatedMinutes ? `about ${estimatedMinutes} min` : null,
    `${exerciseCount} ${exerciseCount === 1 ? 'exercise' : 'exercises'}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export interface SessionPickerDialogProps {
  open: boolean;
  week: TodayWeekSession[];
  /** A start is underway: options are disabled. */
  starting: boolean;
  onClose: () => void;
  /** Start this planned workout (the card's start path). */
  onStart: (programWorkoutId: string) => void;
}

export function SessionPickerDialog({ open, week, starting, onClose, onStart }: SessionPickerDialogProps) {
  const theme = useTheme();
  // Full-screen below `sm`, like the app's other dialogs; not a navigation breakpoint gate.
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      aria-labelledby="session-picker-title"
      data-testid="session-picker"
    >
      <DialogTitle id="session-picker-title">Choose a session</DialogTitle>
      <DialogContent dividers sx={{ px: { xs: 1, sm: 2 } }}>
        <List aria-label="This week's sessions" disablePadding>
          {week.map((s) => {
            const pw = s.programWorkout;
            const status = STATUS[s.status];
            const day = formatShortDay(s.date);
            const done = s.status === 'done';
            const resumeId = s.inProgressWorkoutId;
            const chips = (
              <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.5 }} component="span">
                <Chip size="small" color={status.color} label={status.label} component="span" />
                {s.suggested && <Chip size="small" variant="outlined" label="Suggested" component="span" />}
              </Stack>
            );
            const text = (
              <ListItemText
                primary={pw.name}
                secondary={
                  <>
                    <Box component="span" sx={{ display: 'block' }}>
                      {metaLine(s)}
                    </Box>
                    {chips}
                  </>
                }
                slotProps={{
                  primary: { sx: { fontWeight: 500, overflowWrap: 'anywhere' } },
                  secondary: { component: 'span' },
                }}
              />
            );
            const testId = `session-option-${pw.id}`;

            if (done) {
              return (
                <ListItem
                  key={`${pw.id}-${s.date}`}
                  disablePadding
                  secondaryAction={
                    s.completedWorkoutId ? (
                      <Button
                        component={RouterLink}
                        to={`/train/workouts/${s.completedWorkoutId}`}
                        size="small"
                        aria-label={`View ${pw.name}, ${day}`}
                      >
                        View
                      </Button>
                    ) : undefined
                  }
                >
                  <ListItemButton disabled data-testid={testId} aria-label={`${pw.name}, ${day}, done`}>
                    {text}
                  </ListItemButton>
                </ListItem>
              );
            }

            if (resumeId) {
              return (
                <ListItem key={`${pw.id}-${s.date}`} disablePadding>
                  <ListItemButton
                    component={RouterLink}
                    to={`/train/workouts/${resumeId}`}
                    data-testid={testId}
                    aria-label={`Resume ${pw.name}, ${day}`}
                  >
                    {text}
                  </ListItemButton>
                </ListItem>
              );
            }

            return (
              <ListItem key={`${pw.id}-${s.date}`} disablePadding>
                <ListItemButton
                  disabled={starting}
                  onClick={() => onStart(pw.id)}
                  data-testid={testId}
                  aria-label={`Start ${pw.name}, ${day}${s.suggested ? ', suggested' : ''}`}
                >
                  {text}
                </ListItemButton>
              </ListItem>
            );
          })}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}

export default SessionPickerDialog;
