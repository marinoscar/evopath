/**
 * Why the AI path is not offered for these photos, in plain language — and
 * ALWAYS a "Continue manually" button: every photo flow works with no AI, no
 * key and no vision model.
 */
import { Alert, AlertTitle, Box, Button, Stack } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import type { VisionAvailabilityStatus } from '../../hooks/useVisionAvailability';
import { AI_KEYS_PATH } from '../ai/AiErrorAlert';

export type NoVisionReason = Exclude<VisionAvailabilityStatus, 'ready'>;

const COPY: Record<NoVisionReason, { title: string; body: string; settingsLink: boolean; severity: 'info' | 'warning' }> = {
  loading: {
    title: 'Checking AI availability',
    body: 'Checking which AI models can read your photos.',
    settingsLink: false,
    severity: 'info',
  },
  ai_disabled: {
    title: 'AI is turned off for this app',
    body: 'You can still enter everything yourself.',
    settingsLink: false,
    severity: 'info',
  },
  no_key: {
    title: 'Add your own AI key in Settings → AI',
    body: 'No AI model is available to you yet. Add a key to let AI read your photos, or enter everything yourself.',
    settingsLink: true,
    severity: 'info',
  },
  no_vision_model: {
    title: 'None of your available models can read images',
    body: 'Add a key for a provider with a vision model, or enter everything yourself.',
    settingsLink: true,
    severity: 'warning',
  },
};

export interface NoVisionModelNoticeProps {
  reason: NoVisionReason;
  onManual: () => void;
  disabled?: boolean;
}

export function NoVisionModelNotice({ reason, onManual, disabled }: NoVisionModelNoticeProps) {
  const copy = COPY[reason];
  return (
    <Alert severity={copy.severity} data-vision-status={reason} sx={{ alignItems: 'flex-start' }}>
      <AlertTitle>{copy.title}</AlertTitle>
      <Box sx={{ mb: 1 }}>{copy.body}</Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <Button variant="contained" size="small" onClick={onManual} disabled={disabled}>
          Continue manually
        </Button>
        {copy.settingsLink && (
          <Button component={RouterLink} to={AI_KEYS_PATH} size="small" color="inherit">
            Open AI settings
          </Button>
        )}
      </Stack>
    </Alert>
  );
}

export default NoVisionModelNotice;
