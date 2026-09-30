import { DoctorCheckOutcome } from '../../../doctor/doctor-check.interface';
import { DoctorCheckRegistry } from '../../../doctor/doctor-check.registry';
import { AiConfigAdminService } from '../ai-config-admin.service';
import { AiConfigService } from '../ai-config.service';
import { AiAdminProvider } from '../dto/ai-config-response.dto';
import { AiEnabledDoctorCheck } from './ai-enabled.doctor-check';
import { AiProvidersDoctorCheck, decideAiProviders } from './ai-providers.doctor-check';

function expectRemedy(outcome: DoctorCheckOutcome): void {
  expect(['warn', 'fail']).toContain(outcome.status);
  expect(outcome.remedy).toEqual(expect.stringMatching(/\S{10,}/));
}

function provider(overrides: Partial<AiAdminProvider> = {}): AiAdminProvider {
  return {
    id: 'openai',
    displayName: 'OpenAI',
    registered: true,
    enabled: true,
    baseUrl: null,
    settingsFields: [],
    apiVersion: null,
    apiStyle: null,
    deployments: null,
    requiresKey: null,
    keyStatus: { configured: true, hint: '••••abcd', updatedAt: null, updatedByUserId: null },
    supportedCapabilities: [],
    ...overrides,
  };
}

const noKey = { configured: false, hint: null, updatedAt: null, updatedByUserId: null };

describe('ai doctor checks', () => {
  describe('ai.enabled', () => {
    const make = (enabled: boolean) =>
      new AiEnabledDoctorCheck(new DoctorCheckRegistry(), {
        resolve: jest.fn().mockResolvedValue({ enabled, keyPolicy: 'byok' }),
      } as unknown as AiConfigService);

    it('is skip — an intentional choice, not a problem — when AI is off', async () => {
      const outcome = await make(false).run();

      expect(outcome).toMatchObject({ status: 'skip', detail: 'AI is switched off' });
      expect(outcome.remedy).toBeUndefined();
    });

    it('passes when AI is on', async () => {
      await expect(make(true).run()).resolves.toMatchObject({ status: 'pass' });
    });
  });

  describe('ai.providers', () => {
    it('fails when no provider is enabled', () => {
      const outcome = decideAiProviders({ keyPolicy: 'byok', providers: [provider({ enabled: false })] });
      expect(outcome.status).toBe('fail');
      expectRemedy(outcome);
    });

    it('fails an enabled provider with no adapter', () => {
      const outcome = decideAiProviders({ keyPolicy: 'byok', providers: [provider({ registered: false })] });
      expect(outcome.detail).toContain('no adapter');
      expectRemedy(outcome);
    });

    it('fails a missing org key when the policy promises an org-key fallback', () => {
      const outcome = decideAiProviders({
        keyPolicy: 'byok_with_org_fallback',
        providers: [provider({ keyStatus: noKey })],
      });
      expect(outcome.status).toBe('fail');
      expectRemedy(outcome);
    });

    it('passes a missing org key under plain byok — users bring their own', () => {
      const outcome = decideAiProviders({ keyPolicy: 'byok', providers: [provider({ keyStatus: noKey })] });
      expect(outcome).toMatchObject({ status: 'pass', detail: "Enabled: OpenAI (users' own keys)" });
    });

    it('passes a keyless provider under the fallback policy', () => {
      const outcome = decideAiProviders({
        keyPolicy: 'byok_with_org_fallback',
        providers: [provider({ requiresKey: false, keyStatus: noKey })],
      });
      expect(outcome.status).toBe('pass');
    });

    it('never reports a key hint', () => {
      expect(JSON.stringify(decideAiProviders({ keyPolicy: 'byok', providers: [provider()] }))).not.toContain('abcd');
    });

    it('depends on ai.enabled and reads the admin view', async () => {
      const describeForAdmin = jest.fn().mockResolvedValue({ keyPolicy: 'byok', providers: [provider()] });
      const registry = new DoctorCheckRegistry();
      const check = new AiProvidersDoctorCheck(registry, { describeForAdmin } as unknown as AiConfigAdminService);
      check.onModuleInit();

      await expect(check.run()).resolves.toMatchObject({ status: 'pass' });
      expect(check.dependsOn).toEqual(['ai.enabled']);
      expect(registry.get('ai.providers')).toBe(check);
    });
  });
});
