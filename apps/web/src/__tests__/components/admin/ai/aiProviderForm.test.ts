/**
 * The admin provider card's form model (issue #448, epic #421): the value a
 * provider loads as, the client-side validation that mirrors the API, and the
 * `PUT` entry — which must carry ONLY the provider's `settingsFields`.
 */
import { describe, it, expect } from 'vitest';
import {
  toProviderFormValue,
  toProviderInput,
  validateProviderForm,
  hasProviderFormErrors,
} from '../../../../components/admin/ai/aiProviderForm';
import type { AiProviderFormValue } from '../../../../components/admin/ai/aiProviderForm';
import { aiAdminConfigToInput } from '../../../../services/ai';
import type { AiAdminProvider } from '../../../../services/ai';
import { mockAiAdminConfig, mockAiAdminConfigWithCompatible } from '../../../mocks/fixtures/ai';

const [openai, azure, compatible] = mockAiAdminConfigWithCompatible.providers as [
  AiAdminProvider,
  AiAdminProvider,
  AiAdminProvider,
];

function value(overrides: Partial<AiProviderFormValue> = {}): AiProviderFormValue {
  return {
    enabled: false,
    baseUrl: '',
    apiVersion: '',
    apiStyle: '',
    deployments: [],
    requiresKey: true,
    ...overrides,
  };
}

