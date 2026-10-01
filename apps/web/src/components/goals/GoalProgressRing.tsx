/**
 * A determinate progress ring over a faint full track, with the percentage in
 * the middle (#268). The ring is decorative next to the text line it sits
 * beside; it still carries a `progressbar` role with a label for screen readers.
 */
import { Box, CircularProgress, Typography } from '@mui/material';

export interface GoalProgressRingProps {
  /** 0..100 */
  value: number;
  label: string;
  size?: number;
  color?: 'primary' | 'success' | 'warning';
}

export function GoalProgressRing({ value, label, size = 56, color = 'primary' }: GoalProgressRingProps) {
  return (
    <Box sx={{ position: 'relative', display: 'inline-flex', flexShrink: 0, width: size, height: size }}>
      <CircularProgress
        variant="determinate"
        value={100}
        size={size}
        thickness={4.5}
        aria-hidden
        sx={{ color: 'action.hover', position: 'absolute', left: 0 }}
      />
      <CircularProgress
        variant="determinate"
        value={value}
        size={size}
        thickness={4.5}
        color={color}
        aria-label={label}
      />
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        aria-hidden
      >
        <Typography variant="caption" component="span" sx={{ fontWeight: 600 }}>
          {value}%
        </Typography>
      </Box>
    </Box>
  );
}

export default GoalProgressRing;
