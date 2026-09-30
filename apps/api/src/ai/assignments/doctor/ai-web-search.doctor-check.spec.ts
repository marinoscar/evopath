import { DoctorCheckOutcome } from '../../../doctor/doctor-check.interface';
import { DoctorCheckRegistry } from '../../../doctor/doctor-check.registry';
import { AiConfigService } from '../../config/ai-config.service';
import { AiProviderRegistry } from '../../core/provider-registry';
import { AiAssignmentsAdminService } from '../ai-assignments-admin.service';
import { AI_ASSIGNMENT_ISSUES } from '../dto/ai-assignments.dto';
import { AiWebSearchDoctorCheck, decideWebSearch } from './ai-web-search.doctor-check';
import type { AssignmentsView, FeatureRow } from './effective-assignment';

function expectRemedy(outcome: DoctorCheckOutcome): void {
  expect(['warn', 'fail']).toContain(outcome.status);
  expect(outcome.remedy).toEqual(expect.stringMatching(/\S{10,}/));
}

const gpt = { provider: 'openai', modelId: 'gpt-5', displayName: 'GPT-5', reasoningEfforts: [] };

function researcher(overrides: Partial<FeatureRow> = {}): FeatureRow {
  return {
    featureId: 'training.researcher',
    label: 'Training plan researcher',
    group: 'training',
    needs: ['responses', 'structured_output', 'hosted_tools'],
    inputModalities: [],
    providers: ['openai'],
    requiresWebSearch: true,
    defaultReasoningEffort: 'medium',
    assignment: null,
    eligibleModels: [gpt],
    warning: null,
    ...overrides,
  };
}

function view(features: FeatureRow[]): AssignmentsView {
  return { assignments: { default: null }, default: { eligibleModels: [], warning: null }, features };
}

describe('ai.web-search doctor check', () => {
  it('is skip — intentional, no remedy — when web search is off', () => {
    const outcome = decideWebSearch({ webSearchEnabled: false, hostedToolProviders: [], view: null });

    expect(outcome).toMatchObject({ status: 'skip', detail: 'Web search is off' });
    expect(outcome.remedy).toBeUndefined();
  });

  it('passes when the researcher is assigned a model that can search', () => {
    const outcome = decideWebSearch({
      webSearchEnabled: true,
      hostedToolProviders: ['openai'],
      view: view([researcher({ assignment: { provider: 'openai', modelId: 'gpt-5' } })]),
    });

    expect(outcome.status).toBe('pass');
    expect(outcome.detail).toContain('Training plan researcher on openai/gpt-5');
  });

  it('passes an auto pick among eligible models', () => {
    const outcome = decideWebSearch({
      webSearchEnabled: true,
      hostedToolProviders: ['openai'],
      view: view([researcher()]),
    });

    expect(outcome).toMatchObject({ status: 'pass' });
    expect(outcome.detail).toContain('auto-picks among openai');
  });

  it('warns when no enabled provider drives hosted tools', () => {
    const outcome = decideWebSearch({
      webSearchEnabled: true,
      hostedToolProviders: [],
      view: view([researcher({ eligibleModels: [] })]),
    });

    expect(outcome.status).toBe('warn');
    expect(outcome.detail).toContain('no enabled provider supports hosted web search');
    expectRemedy(outcome);
  });

  it('warns when the researcher has no eligible model', () => {
    const outcome = decideWebSearch({
      webSearchEnabled: true,
      hostedToolProviders: ['openai'],
      view: view([researcher({ eligibleModels: [] })]),
    });

    expect(outcome.status).toBe('warn');
    expect(outcome.detail).toContain('no enabled model (openai) with hosted tools');
    expectRemedy(outcome);
  });

  it('warns when the assigned researcher model cannot search', () => {
    const outcome = decideWebSearch({
      webSearchEnabled: true,
      hostedToolProviders: ['openai'],
      view: view([
        researcher({
          assignment: { provider: 'openai', modelId: 'gpt-4o-mini' },
          warning: { code: AI_ASSIGNMENT_ISSUES.MODEL_INCAPABLE, message: 'x', missing: ['hosted_tools'] },
        }),
      ]),
    });

    expect(outcome.status).toBe('warn');
    expect(outcome.detail).toContain('openai/gpt-4o-mini cannot search');
    expectRemedy(outcome);
  });

  it('registers itself, depends on ai.enabled, and reads no assignments while off', async () => {
    const describe = jest.fn();
    const registry = new DoctorCheckRegistry();
    const check = new AiWebSearchDoctorCheck(
      registry,
      { resolve: jest.fn().mockResolvedValue({ hostedTools: { web_search: false } }) } as unknown as AiConfigService,
      {} as AiProviderRegistry,
      { describe } as unknown as AiAssignmentsAdminService,
    );
    check.onModuleInit();

    await expect(check.run()).resolves.toMatchObject({ status: 'skip' });
    expect(describe).not.toHaveBeenCalled();
    expect(check.dependsOn).toEqual(['ai.enabled']);
    expect(registry.get('ai.web-search')).toBe(check);
  });

  it('when on, lists only enabled providers whose adapter supports hosted tools', async () => {
    const supports = jest.fn((id: string) => id === 'openai' || id === 'gemini');
    const check = new AiWebSearchDoctorCheck(
      new DoctorCheckRegistry(),
      {
        resolve: jest.fn().mockResolvedValue({
          hostedTools: { web_search: true },
          providers: { openai: { enabled: true }, gemini: { enabled: false }, anthropic: { enabled: true } },
        }),
      } as unknown as AiConfigService,
      { ids: () => ['openai', 'gemini', 'anthropic'], supports } as unknown as AiProviderRegistry,
      { describe: jest.fn().mockResolvedValue(view([researcher()])) } as unknown as AiAssignmentsAdminService,
    );

    const outcome = await check.run();

    expect(outcome.status).toBe('pass');
    expect(outcome.data).toMatchObject({ hostedToolProviders: 1 });
  });
});
