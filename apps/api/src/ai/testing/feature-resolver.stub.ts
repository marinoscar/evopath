import type { AiFeatureModelResolver } from '../assignments/ai-feature-model-resolver.service';
import type { FeatureResolution, FeatureResolutionState } from '../assignments/dto/ai-feature-resolution.dto';

/**
 * A stand-in `AiFeatureModelResolver` (#173) whose `resolve` answers every
 * feature with `model` (state `ready`, source `admin_feature`), or with a
 * blocking `state` when `model` is `null`. For services that consult the
 * resolver (the intake analyze route) in tests that do not exercise it.
 */
export function stubFeatureResolver(
  model: { provider: string; modelId: string } | null,
  blockedState: Exclude<FeatureResolutionState, 'ready' | 'auto'> = 'no_models',
): jest.Mocked<Pick<AiFeatureModelResolver, 'resolve'>> {
  return {
    resolve: jest.fn(async (_userId: string, featureId: FeatureResolution['featureId']): Promise<FeatureResolution> => {
      const base = { featureId, needs: [], inputModalities: [], requestedEffort: null, effectiveEffort: null };

      return model
        ? {
            ...base,
            state: 'ready',
            source: 'admin_feature',
            model: { ...model, displayName: model.modelId, keySource: 'user' },
            fix: null,
          }
        : { ...base, state: blockedState, fix: 'admin' };
    }),
  };
}
