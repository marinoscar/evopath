/**
 * Whether the "Read from photo" entry points exist for this user, issue #64
 * (E2.6).
 *
 * All of these must hold, otherwise the control is not rendered at all (not
 * disabled) and no AI, intake or upload request is ever made:
 *
 * - AI is on in this deployment (`useSettingsFeatures().ai`, the shell's one
 *   `GET /api/ai/config` answer; fail-closed while unknown);
 * - `ai:use` (`POST /api/intakes/:id/analyze` requires it);
 * - `intakes:write` (every intake write route requires it);
 * - `storage:write` (the photos are uploaded as storage objects);
 * - `health_data:write` (apply writes measurements).
 *
 * Presentation only: the API enforces every one of these on every call.
 * Manual entry (`LogMeasurementDialog`) never depends on this.
 */
import { usePermissions } from './usePermissions';
import { useSettingsFeatures } from './useSettingsFeatures';

/** The permissions the photo-read flow needs, besides AI being on. */
export const PHOTO_READ_PERMISSIONS = ['ai:use', 'intakes:write', 'storage:write', 'health_data:write'] as const;

export function useCanReadFromPhoto(): boolean {
  const { ai } = useSettingsFeatures();
  const { hasPermission } = usePermissions();
  return ai && PHOTO_READ_PERMISSIONS.every((permission) => hasPermission(permission));
}

export default useCanReadFromPhoto;
