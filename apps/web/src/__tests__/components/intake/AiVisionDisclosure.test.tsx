/**
 * `AiVisionDisclosure` and `NoVisionModelNotice` — presentational, fed a
 * `useVisionAvailability` answer directly.
 */
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '../../utils/test-utils';
import { AiVisionDisclosure, NoVisionModelNotice, visionRequestCount } from '../../../components/intake';
import type { UseVisionAvailabilityReturn, VisionAvailabilityStatus } from '../../../hooks/useVisionAvailability';
import type { UsableAiModel } from '../../../services/ai';

function model(modelId: string, displayName: string, keySource: UsableAiModel['keySource'], provider = 'openai'): UsableAiModel {
  return {
    provider,
    modelId,
    displayName,
    capabilities: {
      capabilities: ['responses', 'vision_input', 'structured_output'],
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
    },
    keySource,
  };
}

const MINE = model('gpt-5-mini', 'GPT-5 mini', 'user');
const ORG = model('claude-vision', 'Claude Vision', 'org', 'anthropic');

function availability(
  status: VisionAvailabilityStatus,
  models: UsableAiModel[] = [],
  selected: UsableAiModel | null = models[0] ?? null,
): UseVisionAvailabilityReturn {
  return { status, models, selected, select: vi.fn() };
}

describe('AiVisionDisclosure', () => {
  it('names the provider, the model and "your own key"', () => {
    render(<AiVisionDisclosure availability={availability('ready', [MINE])} photoCount={3} onManual={vi.fn()} />);
    const text = screen.getByTestId('ai-vision-disclosure');
    expect(text).toHaveTextContent('These photos will be sent to openai (GPT-5 mini) using your own key.');
    expect(screen.queryByTestId('ai-vision-request-count')).not.toBeInTheDocument();
    // One model: no picker.
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
  });

  it('says "the organization key" for an org-key model', () => {
    render(<AiVisionDisclosure availability={availability('ready', [ORG])} onManual={vi.fn()} />);
    expect(screen.getByTestId('ai-vision-disclosure')).toHaveTextContent(
      'These photos will be sent to anthropic (Claude Vision) using the organization key.',
    );
  });

  it('shows "N photos in K requests" above 16 photos', () => {
    render(<AiVisionDisclosure availability={availability('ready', [MINE])} photoCount={40} onManual={vi.fn()} />);
    expect(screen.getByTestId('ai-vision-request-count')).toHaveTextContent('40 photos in 3 requests.');
  });

  it('does not show the request count at exactly 16 photos', () => {
    render(<AiVisionDisclosure availability={availability('ready', [MINE])} photoCount={16} onManual={vi.fn()} />);
    expect(screen.queryByTestId('ai-vision-request-count')).not.toBeInTheDocument();
  });

  it('offers a model picker with more than one vision model and reports the choice', async () => {
    const user = userEvent.setup();
    const value = availability('ready', [MINE, ORG]);
    render(<AiVisionDisclosure availability={value} onManual={vi.fn()} />);
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await user.click(await screen.findByRole('option', { name: /Claude Vision/ }));
    expect(value.select).toHaveBeenCalledWith('anthropic', 'claude-vision');
  });

  it.each<[VisionAvailabilityStatus, RegExp]>([
    ['ai_disabled', /AI is turned off for this app/],
    ['no_key', /Add your own AI key in Settings → AI/],
    ['no_vision_model', /None of your available models can read images/],
  ])('renders the notice for %s', (status, copy) => {
    render(<AiVisionDisclosure availability={availability(status)} onManual={vi.fn()} />);
    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue manually' })).toBeInTheDocument();
    expect(screen.queryByTestId('ai-vision-disclosure')).not.toBeInTheDocument();
  });
});

describe('NoVisionModelNotice', () => {
  it.each(['loading', 'ai_disabled', 'no_key', 'no_vision_model'] as const)(
    'always offers Continue manually (%s)',
    async (reason) => {
      const user = userEvent.setup();
      const onManual = vi.fn();
      render(<NoVisionModelNotice reason={reason} onManual={onManual} />);
      await user.click(screen.getByRole('button', { name: 'Continue manually' }));
      expect(onManual).toHaveBeenCalledTimes(1);
    },
  );

  it('links to /settings/ai where a key would help, and not when AI is off', () => {
    const { unmount } = render(<NoVisionModelNotice reason="no_key" onManual={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Open AI settings' })).toHaveAttribute('href', '/settings/ai');
    unmount();

    render(<NoVisionModelNotice reason="ai_disabled" onManual={vi.fn()} />);
    expect(screen.queryByRole('link', { name: 'Open AI settings' })).not.toBeInTheDocument();
  });
});

describe('visionRequestCount', () => {
  it('batches 16 photos per request', () => {
    expect(visionRequestCount(1)).toBe(1);
    expect(visionRequestCount(16)).toBe(1);
    expect(visionRequestCount(17)).toBe(2);
    expect(visionRequestCount(48)).toBe(3);
  });
});
