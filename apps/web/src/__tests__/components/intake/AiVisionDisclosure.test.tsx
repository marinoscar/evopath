/**
 * `AiVisionDisclosure` and `NoVisionModelNotice` — presentational, fed a
 * `useVisionAvailability` answer directly (#173: read-only, the server
 * chooses the model).
 */
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, mockAdminUser } from '../../utils/test-utils';
import { AiVisionDisclosure, NoVisionModelNotice, visionRequestCount } from '../../../components/intake';
import type {
  UseVisionAvailabilityReturn,
  VisionAvailabilityStatus,
  VisionModel,
} from '../../../hooks/useVisionAvailability';

const MINE: VisionModel = { provider: 'openai', modelId: 'gpt-5-mini', displayName: 'GPT-5 mini', keySource: 'user' };
const ORG: VisionModel = { provider: 'anthropic', modelId: 'claude-vision', displayName: 'Claude Vision', keySource: 'org' };

function availability(
  status: VisionAvailabilityStatus,
  model: VisionModel | null = status === 'ready' ? MINE : null,
  extra: Partial<UseVisionAvailabilityReturn> = {},
): UseVisionAvailabilityReturn {
  return {
    featureId: 'gym_scan',
    status,
    model,
    source: status === 'ready' ? 'admin_feature' : null,
    fix: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    ...extra,
  };
}

describe('AiVisionDisclosure', () => {
  it('names the provider, the model and "your own key", read-only', () => {
    render(<AiVisionDisclosure availability={availability('ready')} photoCount={3} onManual={vi.fn()} />);
    const text = screen.getByTestId('ai-vision-disclosure');
    expect(text).toHaveTextContent('These photos will be sent to openai (GPT-5 mini) using your own key.');
    expect(screen.getByTestId('ai-vision-model-source')).toHaveTextContent('Chosen by your administrator.');
    expect(screen.queryByTestId('ai-vision-request-count')).not.toBeInTheDocument();
    // No picker: users never choose a model.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('says "the organization key" for an org-key model', () => {
    render(<AiVisionDisclosure availability={availability('ready', ORG)} onManual={vi.fn()} />);
    expect(screen.getByTestId('ai-vision-disclosure')).toHaveTextContent(
      'These photos will be sent to anthropic (Claude Vision) using the organization key.',
    );
  });

  it('notes when the model was chosen automatically', () => {
    render(<AiVisionDisclosure availability={availability('ready', MINE, { source: 'auto' })} onManual={vi.fn()} />);
    expect(screen.getByTestId('ai-vision-model-source')).toHaveTextContent(/Chosen automatically/);
  });

  it('shows "N photos in K requests" above 16 photos', () => {
    render(<AiVisionDisclosure availability={availability('ready')} photoCount={40} onManual={vi.fn()} />);
    expect(screen.getByTestId('ai-vision-request-count')).toHaveTextContent('40 photos in 3 requests.');
  });

  it('does not show the request count at exactly 16 photos', () => {
    render(<AiVisionDisclosure availability={availability('ready')} photoCount={16} onManual={vi.fn()} />);
    expect(screen.queryByTestId('ai-vision-request-count')).not.toBeInTheDocument();
  });

  it.each<[VisionAvailabilityStatus, UseVisionAvailabilityReturn['fix'], RegExp]>([
    ['ai_disabled', 'admin', /AI is turned off for this app/],
    ['no_key', 'keys', /Add your own AI key in Settings → AI Keys/],
    ['no_models', 'admin', /Your administrator hasn't assigned an AI model that can read photos yet/],
    ['missing_capability', 'admin', /Your administrator hasn't assigned an AI model that can read photos yet/],
    ['missing_capability', 'keys', /None of the AI models your keys reach can read photos/],
    ['error', null, /Couldn't check AI availability/],
  ])('renders the notice for %s (fix %s)', (status, fix, copy) => {
    render(<AiVisionDisclosure availability={availability(status, null, { fix })} onManual={vi.fn()} />);
    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue manually' })).toBeInTheDocument();
    expect(screen.queryByTestId('ai-vision-disclosure')).not.toBeInTheDocument();
  });

  it('retries the check from the error notice', async () => {
    const user = userEvent.setup();
    const value = availability('error');
    render(<AiVisionDisclosure availability={value} onManual={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(value.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('NoVisionModelNotice', () => {
  it.each(['loading', 'ai_disabled', 'no_key', 'no_models', 'missing_capability', 'error'] as const)(
    'always offers Continue manually (%s)',
    async (reason) => {
      const user = userEvent.setup();
      const onManual = vi.fn();
      render(<NoVisionModelNotice reason={reason} onManual={onManual} />);
      await user.click(screen.getByRole('button', { name: 'Continue manually' }));
      expect(onManual).toHaveBeenCalledTimes(1);
    },
  );

  it('links to AI Keys only where a key would help', () => {
    const { unmount } = render(<NoVisionModelNotice reason="no_key" fix="keys" onManual={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Open AI Keys' })).toHaveAttribute('href', '/settings/ai');
    unmount();

    const second = render(<NoVisionModelNotice reason="no_models" fix="admin" onManual={vi.fn()} />);
    expect(screen.queryByRole('link', { name: 'Open AI Keys' })).not.toBeInTheDocument();
    second.unmount();

    render(<NoVisionModelNotice reason="ai_disabled" onManual={vi.fn()} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('never tells a user without ai_config:write to go to the admin page', () => {
    render(<NoVisionModelNotice reason="missing_capability" fix="admin" onManual={vi.fn()} />);
    expect(screen.queryByRole('link', { name: 'Assign a model' })).not.toBeInTheDocument();
  });

  it('links an AI administrator to the assignments page', () => {
    render(<NoVisionModelNotice reason="no_models" fix="admin" onManual={vi.fn()} />, {
      wrapperOptions: { user: mockAdminUser },
    });
    expect(screen.getByRole('link', { name: 'Assign a model' })).toHaveAttribute(
      'href',
      '/admin/settings/ai/assignments',
    );
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
