/**
 * Why the AI path is not offered for these photos, in plain language — and
 * ALWAYS a "Continue manually" button: every photo flow works with no AI, no
 * key and no assigned model.
 *
 * The copy (`visionAvailabilityCopy.ts`) follows who can fix the state: the
 * user's own keys, or an administrator (linked to the assignments page for a
 * caller holding `ai_config:write`). A failed availability check offers
 * "Try again" instead of guessing at a cause.
 */
import { Alert, AlertTitle, Box, Button, Stack } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import type { UseVisionAvailabilityReturn } from '../../hooks/useVisionAvailability';
import { visionNoticeCopy, type NoVisionReason } from './visionAvailabilityCopy';

export type { NoVisionReason } from './visionAvailabilityCopy';

export interface NoVisionModelNoticeProps {
  reason: NoVisionReason;
  /** Who can fix it, from the API's resolution. */
  fix?: UseVisionAvailabilityReturn['fix'];
  /** Re-run the availability check (offered for `error`). */
  onRetry?: () => void;
  onManual: () => void;
  disabled?: boolean;
}

export function NoVisionModelNotice({ reason, fix = null, onRetry, onManual, disabled }: NoVisionModelNoticeProps) {
  const { hasPermission } = usePermissions();
  const copy = visionNoticeCopy(reason, fix, hasPermission('ai_config:write'));
  return (
    <Alert severity={copy.severity} data-vision-status={reason} sx={{ alignItems: 'flex-start' }}>
      <AlertTitle>{copy.title}</AlertTitle>
      <Box sx={{ mb: 1 }}>{copy.body}</Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <Button variant="contained" size="small" onClick={onManual} disabled={disabled}>
          Continue manually
        </Button>
        {copy.retry && onRetry && (
          <Button size="small" color="inherit" onClick={onRetry} disabled={disabled}>
            Try again
          </Button>
        )}
        {copy.link && (
          <Button component={RouterLink} to={copy.link.to} size="small" color="inherit">
            {copy.link.label}
          </Button>
        )}
      </Stack>
    </Alert>
  );
}

export default NoVisionModelNotice;
