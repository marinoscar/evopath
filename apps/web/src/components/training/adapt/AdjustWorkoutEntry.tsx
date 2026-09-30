/**
 * "Adjust today's workout" (E6.1) on the Today workout card and on Train.
 *
 * Gated like every AI surface: AI on and `ai:use`. Otherwise the button is
 * not offered and one line says why ("AI is off", "Your role can't use AI").
 * It never replaces or blocks Start workout: it sits beside it.
 *
 * With `showResume`, an "Adjusted workout ready" chip links back to the
 * latest ready, unapplied adaptation this browser started in the last 24
 * hours (`useAdaptationResume`; there is no list route).
 */
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Button, Chip, Typography, type SxProps, type Theme } from '@mui/material';
import { AutoAwesome as AiIcon, Tune as TuneIcon } from '@mui/icons-material';
import { useAiConfig } from '../../../hooks/useAiConfig';
import { usePermissions } from '../../../hooks/usePermissions';
import { useAdaptationResume } from '../../../hooks/useAdaptation';
import { AdaptWorkoutSheet, ADAPT_SHEET_TITLE } from './AdaptWorkoutSheet';

export const ADJUST_AI_OFF = 'AI is off';
export const ADJUST_NO_PERMISSION = "Your role can't use AI";
export const RESUME_CHIP_LABEL = 'Adjusted workout ready';

export interface AdjustWorkoutEntryProps {
  /** Offer the "Adjusted workout ready" chip (Today). */
  showResume?: boolean;
  sx?: SxProps<Theme>;
}

export function AdjustWorkoutEntry({ showResume = false, sx }: AdjustWorkoutEntryProps) {
  const { config, isLoading } = useAiConfig();
  const { hasPermission } = usePermissions();
  const allowed = hasPermission('ai:use');
  const available = !isLoading && config.enabled && allowed;
  const { ready } = useAdaptationResume(available && showResume);
  const [open, setOpen] = useState(false);
  // Mount the sheet on first open only: it reads gyms, the check-in and the models.
  const [mounted, setMounted] = useState(false);

  if (isLoading) return null;

  if (!available) {
    return (
      <Typography variant="body2" color="text.secondary" sx={sx} data-testid="adjust-unavailable">
        {ADAPT_SHEET_TITLE}: {config.enabled ? ADJUST_NO_PERMISSION : ADJUST_AI_OFF}
      </Typography>
    );
  }

  return (
    <Box sx={sx} data-testid="adjust-entry">
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
        <Button
          variant="outlined"
          startIcon={<TuneIcon aria-hidden />}
          onClick={() => {
            setMounted(true);
            setOpen(true);
          }}
          sx={{ minHeight: 44 }}
        >
          {ADAPT_SHEET_TITLE}
        </Button>
        {ready && (
          <Chip
            component={RouterLink}
            to={`/train/adapt/${encodeURIComponent(ready.id)}`}
            clickable
            color="primary"
            icon={<AiIcon aria-hidden />}
            label={RESUME_CHIP_LABEL}
            data-testid="adapt-resume-chip"
          />
        )}
      </Box>
      {mounted && <AdaptWorkoutSheet open={open} onClose={() => setOpen(false)} />}
    </Box>
  );
}

export default AdjustWorkoutEntry;
