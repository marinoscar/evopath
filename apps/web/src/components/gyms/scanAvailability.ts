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
import type { UseVisionAvailabilityReturn } from '../../hooks/useVisionAvailability';
import { visionShortReason } from '../intake/visionAvailabilityCopy';

export const SCAN_PERMISSIONS = ['gyms:write', 'intakes:write', 'storage:write', 'ai:use'] as const;

const PERMISSION_REASON: Record<(typeof SCAN_PERMISSIONS)[number], string> = {
  'gyms:write': 'Scanning needs permission to change gyms, which your account does not have.',
  'intakes:write': 'Scanning needs permission to start a photo scan, which your account does not have.',
  'storage:write': 'Scanning needs permission to upload photos, which your account does not have.',
  'ai:use': 'Your account cannot use AI features.',
};

/** The first permission the caller is missing, as a reason; `null` when they hold all. */
export function scanPermissionReason(hasPermission: (permission: string) => boolean): string | null {
  const missing = SCAN_PERMISSIONS.find((permission) => !hasPermission(permission));
  return missing ? PERMISSION_REASON[missing] : null;
}

/** Why the AI cannot read photos right now; `null` when a vision model is ready. */
export function scanAvailabilityReason(availability: Pick<UseVisionAvailabilityReturn, 'status' | 'fix'>): string | null {
  return visionShortReason(availability, 'scan');
}
