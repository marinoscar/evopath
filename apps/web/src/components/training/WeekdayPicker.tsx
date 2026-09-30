/**
 * Weekday chips (ISO 1 Monday .. 7 Sunday). Multiple selection for the
 * wizard's preferred days, single for a workout's day; a day already used
 * elsewhere can be disabled with a reason. Each chip is a toggle button
 * (`aria-pressed`), keyboard and touch friendly.
 */
import { Chip, Stack } from '@mui/material';
import { WEEKDAYS } from './planLabels';

export interface WeekdayPickerProps {
  /** Selected days. */
  value: number[];
  onChange: (value: number[]) => void;
  /** One day at most (a workout); clicking the selected day clears it. */
  single?: boolean;
  /** Days that cannot be chosen (already used in this week). */
  disabledDays?: number[];
  /** Labels the group. */
  label: string;
}

export function WeekdayPicker({ value, onChange, single = false, disabledDays = [], label }: WeekdayPickerProps) {
  const toggle = (day: number) => {
    if (value.includes(day)) onChange(value.filter((d) => d !== day));
    else onChange(single ? [day] : [...value, day].sort((a, b) => a - b));
  };
  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }} role="group" aria-label={label}>
      {WEEKDAYS.map(({ day, short, long }) => {
        const selected = value.includes(day);
        const disabled = !selected && disabledDays.includes(day);
        return (
          <Chip
            key={day}
            label={short}
            component="button"
            type="button"
            clickable
            color={selected ? 'primary' : 'default'}
            variant={selected ? 'filled' : 'outlined'}
            onClick={() => toggle(day)}
            disabled={disabled}
            aria-pressed={selected}
            aria-label={disabled ? `${long} (already used this week)` : long}
            sx={{ minHeight: 36, minWidth: 48 }}
          />
        );
      })}
    </Stack>
  );
}

export default WeekdayPicker;
