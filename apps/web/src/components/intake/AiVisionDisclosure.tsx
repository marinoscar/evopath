/**
 * Before any photo is sent to an AI model, say exactly where it goes: the
 * provider, the model and whose key pays ("your own key" or "the
 * organization key"). With more than one vision model the user picks one
 * here; with more than {@link AI_VISION_MAX_IMAGES_PER_REQUEST} photos the
 * number of requests is spelled out.
 *
 * For every status other than `ready` it renders {@link NoVisionModelNotice}
 * instead, which always offers "Continue manually".
 */
import { Box, Typography } from '@mui/material';
import type { AiKeySource } from '../../services/ai';
import type { UseVisionAvailabilityReturn } from '../../hooks/useVisionAvailability';
import { AiModelSelect, aiModelKey, aiModelLabel } from '../ai/AiModelSelect';
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
  const { status, models, selected, select } = availability;
  if (status !== 'ready' || !selected) {
    return <NoVisionModelNotice reason={status === 'ready' ? 'loading' : status} onManual={onManual} disabled={disabled} />;
  }

  const requests = visionRequestCount(photoCount);
  return (
    <Box data-testid="ai-vision-disclosure">
      <Typography variant="body2" sx={{ mb: models.length > 1 ? 1.5 : 0 }}>
        These photos will be sent to <strong>{selected.provider}</strong> (<strong>{aiModelLabel(selected)}</strong>)
        using <strong>{KEY_SOURCE[selected.keySource] ?? KEY_SOURCE.user}</strong>.
        {photoCount > AI_VISION_MAX_IMAGES_PER_REQUEST && (
          <>
            {' '}
            <span data-testid="ai-vision-request-count">
              {photoCount} photos in {requests} requests.
            </span>
          </>
        )}
      </Typography>
      {models.length > 1 && (
        <AiModelSelect
          models={models}
          value={aiModelKey(selected)}
          capability="vision_input"
          disabled={disabled}
          onChange={(key) => {
            const model = models.find((entry) => aiModelKey(entry) === key);
            if (model) select(model.provider, model.modelId);
          }}
        />
      )}
    </Box>
  );
}

export default AiVisionDisclosure;
