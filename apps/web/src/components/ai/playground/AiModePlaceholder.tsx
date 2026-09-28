/**
 * Stand-in for a Playground mode whose panel has not been built yet —
 * issue #445.
 *
 * The mode selector offers a mode as soon as a usable model declares its
 * capability, so a mode added to `AI_PLAYGROUND_MODES` needs something to show
 * until its panel lands. Every mode has a real panel today; this is the
 * `default` branch of `AiPlaygroundPage`'s `renderModePanel`.
 */
import { Paper, Typography } from '@mui/material';
import type { AiPlaygroundMode } from './aiPlaygroundModes';

export interface AiModePlaceholderProps {
  mode: AiPlaygroundMode;
}

export function AiModePlaceholder({ mode }: AiModePlaceholderProps) {
  return (
    <Paper component="section" variant="outlined" aria-label={mode.label} sx={{ p: { xs: 2, sm: 3 } }}>
      <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
        {mode.label} is not available in the playground yet.
      </Typography>
    </Paper>
  );
}

export default AiModePlaceholder;
