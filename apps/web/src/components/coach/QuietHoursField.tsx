/**
 * Quiet hours: two `HH:mm` times, a window in which the coach sends nothing
 * (E7.3, #243; docs/specs/ai-coach.md §3.1). The window may wrap midnight:
 * 21:30 to 07:30 is accepted and labelled "overnight". An invalid time is
 * reported inline, on its own field.
 */
import { Box, Chip, Stack, TextField, Typography } from '@mui/material';
import NightsStayOutlinedIcon from '@mui/icons-material/NightsStayOutlined';
import { COACH_TIME_OF_DAY_PATTERN } from '../../services/coach';

export const QUIET_HOURS_INVALID_TIME = 'Enter a time as HH:mm, for example 21:30.';

export function isValidTimeOfDay(value: string): boolean {
  return COACH_TIME_OF_DAY_PATTERN.test(value);
}

/** True when the window wraps midnight (start later in the day than end). */
export function isOvernight(start: string, end: string): boolean {
  return isValidTimeOfDay(start) && isValidTimeOfDay(end) && start > end;
}

export interface QuietHoursFieldProps {
  start: string;
  end: string;
  onChange: (next: { start: string; end: string }) => void;
  disabled?: boolean;
}

export function QuietHoursField({ start, end, onChange, disabled = false }: QuietHoursFieldProps) {
  const startInvalid = !isValidTimeOfDay(start);
  const endInvalid = !isValidTimeOfDay(end);
  const overnight = isOvernight(start, end);
  const same = !startInvalid && !endInvalid && start === end;

  return (
    <Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { sm: 'flex-start' } }}>
        <TextField
          type="time"
          id="coach-quiet-start"
          label="Quiet from"
          size="small"
          value={start}
          disabled={disabled}
          error={startInvalid}
          helperText={startInvalid ? QUIET_HOURS_INVALID_TIME : ' '}
          onChange={(event) => onChange({ start: event.target.value, end })}
          slotProps={{ inputLabel: { shrink: true }, htmlInput: { step: 300 } }}
        />
        <TextField
          type="time"
          id="coach-quiet-end"
          label="Quiet until"
          size="small"
          value={end}
          disabled={disabled}
          error={endInvalid}
          helperText={endInvalid ? QUIET_HOURS_INVALID_TIME : ' '}
          onChange={(event) => onChange({ start, end: event.target.value })}
          slotProps={{ inputLabel: { shrink: true }, htmlInput: { step: 300 } }}
        />
        {overnight && (
          <Chip
            icon={<NightsStayOutlinedIcon />}
            label="Overnight"
            size="small"
            sx={{ alignSelf: { xs: 'flex-start', sm: 'center' }, mt: { sm: 0.5 } }}
            data-testid="quiet-hours-overnight"
          />
        )}
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {overnight
          ? `No coach messages from ${start} until ${end} the next morning.`
          : same
            ? 'Start and end are the same, so there are no quiet hours.'
            : !startInvalid && !endInvalid
              ? `No coach messages from ${start} until ${end}.`
              : 'No coach messages during these hours.'}
      </Typography>
    </Box>
  );
}
