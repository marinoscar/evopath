/**
 * Whether "Prefill from photo" (E4.5) can be offered to this user, and if
 * not, why, in plain language. Shared by the button on the workout page and
 * the prefill page itself.
 *
 * Presentation only: the API is the gate (`intakes:write` plus the kind's
 * `workouts:write` and `exercises:write` to create, fill and apply an intake,
 * `storage:write` to upload photos, `ai:use` plus `AiEnabledGuard` and the
 * model's capabilities to analyze). Logging a workout by hand never depends
 * on any of this.
 */
import type { UseVisionAvailabilityReturn } from '../../hooks/useVisionAvailability';
import { visionShortReason } from '../intake/visionAvailabilityCopy';

export const PREFILL_PERMISSIONS = [
  'workouts:write',
  'exercises:write',
  'intakes:write',
  'storage:write',
  'ai:use',
] as const;

const PERMISSION_REASON: Record<(typeof PREFILL_PERMISSIONS)[number], string> = {
  'workouts:write': 'Prefilling needs permission to change workouts, which your account does not have.',
  'exercises:write': 'Prefilling needs permission to add exercises, which your account does not have.',
  'intakes:write': 'Prefilling needs permission to start a photo prefill, which your account does not have.',
  'storage:write': 'Prefilling needs permission to upload photos, which your account does not have.',
  'ai:use': 'Your account cannot use AI features.',
};

/** The first permission the caller is missing, as a reason; `null` when they hold all. */
export function prefillPermissionReason(hasPermission: (permission: string) => boolean): string | null {
  const missing = PREFILL_PERMISSIONS.find((permission) => !hasPermission(permission));
  return missing ? PERMISSION_REASON[missing] : null;
}

/** Why the AI cannot read photos right now; `null` when a vision model is ready. */
export function prefillAvailabilityReason(availability: Pick<UseVisionAvailabilityReturn, 'status' | 'fix'>): string | null {
  return visionShortReason(availability, 'prefill from photos');
}
