/**
 * Which week to show: a select plus previous and next buttons (not a tab
 * strip: weeks are hierarchical content, and a plan can have 52 of them).
 */
import { FormControl, IconButton, InputLabel, MenuItem, Select, Stack } from '@mui/material';
import { ChevronLeft as PrevIcon, ChevronRight as NextIcon } from '@mui/icons-material';

export interface WeekOption {
  weekNumber: number;
  isDeload?: boolean;
  blockName: string;
}

export function WeekSelector({
  weeks,
  value,
  onChange,
}: {
  weeks: WeekOption[];
  value: number;
  onChange: (weekNumber: number) => void;
}) {
  const index = weeks.findIndex((w) => w.weekNumber === value);
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      <IconButton aria-label="Previous week" onClick={() => onChange(weeks[index - 1].weekNumber)} disabled={index <= 0}>
        <PrevIcon />
      </IconButton>
      <FormControl size="small" sx={{ minWidth: 0, flex: 1, maxWidth: 320 }}>
        <InputLabel id="week-select-label">Week</InputLabel>
        <Select
          labelId="week-select-label"
          label="Week"
          value={index >= 0 ? value : ''}
          onChange={(e) => onChange(Number(e.target.value))}
        >
          {weeks.map((week) => (
            <MenuItem key={week.weekNumber} value={week.weekNumber}>
              Week {week.weekNumber}
              {week.isDeload ? ' (deload)' : ''} · {week.blockName}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <IconButton
        aria-label="Next week"
        onClick={() => onChange(weeks[index + 1].weekNumber)}
        disabled={index < 0 || index >= weeks.length - 1}
      >
        <NextIcon />
      </IconButton>
    </Stack>
  );
}

export default WeekSelector;
