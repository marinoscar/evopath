/**
 * One 1-to-5 self-report score of the daily check-in (issue #56, E2.4): a row
 * of five toggle buttons, faster and more precise one-handed than a slider.
 *
 * - The group is named for a screen reader, e.g. "Energy, 1 Drained to 5
 *   Energised", and each button announces its number and pressed state.
 * - The group is one tab stop; the arrow keys move between the numbers
 *   (MUI's roving tab index) and Space or Enter chooses one.
 * - Tapping the selected value clears it: every score is optional.
 * - Selection uses the theme primary colour only; no red/green judgement of
 *   a value (soreness 5 is not "bad" in a way the app decides).
 *
 * The bounds and end labels come from the measurement catalog's `scale`.
 */

import { Box, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';

export interface ScoreScale {
  min: number;
  max: number;
  lowLabel: string;
  highLabel: string;
}

export interface ScoreFieldProps {
  /** Used for the label's id. */
  id: string;
  label: string;
  scale: ScoreScale;
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
}

export function ScoreField({ id, label, scale, value, onChange, disabled = false }: ScoreFieldProps) {
  const options: number[] = [];
  for (let n = scale.min; n <= scale.max; n += 1) options.push(n);

  return (
    <Box>
      <Typography id={`${id}-label`} component="p" variant="subtitle2" sx={{ mb: 0.5 }}>
        {label}
      </Typography>
      <ToggleButtonGroup
        exclusive
        fullWidth
        color="primary"
        value={value}
        disabled={disabled}
        onChange={(_, next: number | null) => onChange(next)}
        aria-label={`${label}, ${scale.min} ${scale.lowLabel} to ${scale.max} ${scale.highLabel}`}
        data-testid={`score-${id}`}
      >
        {options.map((n) => (
          <ToggleButton key={n} value={n} sx={{ minHeight: 44, minWidth: 44, fontSize: '1rem' }}>
            {n}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <Box
        aria-hidden
        sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, mt: 0.5 }}
      >
        <Typography variant="caption" color="text.secondary">
          {scale.min} {scale.lowLabel}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'right' }}>
          {scale.max} {scale.highLabel}
        </Typography>
      </Box>
    </Box>
  );
}

export default ScoreField;
