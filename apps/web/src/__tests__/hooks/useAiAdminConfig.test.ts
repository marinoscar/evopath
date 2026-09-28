/**
 * `hooks/useAiAdminConfig.ts` — issue #429, epic #419.
 *
 * What a page test cannot assert:
 *   - `save` sends the loaded version as `If-Match` and adopts the response.
 *   - A plain 409 reloads and explains; it is not reported as a generic error.
 *   - The AI code is read from `details.reason`, not the top-level `code`.
 *   - A failed probe DIAGNOSIS (200, success:false) lands in `testResults`,
 *     while a failed probe CALL lands in `probeError`.
 *   - Writes resolve `true`/`false` and never throw.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../services/ai', async () => {
  const actual = await vi.importActual<typeof import('../../services/ai')>('../../services/ai');
  return {
    ...actual,
    getAiAdminConfig: vi.fn(),
    updateAiAdminConfig: vi.fn(),
    setAiProviderKey: vi.fn(),
    deleteAiProviderKey: vi.fn(),
    testAiProvider: vi.fn(),
  };
});

import {
  deleteAiProviderKey,
  getAiAdminConfig,
  setAiProviderKey,
  testAiProvider,
  updateAiAdminConfig,
} from '../../services/ai';
import type { AiAdminConfigInput } from '../../services/ai';
import { ApiError } from '../../services/api';
import { useAiAdminConfig } from '../../hooks/useAiAdminConfig';
import { toAiErrorInfo } from '../../services/aiErrors';
import {
  mockAiAdminConfig,
  mockAiProbeResultFailed,
  mockAiProbeResultPassed,
} from '../mocks/fixtures/ai';

const mockGet = vi.mocked(getAiAdminConfig);
const mockUpdate = vi.mocked(updateAiAdminConfig);
const mockSetKey = vi.mocked(setAiProviderKey);
const mockDeleteKey = vi.mocked(deleteAiProviderKey);
const mockTest = vi.mocked(testAiProvider);

const input: AiAdminConfigInput = {
  enabled: true,
  keyPolicy: 'byok',
  logPromptContent: false,
  defaults: { allowBackgroundRuns: true },
  providers: { openai: { enabled: true } },
};

async function renderLoaded() {
  const hook = renderHook(() => useAiAdminConfig());
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  return hook;
}

// The hook words errors from `toAiErrorInfo`, the shared reader; these pin
// the three cases the admin page depends on.
describe('toAiErrorInfo, as the admin hooks use it', () => {
  it('reads details.reason before the generic top-level code', () => {
    const err = new ApiError('nope', 400, 'BAD_REQUEST', { reason: 'AI_KEY_INVALID' });
    expect(toAiErrorInfo(err).code).toBe('AI_KEY_INVALID');
  });

  it('falls back to an AI-prefixed top-level code', () => {
    expect(toAiErrorInfo(new ApiError('off', 403, 'AI_DISABLED')).code).toBe('AI_DISABLED');
  });

  it('has no code for a generic error', () => {
    expect(toAiErrorInfo(new ApiError('x', 403, 'FORBIDDEN')).code).toBeNull();
    expect(toAiErrorInfo(new Error('x')).code).toBeNull();
  });
});

describe('useAiAdminConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(mockAiAdminConfig);
  });

  it('loads the configuration', async () => {
    const { result } = await renderLoaded();
    expect(result.current.config).toEqual(mockAiAdminConfig);
    expect(result.current.loadError).toBeNull();
  });

  it('names a 403 on load explicitly', async () => {
    mockGet.mockRejectedValue(new ApiError('Forbidden', 403, 'FORBIDDEN'));
    const { result } = await renderLoaded();
    expect(result.current.loadError).toMatch(/do not have permission/i);
  });

  describe('save', () => {
    it('sends the loaded version as If-Match and adopts the response', async () => {
      const saved = { ...mockAiAdminConfig, enabled: true, version: 4 };
      mockUpdate.mockResolvedValue(saved);
      const { result } = await renderLoaded();

      let ok = false;
      await act(async () => {
        ok = await result.current.save(input);
      });

      expect(ok).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith(input, mockAiAdminConfig.version);
      expect(result.current.config).toEqual(saved);
    });

    it('reloads on a version conflict and says why', async () => {
      mockUpdate.mockRejectedValue(new ApiError('Conflict', 409, 'CONFLICT'));
      const { result } = await renderLoaded();
      mockGet.mockClear();

      let ok = true;
      await act(async () => {
        ok = await result.current.save(input);
      });

      expect(ok).toBe(false);
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result.current.saveError).toMatch(/someone else changed/i);
    });

    it('words AI_KEY_REQUIRED from details.reason', async () => {
      mockUpdate.mockRejectedValue(
        new ApiError('An org key is required for openai', 400, 'BAD_REQUEST', {
          reason: 'AI_KEY_REQUIRED',
        }),
      );
      const { result } = await renderLoaded();

      await act(async () => {
        await result.current.save(input);
      });

      expect(result.current.saveError).toBe('An org key is required for openai');
      expect(result.current.isSaving).toBe(false);
    });

    it.each([
      ['AI_BASE_URL_REQUIRED', /needs an endpoint before it can be enabled/i],
      ['AI_PROVIDER_SETTINGS_INVALID', /https for Azure OpenAI/i],
      ['AI_PROVIDER_FIELD_UNSUPPORTED', /does not accept one of the settings/i],
    ])('words the #448 refusal %s when the API sends no message', async (reason, expected) => {
      mockUpdate.mockRejectedValue(new ApiError('', 400, 'BAD_REQUEST', { reason }));
      const { result } = await renderLoaded();

      await act(async () => {
        await result.current.save(input);
      });

      expect(result.current.saveError).toMatch(expected);
    });
  });

  describe('keys', () => {
    it('setKey adopts the masked configuration and resolves true', async () => {
      const updated = {
        ...mockAiAdminConfig,
        providers: [
          { ...mockAiAdminConfig.providers[0], keyStatus: { ...mockAiAdminConfig.providers[0].keyStatus, hint: '••••new1' } },
        ],
      };
      mockSetKey.mockResolvedValue(updated);
      const { result } = await renderLoaded();

      let ok = false;
      await act(async () => {
        ok = await result.current.setKey('openai', 'sk-test-new-key');
      });

      expect(ok).toBe(true);
      expect(mockSetKey).toHaveBeenCalledWith('openai', 'sk-test-new-key');
      expect(result.current.config).toEqual(updated);
      expect(result.current.keyAction).toBeNull();
    });

    it('setKey reports AI_KEY_INVALID as "nothing was stored"', async () => {
      mockSetKey.mockRejectedValue(
        new ApiError('Invalid key', 400, 'BAD_REQUEST', { reason: 'AI_KEY_INVALID' }),
      );
      const { result } = await renderLoaded();

      let ok = true;
      await act(async () => {
        ok = await result.current.setKey('openai', 'sk-bad-key-123');
      });

      expect(ok).toBe(false);
      expect(result.current.keyError).toEqual({
        provider: 'openai',
        message: expect.stringMatching(/nothing was stored/i),
      });
      // The configuration is untouched.
      expect(result.current.config).toEqual(mockAiAdminConfig);
    });

    it('removeKey strips and exposes warnings', async () => {
      mockDeleteKey.mockResolvedValue({
        ...mockAiAdminConfig,
        warnings: ['ORG_FALLBACK_WITHOUT_KEY'],
      });
      const { result } = await renderLoaded();

      await act(async () => {
        await result.current.removeKey('openai');
      });

      expect(result.current.keyWarnings).toEqual(['ORG_FALLBACK_WITHOUT_KEY']);
      expect(result.current.config).not.toHaveProperty('warnings');
    });
  });

  describe('test', () => {
    it('puts a failed DIAGNOSIS in testResults, not probeError', async () => {
      mockTest.mockResolvedValue(mockAiProbeResultFailed);
      const { result } = await renderLoaded();

      await act(async () => {
        await result.current.test('openai', { apiKey: 'sk-typed-key' });
      });

      expect(mockTest).toHaveBeenCalledWith('openai', { apiKey: 'sk-typed-key' });
      expect(result.current.testResults.openai).toEqual(mockAiProbeResultFailed);
      expect(result.current.probeError).toBeNull();
      expect(result.current.probingProvider).toBeNull();
    });

    it('puts a failed CALL in probeError, with no fabricated result', async () => {
      mockTest.mockRejectedValue(new ApiError('Server error', 500));
      const { result } = await renderLoaded();

      await act(async () => {
        await result.current.test('openai');
      });

      expect(result.current.testResults.openai).toBeUndefined();
      expect(result.current.probeError).toEqual({ provider: 'openai', message: 'Server error' });
    });

    it('a saved key clears the provider’s stale probe result', async () => {
      mockTest.mockResolvedValue(mockAiProbeResultPassed);
      mockSetKey.mockResolvedValue(mockAiAdminConfig);
      const { result } = await renderLoaded();

      await act(async () => {
        await result.current.test('openai');
      });
      expect(result.current.testResults.openai).toBeDefined();

      await act(async () => {
        await result.current.setKey('openai', 'sk-another-key');
      });
      expect(result.current.testResults.openai).toBeUndefined();
    });
  });
});
