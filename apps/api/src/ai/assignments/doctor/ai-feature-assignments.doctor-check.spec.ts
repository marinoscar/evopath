import { DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import { AiConfigService } from '../../config/ai-config.service';
import { AiAssignmentsAdminService } from '../ai-assignments-admin.service';
import { AI_ASSIGNMENT_ISSUES } from '../dto/ai-assignments.dto';
import {
  AiFeatureAssignmentsDoctorCheck,
  decideFeatureAssignments,
  type FeatureAssignmentsFacts,
} from './ai-feature-assignments.doctor-check';
import type { AssignmentsView, FeatureRow } from './effective-assignment';

function expectRemedy(outcome: DoctorCheckOutcome): void {
  expect(['warn', 'fail']).toContain(outcome.status);
  expect(outcome.remedy).toEqual(expect.stringMatching(/\S{10,}/));
}

const gpt = { provider: 'openai', modelId: 'gpt-5', displayName: 'GPT-5', reasoningEfforts: [] };
const gemini = { provider: 'gemini', modelId: 'gemini-2.5', displayName: 'Gemini', reasoningEfforts: [] };

function row(overrides: Partial<FeatureRow> = {}): FeatureRow {
  return {
    featureId: 'gym_scan',
    label: 'Gym equipment scan',
    group: 'photo',
    needs: ['vision_input', 'structured_output'],
    inputModalities: ['image'],
    providers: null,
    requiresWebSearch: false,
    defaultReasoningEffort: null,
    assignment: null,
    eligibleModels: [gpt],
    warning: null,
    ...overrides,
  };
}

function view(features: FeatureRow[], defaultRef: { provider: string; modelId: string } | null = null): AssignmentsView {
  return {
    assignments: { default: defaultRef },
    default: { eligibleModels: [gpt, gemini], warning: null },
    features,
  };
}

function facts(overrides: Partial<FeatureAssignmentsFacts> = {}): FeatureAssignmentsFacts {
  return {
    view: view([row()]),
    keyPolicy: 'byok',
    webSearchEnabled: true,
    reach: { openai: { keyless: false, orgKey: true }, gemini: { keyless: false, orgKey: false } },
    ...overrides,
  };
}

describe('ai.feature-assignments doctor check', () => {
  it('passes and counts each feature by where its model comes from', () => {
    const outcome = decideFeatureAssignments(
      facts({
        view: view(
          [
            row({ featureId: 'gym_scan', assignment: { provider: 'openai', modelId: 'gpt-5' } }),
            row({ featureId: 'workout_prefill' }),
            row({ featureId: 'body_metric_reading', eligibleModels: [gemini] }),
          ],
          { provider: 'openai', modelId: 'gpt-5' },
        ),
      }),
    );

    expect(outcome.status).toBe('pass');
    expect(outcome.detail).toBe('3 feature(s) have a model: 1 assigned, 1 via the default, 1 auto-picked');
    expect(outcome.data).toMatchObject({ assigned: 1, viaDefault: 1, auto: 1, noCapableModel: 0 });
  });

  it('fails a feature no enabled model can serve — every call for it would fail', () => {
    const outcome = decideFeatureAssignments(
      facts({ view: view([row(), row({ featureId: 'training.planner', eligibleModels: [] })]) }),
    );

    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('training.planner');
    expect(outcome.data).toMatchObject({ noCapableModel: 1 });
    expectRemedy(outcome);
  });

  it('truncates a long list of failing features', () => {
    const ids = ['gym_scan', 'workout_prefill', 'body_metric_reading', 'training.planner', 'training.critic'] as const;
    const outcome = decideFeatureAssignments(
      facts({ view: view(ids.map((featureId) => row({ featureId, eligibleModels: [] }))) }),
    );

    expect(outcome.detail).toContain('+2 more');
    expect(outcome.detail).not.toContain('training.critic');
  });

  it('fails under the org-key fallback when no capable model is reachable without a user key', () => {
    const outcome = decideFeatureAssignments(
      facts({ keyPolicy: 'byok_with_org_fallback', view: view([row({ eligibleModels: [gemini] })]) }),
    );

    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('without their own key');
    expect(outcome.data).toMatchObject({ noOrgReachableModel: 1 });
    expectRemedy(outcome);
  });

  it('counts a keyless provider as reachable under the fallback', () => {
    const outcome = decideFeatureAssignments(
      facts({
        keyPolicy: 'byok_with_org_fallback',
        view: view([row({ eligibleModels: [gemini] })]),
        reach: { gemini: { keyless: true, orgKey: false } },
      }),
    );

    expect(outcome.status).toBe('pass');
  });

  it('does not require org keys under plain byok — users bring their own', () => {
    const outcome = decideFeatureAssignments(facts({ view: view([row({ eligibleModels: [gemini] })]) }));

    expect(outcome.status).toBe('pass');
  });

  it('warns when a stored feature assignment no longer qualifies (calls fall through)', () => {
    const outcome = decideFeatureAssignments(
      facts({
        view: view([
          row({
            assignment: { provider: 'openai', modelId: 'gpt-old' },
            warning: { code: AI_ASSIGNMENT_ISSUES.MODEL_DISABLED, message: 'Model openai/gpt-old is not enabled.' },
          }),
        ]),
      }),
    );

    expect(outcome.status).toBe('warn');
    expect(outcome.detail).toContain('gym_scan');
    expect(outcome.data).toMatchObject({ auto: 1, staleAssignments: 1 });
    expectRemedy(outcome);
  });

  it('warns when the stored default no longer qualifies', () => {
    const v = view([row()], { provider: 'openai', modelId: 'gpt-old' });
    v.default.warning = { code: AI_ASSIGNMENT_ISSUES.MODEL_DEPRECATED, message: 'deprecated' };

    const outcome = decideFeatureAssignments(facts({ view: v }));

    expect(outcome.status).toBe('warn');
    expect(outcome.detail).toContain('default');
    expectRemedy(outcome);
  });

  it('does not fail the researcher while web search is off — that is the operator’s choice', () => {
    const outcome = decideFeatureAssignments(
      facts({
        webSearchEnabled: false,
        view: view([
          row(),
          row({ featureId: 'training.researcher', requiresWebSearch: true, eligibleModels: [] }),
        ]),
      }),
    );

    expect(outcome.status).toBe('pass');
    expect(outcome.detail).toContain('training.researcher wait(s) for web search');
    expect(outcome.data).toMatchObject({ waitingOnWebSearch: 1 });
  });

  it('registers itself, depends on ai.enabled and reads key status without material', async () => {
    const describe = jest.fn().mockResolvedValue(view([row({ eligibleModels: [gpt, gemini] })]));
    const hasOrgKey = jest.fn().mockImplementation(async (p: string) => p === 'openai');
    const resolve = jest.fn().mockResolvedValue({
      enabled: true,
      keyPolicy: 'byok_with_org_fallback',
      hostedTools: { web_search: false },
      providers: { openai: { enabled: true }, gemini: { enabled: true } },
    });
    const registry = new DoctorCheckRegistry();
    const check = new AiFeatureAssignmentsDoctorCheck(
      registry,
      { describe } as unknown as AiAssignmentsAdminService,
      { resolve, hasOrgKey } as unknown as AiConfigService,
    );
    check.onModuleInit();

    await expect(check.run()).resolves.toMatchObject({ status: 'pass' });
    expect(hasOrgKey).toHaveBeenCalledWith('openai');
    expect(hasOrgKey).toHaveBeenCalledWith('gemini');
    expect(check.dependsOn).toEqual(['ai.enabled']);
    expect(check.settingsPath).toBe('/admin/settings/ai/assignments');
    expect(registry.get('ai.feature-assignments')).toBe(check);
  });
});
