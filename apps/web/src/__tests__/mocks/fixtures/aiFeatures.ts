/**
 * `GET /api/ai/features` fixtures (#173): each AI feature resolved for the
 * caller from the administrator's assignments.
 */
import type { AiFeatureId, AiFeatureView, AiFeaturesView } from '../../../services/aiAssignments';

const LABELS: Record<AiFeatureId, string> = {
  gym_scan: 'Gym equipment scan',
  workout_prefill: 'Workout prefill from a photo',
  body_metric_reading: 'Body metric photo reading',
  lab_report: 'Lab report reading',
  'training.researcher': 'Training plan researcher',
  'training.planner': 'Training plan planner',
  'training.critic': 'Training plan critic',
  'training.evaluator': 'Training plan evaluator',
  health_summary: 'Health summary for training plans',
};

/** One feature, ready on the `mockUsableAiModels[0]` model (`openai` / `gpt-5-mini`, the caller's key). */
export function mockFeatureView(featureId: AiFeatureId, overrides: Partial<AiFeatureView> = {}): AiFeatureView {
  const summary = featureId === 'health_summary';
  const photo = !summary && !featureId.startsWith('training.');
  return {
    featureId,
    label: LABELS[featureId],
    group: photo ? 'photo' : 'training',
    state: 'ready',
    source: 'admin_feature',
    model: { provider: 'openai', modelId: 'gpt-5-mini', displayName: 'GPT-5 mini', keySource: 'user' },
    needs: photo ? ['vision_input', 'structured_output'] : summary ? ['structured_output'] : ['responses', 'structured_output'],
    inputModalities: photo ? ['image'] : [],
    requestedEffort: photo || summary ? null : 'medium',
    effectiveEffort: photo || summary ? null : 'medium',
    fix: null,
    ...overrides,
  };
}

/** A blocked feature: no model, the given state and fix. */
export function mockBlockedFeatureView(
  featureId: AiFeatureId,
  state: AiFeatureView['state'],
  fix: AiFeatureView['fix'],
): AiFeatureView {
  return mockFeatureView(featureId, { state, fix, model: undefined, source: undefined, effectiveEffort: null });
}

/** Every feature ready. `overrides` replaces the named features. */
export function mockAiFeaturesView(overrides: Partial<Record<AiFeatureId, AiFeatureView>> = {}): AiFeaturesView {
  const ids = Object.keys(LABELS) as AiFeatureId[];
  return { features: ids.map((id) => overrides[id] ?? mockFeatureView(id)) };
}
