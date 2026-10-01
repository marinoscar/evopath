import type { AiCapability, AiInputModality } from '../core/capabilities';
import type { UsableAiModel } from '../keys/dto/usable-ai-model.dto';
import {
  AI_FEATURE_IDS,
  EMPTY_AI_ASSIGNMENTS,
  type SystemAiAssignmentsValue,
  TRAINING_AGENT_ROLES,
} from '../../common/schemas/settings.schema';
import { TRAINING_ROLE_NEEDS } from '../../training-agents/models/training-role-defaults';
import { type FeatureResolutionFacts, resolveFeature } from './ai-feature-resolution';
import { AI_FEATURES, featureShortfall, listAiFeatures, trainingFeatureId } from './ai-features';

// The feature resolver (#173) over crafted facts: the registry, the
// precedence (admin feature -> admin default -> auto -> blocking), the
// fall-through of an unusable assignment, and no_key vs no_models.

const VISION: AiCapability[] = ['responses', 'structured_output', 'vision_input'];

function model(
  modelId: string,
  capabilities: AiCapability[],
  opts: { provider?: string; inputModalities?: AiInputModality[]; keySource?: UsableAiModel['keySource'] } = {},
): UsableAiModel {
  return {
    provider: opts.provider ?? 'openai',
    modelId,
    displayName: null,
    keySource: opts.keySource ?? 'user',
    capabilities: {
      capabilities,
      inputModalities: opts.inputModalities ?? ['text', 'image'],
      outputModalities: ['text'],
    },
  };
}

function facts(over: Partial<FeatureResolutionFacts> = {}): FeatureResolutionFacts {
  return {
    aiEnabled: true,
    webSearchEnabled: true,
    usable: [],
    hasAnyKeySource: true,
    providerSupports: () => true,
    catalog: [],
    assignments: EMPTY_AI_ASSIGNMENTS,
    ...over,
  };
}

const ref = (modelId: string, provider = 'openai') => ({ provider, modelId });
const assign = (
  features: SystemAiAssignmentsValue['features'],
  defaultModel: SystemAiAssignmentsValue['default'] = null,
): SystemAiAssignmentsValue => ({ default: defaultModel, features });

const visionA = model('vision-a', VISION);
const visionB = model('vision-b', VISION);
const textOnly = model('text-only', ['responses', 'structured_output'], { inputModalities: ['text'] });
/** Declares vision_input but accepts no image input: not a photo model. */
const noImage = model('no-image', VISION, { inputModalities: ['text'] });

describe('AI feature registry', () => {
  it('defines every AI_FEATURE_IDS entry, in order', () => {
    expect(listAiFeatures().map((f) => f.id)).toEqual([...AI_FEATURE_IDS]);
  });

  it('photo features need vision_input + structured_output and image input, with no effort', () => {
    for (const id of ['gym_scan', 'workout_prefill', 'body_metric_reading', 'lab_report'] as const) {
      expect(AI_FEATURES[id]).toMatchObject({
        group: 'photo',
        needs: ['vision_input', 'structured_output'],
        inputModalities: ['image'],
        providers: null,
        defaultEffort: null,
      });
    }
  });

  it('training features are derived from the role tables', () => {
    for (const role of TRAINING_AGENT_ROLES) {
      const feature = AI_FEATURES[trainingFeatureId(role)];
      expect(feature.needs).toBe(TRAINING_ROLE_NEEDS[role]);
      expect(feature.trainingRole).toBe(role);
      expect(feature.defaultEffort).not.toBeNull();
    }
    expect(AI_FEATURES['training.researcher']).toMatchObject({ providers: ['openai'], requiresWebSearch: true });
  });

  it('featureShortfall names capabilities, modalities and provider restrictions', () => {
    const supports = () => true;
    expect(featureShortfall(AI_FEATURES.gym_scan, { provider: 'openai', capabilities: ['responses'], inputModalities: ['text'] }, supports)).toEqual([
      'vision_input',
      'structured_output',
      'input:image',
    ]);
    expect(
      featureShortfall(AI_FEATURES['training.researcher'], { provider: 'anthropic', capabilities: ['responses', 'structured_output', 'hosted_tools'] }, supports),
    ).toEqual(['provider:anthropic']);
    expect(
      featureShortfall(AI_FEATURES.gym_scan, { provider: 'openai', capabilities: VISION, inputModalities: ['image'] }, (_p, cap) => cap !== 'vision_input'),
    ).toEqual(['vision_input']);
  });
});

