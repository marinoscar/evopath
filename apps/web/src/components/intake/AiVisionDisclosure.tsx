/**
 * Before any photo is sent to an AI model, say exactly where it goes: the
 * provider, the model and whose key pays ("your own key" or "the
 * organization key"). With more than {@link AI_VISION_MAX_IMAGES_PER_REQUEST}
 * photos the number of requests is spelled out.
 *
 * READ-ONLY (#173): an administrator assigns the model; the user never picks
 * one. When no administrator assignment applied and the API picked a model
 * itself, that is said too.
 *
 * For every status other than `ready` it renders {@link NoVisionModelNotice}
 * instead, which always offers "Continue manually".
 */
import { Box, Typography } from '@mui/material';
import type { AiKeySource } from '../../services/ai';
import type { UseVisionAvailabilityReturn } from '../../hooks/useVisionAvailability';
import { NoVisionModelNotice } from './NoVisionModelNotice';

/** Stored image inputs per AI request (docs/specs/ai-platform.md §2.9). */
export const AI_VISION_MAX_IMAGES_PER_REQUEST = 16;

const KEY_SOURCE: Record<AiKeySource, string> = {
  user: 'your own key',
  org: 'the organization key',
  none: 'a keyless server (no key is billed)',
};

/** How many requests `photoCount` photos take. */
export function visionRequestCount(photoCount: number, perRequest = AI_VISION_MAX_IMAGES_PER_REQUEST): number {
  return Math.max(1, Math.ceil(photoCount / perRequest));
}

export interface AiVisionDisclosureProps {
  availability: UseVisionAvailabilityReturn;
  /** Photos that would be sent. */
  photoCount?: number;
  onManual: () => void;
  disabled?: boolean;
}

export function AiVisionDisclosure({ availability, photoCount = 0, onManual, disabled }: AiVisionDisclosureProps) {
  const { status, model, source, fix, refresh } = availability;
  if (status !== 'ready' || !model) {
    return (
      <NoVisionModelNotice
        reason={status === 'ready' ? 'loading' : status}
        fix={fix}
        onRetry={() => void refresh()}
        onManual={onManual}
        disabled={disabled}
      />
    );
  }

  const requests = visionRequestCount(photoCount);
  return (
    <Box data-testid="ai-vision-disclosure">
      <Typography variant="body2">
        These photos will be sent to <strong>{model.provider}</strong> (
        <strong>{model.displayName || model.modelId}</strong>) using{' '}
        <strong>{KEY_SOURCE[model.keySource] ?? KEY_SOURCE.user}</strong>.
        {photoCount > AI_VISION_MAX_IMAGES_PER_REQUEST && (
          <>
            {' '}
            <span data-testid="ai-vision-request-count">
              {photoCount} photos in {requests} requests.
            </span>
          </>
        )}
      </Typography>
      <Typography variant="caption" color="text.secondary" data-testid="ai-vision-model-source">
        {source === 'auto'
          ? 'Chosen automatically: your administrator has not assigned a model for this yet.'
          : 'Chosen by your administrator.'}
      </Typography>
    </Box>
  );
}

export default AiVisionDisclosure;