describe('aiProviderForm', () => {
  describe('toProviderFormValue', () => {
    it('loads nulls as blanks, deployments as rows, and requiresKey as on', () => {
      expect(toProviderFormValue(azure)).toEqual({
        enabled: true,
        baseUrl: 'https://contoso.openai.azure.com',
        apiVersion: '2024-10-21',
        apiStyle: '',
        deployments: [{ modelId: 'gpt-4o', deployment: 'contoso-gpt-4o' }],
        requiresKey: true,
      });
      expect(toProviderFormValue({ ...compatible, requiresKey: false }).requiresKey).toBe(false);
    });
  });

  describe('toProviderInput', () => {
    it('openai keeps the pre-#448 body exactly: { enabled, baseUrl }', () => {
      expect(toProviderInput(openai, value({ enabled: true, apiVersion: 'x', requiresKey: false }))).toEqual({
        enabled: true,
        baseUrl: null,
      });
    });

    it('an API older than #448 (no settingsFields) is treated as baseUrl only', () => {
      const legacy = { ...openai, settingsFields: undefined };
      expect(toProviderInput(legacy, value({ baseUrl: ' https://gw.example.com/v1 ' }))).toEqual({
        enabled: false,
        baseUrl: 'https://gw.example.com/v1',
      });
    });

    it('azure sends its own fields, blanks omitted and empty deployment rows dropped', () => {
      expect(
        toProviderInput(
          azure,
          value({
            enabled: true,
            baseUrl: 'https://contoso.openai.azure.com',
            apiVersion: ' 2024-10-21 ',
            apiStyle: 'chat_completions',
            deployments: [
              { modelId: 'gpt-4o', deployment: 'contoso-gpt-4o' },
              { modelId: '', deployment: '' },
            ],
            requiresKey: false, // not an Azure field: never sent
          }),
        ),
      ).toEqual({
        enabled: true,
        baseUrl: 'https://contoso.openai.azure.com',
        apiVersion: '2024-10-21',
        apiStyle: 'chat_completions',
        deployments: { 'gpt-4o': 'contoso-gpt-4o' },
      });
      expect(toProviderInput(azure, value())).toEqual({ enabled: false, baseUrl: null });
    });

    it('openai-compatible sends apiStyle only when chosen, and requiresKey always', () => {
      expect(
        toProviderInput(
          compatible,
          value({ enabled: true, baseUrl: 'http://ollama:11434/v1', apiVersion: '2024-10-21', requiresKey: false }),
        ),
      ).toEqual({ enabled: true, baseUrl: 'http://ollama:11434/v1', requiresKey: false });
    });

    it('aiAdminConfigToInput re-sends each provider with only its own fields', () => {
      expect(aiAdminConfigToInput(mockAiAdminConfigWithCompatible).providers).toEqual({
        openai: { enabled: false, baseUrl: null },
        'azure-openai': {
          enabled: true,
          baseUrl: 'https://contoso.openai.azure.com',
          apiVersion: '2024-10-21',
          deployments: { 'gpt-4o': 'contoso-gpt-4o' },
        },
        'openai-compatible': { enabled: false, baseUrl: null },
      });
      expect(aiAdminConfigToInput(mockAiAdminConfig).providers).toEqual({
        openai: { enabled: false, baseUrl: null },
      });
    });
  });

  describe('validateProviderForm', () => {
    it('accepts a clean provider', () => {
      expect(hasProviderFormErrors(validateProviderForm(azure, toProviderFormValue(azure)))).toBe(false);
      expect(hasProviderFormErrors(validateProviderForm(compatible, toProviderFormValue(compatible)))).toBe(false);
    });

    it('requires an endpoint to enable azure-openai or openai-compatible, not openai', () => {
      expect(validateProviderForm(azure, value({ enabled: true })).baseUrl).toMatch(/endpoint is required/i);
      expect(validateProviderForm(compatible, value({ enabled: true })).baseUrl).toMatch(/base url is required/i);
      expect(validateProviderForm(openai, value({ enabled: true })).baseUrl).toBeUndefined();
    });

    it('Azure endpoints must be https; a compatible server may be http', () => {
      expect(validateProviderForm(azure, value({ baseUrl: 'http://contoso.openai.azure.com' })).baseUrl).toMatch(
        /https/,
      );
      expect(validateProviderForm(compatible, value({ baseUrl: 'http://ollama:11434/v1' })).baseUrl).toBeUndefined();
    });

    it('refuses credentials and a fragment in the URL', () => {
      expect(validateProviderForm(compatible, value({ baseUrl: 'http://me:pw@ollama:11434/v1' })).baseUrl).toMatch(
        /user name and password/i,
      );
      expect(validateProviderForm(compatible, value({ baseUrl: 'http://ollama:11434/v1#x' })).baseUrl).toMatch(
        /fragment/i,
      );
      expect(validateProviderForm(openai, value({ baseUrl: 'not a url' })).baseUrl).toMatch(/must be a full url/i);
    });

    it('checks the api-version and deployment names against the API pattern', () => {
      expect(validateProviderForm(azure, value({ apiVersion: '2024 10 21' })).apiVersion).toBeDefined();
      expect(validateProviderForm(azure, value({ apiVersion: '-preview' })).apiVersion).toBeDefined();
      expect(validateProviderForm(azure, value({ apiVersion: 'preview' })).apiVersion).toBeUndefined();

      const errors = validateProviderForm(
        azure,
        value({
          deployments: [
            { modelId: 'gpt-4o', deployment: 'bad name' },
            { modelId: '', deployment: 'orphan' },
            { modelId: 'gpt-4o', deployment: 'dup' },
          ],
        }),
      );
      expect(errors.deploymentRows?.[0]?.deployment).toMatch(/letters, digits/i);
      expect(errors.deploymentRows?.[1]?.modelId).toMatch(/enter the model id/i);
      expect(errors.deploymentRows?.[2]?.modelId).toMatch(/already mapped/i);
      expect(errors.deployments).toMatch(/more than once/);
    });

    it('caps deployments at 200', () => {
      const rows = Array.from({ length: 201 }, (_, i) => ({ modelId: `m${i}`, deployment: `d${i}` }));
      expect(validateProviderForm(azure, value({ deployments: rows })).deployments).toMatch(/at most 200/i);
      expect(validateProviderForm(azure, value({ deployments: rows.slice(0, 200) })).deployments).toBeUndefined();
    });

    it('only validates fields the provider renders', () => {
      // openai has no apiVersion field, so a stale value there is never an error.
      expect(validateProviderForm(openai, value({ apiVersion: 'bad version' }))).toEqual({});
    });
  });
});