describe('resolveFeature — precedence', () => {
  it('admin feature assignment wins over the default and the auto pick', () => {
    const r = resolveFeature('gym_scan', facts({ usable: [visionA, visionB], assignments: assign({ gym_scan: ref('vision-b') }, ref('vision-a')) }));

    expect(r).toMatchObject({ state: 'ready', source: 'admin_feature', model: { modelId: 'vision-b', displayName: 'vision-b' }, fix: null });
    expect(r.assignmentUnavailable).toBeUndefined();
  });

  it('admin default when the feature is unassigned', () => {
    expect(resolveFeature('gym_scan', facts({ usable: [visionA, visionB], assignments: assign({}, ref('vision-b')) }))).toMatchObject({
      state: 'ready',
      source: 'admin_default',
      model: { modelId: 'vision-b' },
    });
  });

  it('auto pick when nothing is assigned', () => {
    expect(resolveFeature('gym_scan', facts({ usable: [textOnly, visionB, visionA] }))).toMatchObject({
      state: 'auto',
      source: 'auto',
      model: { modelId: 'vision-a' },
    });
  });

  it('a default that cannot serve the feature is skipped without a flag (it need not satisfy every feature)', () => {
    const r = resolveFeature('gym_scan', facts({ usable: [textOnly, visionA], assignments: assign({}, ref('text-only')) }));

    expect(r).toMatchObject({ state: 'auto', model: { modelId: 'vision-a' } });
    expect(r.assignmentUnavailable).toBeUndefined();
  });

  it('a feature assignment the caller cannot use falls through and is flagged', () => {
    expect(
      resolveFeature('gym_scan', facts({ usable: [visionA, visionB], assignments: assign({ gym_scan: ref('not-reachable') }, ref('vision-b')) })),
    ).toMatchObject({ state: 'ready', source: 'admin_default', model: { modelId: 'vision-b' }, assignmentUnavailable: ref('not-reachable') });

    expect(resolveFeature('gym_scan', facts({ usable: [visionA], assignments: assign({ gym_scan: ref('not-reachable') }) }))).toMatchObject({
      state: 'auto',
      model: { modelId: 'vision-a' },
      assignmentUnavailable: ref('not-reachable'),
    });
  });

  it('a feature assignment that is usable but incapable (no image input) falls through too', () => {
    expect(resolveFeature('gym_scan', facts({ usable: [noImage, visionA], assignments: assign({ gym_scan: ref('no-image') }) }))).toMatchObject({
      state: 'auto',
      model: { modelId: 'vision-a' },
      assignmentUnavailable: ref('no-image'),
    });
  });

  it('an assignment for one feature does not leak into another', () => {
    expect(
      resolveFeature('workout_prefill', facts({ usable: [visionA, visionB], assignments: assign({ gym_scan: ref('vision-b') }) })),
    ).toMatchObject({ state: 'auto', model: { modelId: 'vision-a' } });
  });

  it('carries the key source and never a key', () => {
    const org = model('org-vision', VISION, { keySource: 'org' });
    expect(resolveFeature('body_metric_reading', facts({ usable: [org] })).model).toEqual({
      provider: 'openai',
      modelId: 'org-vision',
      displayName: 'org-vision',
      keySource: 'org',
    });
  });

  it('photo features carry no effort', () => {
    expect(resolveFeature('gym_scan', facts({ usable: [visionA] }))).toMatchObject({ requestedEffort: null, effectiveEffort: null });
  });
});

describe('resolveFeature — blocking states', () => {
  it('ai_disabled when the kill switch is off', () => {
    expect(resolveFeature('gym_scan', facts({ aiEnabled: false, usable: [visionA] }))).toMatchObject({ state: 'ai_disabled', fix: 'admin' });
  });

  it('no_key when the caller has no key source at all', () => {
    expect(resolveFeature('gym_scan', facts({ hasAnyKeySource: false }))).toMatchObject({ state: 'no_key', fix: 'keys' });
  });

  it('no_models when a key source exists but nothing is usable (not "add a key")', () => {
    expect(resolveFeature('gym_scan', facts({ hasAnyKeySource: true }))).toMatchObject({ state: 'no_models', fix: 'admin' });
  });

  it('missing_capability when usable models cannot serve the feature, listing catalog candidates', () => {
    const r = resolveFeature(
      'gym_scan',
      facts({
        usable: [textOnly],
        catalog: [
          { provider: 'openai', modelId: 'vision-off', displayName: null, capabilities: VISION, inputModalities: ['image'], enabled: false },
          { provider: 'openai', modelId: 'no-image', displayName: null, capabilities: VISION, inputModalities: ['text'], enabled: true },
        ],
      }),
    );

    expect(r).toMatchObject({ state: 'missing_capability', fix: 'admin', candidates: [{ modelId: 'vision-off', enabled: false }] });
  });

  it('an unusable assignment with nothing to fall back to still names it', () => {
    expect(resolveFeature('gym_scan', facts({ hasAnyKeySource: false, assignments: assign({ gym_scan: ref('gone') }) }))).toMatchObject({
      state: 'no_key',
      assignmentUnavailable: ref('gone'),
    });
  });
});
