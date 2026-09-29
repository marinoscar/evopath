/**
 * `useVisionAvailability` against the MSW network: the four states, and the
 * default selection (saved default model when it is a vision model).
 */
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { mockAiPublicConfigDisabled, mockAiPublicConfigEnabled } from '../mocks/fixtures/ai';
import { mockUserSettings } from '../mocks/data';
import { ThemeContextProvider } from '../../contexts/ThemeContext';
import { useVisionAvailability, visionModels } from '../../hooks/useVisionAvailability';
import type { UsableAiModel } from '../../services/ai';

const wrapper = ({ children }: { children: ReactNode }) => <ThemeContextProvider>{children}</ThemeContextProvider>;

function model(modelId: string, capabilities: string[], inputModalities: string[], keySource: UsableAiModel['keySource'] = 'user'): UsableAiModel {
  return {
    provider: 'openai',
    modelId,
    displayName: modelId.toUpperCase(),
    capabilities: { capabilities, inputModalities, outputModalities: ['text'] },
    keySource,
  };
}

const VISION_A = model('vision-a', ['responses', 'vision_input', 'structured_output'], ['text', 'image']);
const VISION_B = model('vision-b', ['responses', 'vision_input', 'structured_output'], ['text', 'image'], 'org');
const TEXT_ONLY = model('text-only', ['responses', 'structured_output'], ['text']);
const NO_STRUCTURED = model('no-structured', ['responses', 'vision_input'], ['text', 'image']);
const NO_IMAGE_MODALITY = model('no-modality', ['responses', 'vision_input', 'structured_output'], ['text']);

function scenario(options: { enabled: boolean; models: UsableAiModel[]; defaultModel?: { provider: string; modelId: string } }) {
  server.use(
    http.get('*/api/ai/config', () =>
      HttpResponse.json({ data: options.enabled ? mockAiPublicConfigEnabled : mockAiPublicConfigDisabled }),
    ),
    http.get('*/api/ai/models', () => HttpResponse.json({ data: options.models })),
    http.get('*/api/user-settings', () =>
      HttpResponse.json({
        data: { ...mockUserSettings, ...(options.defaultModel ? { ai: { defaultModel: options.defaultModel } } : {}) },
      }),
    ),
  );
}

describe('visionModels', () => {
  it('keeps only models with vision_input AND structured_output AND the image modality', () => {
    expect(visionModels([VISION_A, TEXT_ONLY, NO_STRUCTURED, NO_IMAGE_MODALITY, VISION_B])).toEqual([VISION_A, VISION_B]);
  });
});

describe('useVisionAvailability', () => {
  it('starts loading', () => {
    scenario({ enabled: true, models: [VISION_A] });
    const { result } = renderHook(() => useVisionAvailability(), { wrapper });
    expect(result.current.status).toBe('loading');
  });

  it('is ai_disabled when AI is off', async () => {
    scenario({ enabled: false, models: [VISION_A] });
    const { result } = renderHook(() => useVisionAvailability(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ai_disabled'));
    expect(result.current.models).toEqual([]);
    expect(result.current.selected).toBeNull();
  });

  it('is no_key when the caller has no usable model at all', async () => {
    scenario({ enabled: true, models: [] });
    const { result } = renderHook(() => useVisionAvailability(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('no_key'));
  });

  it('is no_vision_model when models exist but none reads images', async () => {
    scenario({ enabled: true, models: [TEXT_ONLY, NO_STRUCTURED] });
    const { result } = renderHook(() => useVisionAvailability(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('no_vision_model'));
  });

  it('is ready with the first vision model selected when no default is saved', async () => {
    scenario({ enabled: true, models: [TEXT_ONLY, VISION_A, VISION_B] });
    const { result } = renderHook(() => useVisionAvailability(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.models).toEqual([VISION_A, VISION_B]);
    expect(result.current.selected).toEqual(VISION_A);
  });

  it('prefers the saved default model when it is a vision model', async () => {
    scenario({ enabled: true, models: [VISION_A, VISION_B], defaultModel: { provider: 'openai', modelId: 'vision-b' } });
    const { result } = renderHook(() => useVisionAvailability(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.selected).toEqual(VISION_B);
  });

  it('ignores a saved default that cannot read images', async () => {
    scenario({ enabled: true, models: [TEXT_ONLY, VISION_A], defaultModel: { provider: 'openai', modelId: 'text-only' } });
    const { result } = renderHook(() => useVisionAvailability(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.selected).toEqual(VISION_A);
  });

  it('select switches the model', async () => {
    scenario({ enabled: true, models: [VISION_A, VISION_B] });
    const { result } = renderHook(() => useVisionAvailability(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.select('openai', 'vision-b'));
    expect(result.current.selected).toEqual(VISION_B);
  });
});
