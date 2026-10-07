/**
 * The app's telemetry adapters (marinoscar/EnterpriseAppBase#719): what the
 * packaged telemetry pages (`@marinoscar/platform-web/telemetry`) need from
 * this app beyond the platform host. The AI slice is not packaged yet, so its hooks stay here and are
 * handed in through `TelemetryWebAdaptersProvider`, mounted next to
 * `TelemetryConfigProvider` in `App.tsx`:
 *
 *   - `useAiEnabled`: `useAiConfig()` (the shell's shared `GET /api/ai/config`),
 *     which hides the telemetry assistant while AI is off.
 *   - `useAssistantModels`: `useAiModels({ enabled: true, pageSize: 100 })`,
 *     the Telemetry settings page's assistant model picker, mapped to the four
 *     fields it shows.
 *   - `Spinner`: `LoadingSpinner`, so loading states look like the rest of the app.
 *
 * A module constant: each `use*` member is a hook, so the same object must be
 * handed in on every render.
 */

import { useMemo } from 'react';
import type {
  TelemetryAiEnabledState,
  TelemetryAssistantModelOption,
  TelemetryAssistantModelsState,
  TelemetryWebAdapters,
} from '@marinoscar/platform-web/telemetry/headless';

import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { useAiConfig } from '../hooks/useAiConfig';
import { useAiModels } from '../hooks/useAiModels';
import type { AiModel, AiModelListFilter } from '../services/ai';

/** Enabled models only; one page of 100 is the whole catalogue in practice. */
const ASSISTANT_MODEL_FILTER: AiModelListFilter = Object.freeze({ enabled: true, pageSize: 100 });

/** An AI catalogue row as the assistant model picker shows it. */
export function toAssistantModelOption(model: AiModel): TelemetryAssistantModelOption {
  return {
    id: model.id,
    provider: model.provider,
    modelId: model.modelId,
    label: model.displayName || model.modelId,
    supportsToolCalling: model.capabilities?.capabilities.includes('tools') ?? false,
  };
}

function useAiEnabled(): TelemetryAiEnabledState {
  const { config, isLoading } = useAiConfig();
  return { enabled: config.enabled, isLoading };
}

function useAssistantModels(): TelemetryAssistantModelsState {
  const { models, isLoading, error } = useAiModels(ASSISTANT_MODEL_FILTER);
  const options = useMemo(() => models.map(toAssistantModelOption), [models]);
  return { models: options, isLoading, error };
}

/** The adapters `App.tsx` hands the telemetry pages. */
export const appTelemetryAdapters: TelemetryWebAdapters = Object.freeze({
  useAiEnabled,
  useAssistantModels,
  Spinner: LoadingSpinner,
});
