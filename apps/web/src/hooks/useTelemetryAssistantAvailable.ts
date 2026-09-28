/**
 * Whether the telemetry AI assistant may be offered to this viewer — issue
 * #579 (extracted from the Telemetry Explorer, #537), epic #576.
 *
 * ONE condition, shared by every page that offers the assistant (the Telemetry
 * Explorer and the Telemetry Dashboard), so the two can never disagree:
 *
 *   - the assistant is switched on in the Telemetry settings
 *     (`GET /api/telemetry/config` → `assistantEnabled`),
 *   - AI is switched on for the deployment (`GET /api/ai/config` → `enabled`),
 *   - the viewer holds `ai:use`.
 *
 * This only HIDES the control. The API enforces every one of those on
 * `POST /admin/telemetry/assistant/stream` regardless.
 */
import { usePermissions } from './usePermissions';
import { useAiConfig } from './useAiConfig';
import { useTelemetryConfig } from './useTelemetryConfig';

export function useTelemetryAssistantAvailable(): boolean {
  const { hasPermission } = usePermissions();
  const { config: telemetryConfig } = useTelemetryConfig();
  const { config: aiConfig } = useAiConfig();
  return telemetryConfig.assistantEnabled && aiConfig.enabled && hasPermission('ai:use');
}
