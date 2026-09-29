/**
 * Whether "Scan gym" (E3.4) can be offered to this user, and if not, why, in
 * plain language. Shared by the Scan gym button on the gym page and the scan
 * page itself.
 *
 * Presentation only: the API is the gate (`intakes:write` to create and fill
 * an intake, `storage:write` to upload photos, `ai:use` plus `AiEnabledGuard`
 * and the model's capabilities to analyze). Adding equipment by hand never
 * depends on any of this.
 */
import type { VisionAvailabilityStatus } from '../../hooks/useVisionAvailability';

export const SCAN_PERMISSIONS = ['gyms:write', 'intakes:write', 'storage:write', 'ai:use'] as const;

const PERMISSION_REASON: Record<(typeof SCAN_PERMISSIONS)[number], string> = {
  'gyms:write': 'Scanning needs permission to change gyms, which your account does not have.',
  'intakes:write': 'Scanning needs permission to start a photo scan, which your account does not have.',
  'storage:write': 'Scanning needs permission to upload photos, which your account does not have.',
  'ai:use': 'Your account cannot use AI features.',
};

const STATUS_REASON: Record<Exclude<VisionAvailabilityStatus, 'ready'>, string> = {
  loading: 'Checking whether AI can read your photos…',
  ai_disabled: 'AI is turned off for this app.',
  no_key: 'Add your own AI key in Settings → AI to scan.',
  no_vision_model: 'None of your available models can read images.',
};

/** The first permission the caller is missing, as a reason; `null` when they hold all. */
export function scanPermissionReason(hasPermission: (permission: string) => boolean): string | null {
  const missing = SCAN_PERMISSIONS.find((permission) => !hasPermission(permission));
  return missing ? PERMISSION_REASON[missing] : null;
}

/** Why the AI cannot read photos right now; `null` when a vision model is ready. */
export function scanAvailabilityReason(status: VisionAvailabilityStatus): string | null {
  return status === 'ready' ? null : STATUS_REASON[status];
}
