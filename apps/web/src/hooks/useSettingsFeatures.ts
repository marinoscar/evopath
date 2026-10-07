/**
 * The complete deployment feature map the registries read
 * (`visibleSettingsSections`, `settingsPageTitle`, `isDestinationVisible`) —
 * issue #537, epic #528.
 *
 * One hook so every navigation surface asks for the SAME map: `ai` from
 * `useAiFeatures()` (#425) and `telemetry` from `useTelemetryFeatures()`. Both
 * read the shell's providers only and never fetch, so without a provider
 * every feature answers "off" — fail closed, no network side effects.
 */
import { useMemo } from 'react';
import type { SettingsFeatures } from '../config/adminSections';
import { useAiFeatures } from './useAiConfig';
import { useTelemetryFeatures } from '@marinoscar/platform-web/telemetry/headless';

export interface SettingsFeatureFlags extends SettingsFeatures {
  ai: boolean;
  telemetry: boolean;
}

export function useSettingsFeatures(): SettingsFeatureFlags {
  const { ai } = useAiFeatures();
  const { telemetry } = useTelemetryFeatures();
  return useMemo(() => ({ ai, telemetry }), [ai, telemetry]);
}
