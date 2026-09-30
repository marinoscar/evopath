/**
 * `AiModelSelect`: a single capability (the original contract) and a list of
 * capabilities, where the disabled reason names the first one missing.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import {
  AiModelSelect,
  aiModelDisabledReason,
  missingAiCapability,
} from '../../../components/ai/AiModelSelect';
import {
  mockFrontierModel,
  mockMediumModel,
  mockPlainModel,
} from '../../mocks/fixtures/trainingAgents';

describe('aiModelDisabledReason', () => {
  it('defaults to responses, as before', () => {
    expect(aiModelDisabledReason(mockPlainModel)).toBeNull();
    expect(
      aiModelDisabledReason({
        ...mockPlainModel,
        capabilities: { ...mockPlainModel.capabilities, capabilities: ['embeddings'] },
      }),
    ).toBe('Does not support text responses');
  });

  it('accepts a single capability string', () => {
    expect(aiModelDisabledReason(mockPlainModel, 'hosted_tools')).toBe('Does not support hosted tools');
    expect(aiModelDisabledReason(mockFrontierModel, 'hosted_tools')).toBeNull();
  });

  it('accepts a list and names the first missing capability', () => {
    const needs = ['responses', 'structured_output', 'hosted_tools'];
    expect(aiModelDisabledReason(mockFrontierModel, needs)).toBeNull();
    expect(aiModelDisabledReason(mockMediumModel, needs)).toBe('Does not support hosted tools');
    expect(aiModelDisabledReason(mockPlainModel, needs)).toBe('Does not support structured output');
    expect(missingAiCapability(mockPlainModel, needs)).toBe('structured_output');
  });
});

describe('AiModelSelect', () => {
  it('lists every model and disables incapable ones with the reason', async () => {
    const user = userEvent.setup();
    render(
      <AiModelSelect
        models={[mockFrontierModel, mockMediumModel, mockPlainModel]}
        value=""
        onChange={vi.fn()}
        capability={['responses', 'structured_output', 'hosted_tools']}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    const listbox = screen.getByRole('listbox');
    const frontier = within(listbox).getByRole('option', { name: /Frontier One/ });
    const medium = within(listbox).getByRole('option', { name: /Medium One/ });
    const plain = within(listbox).getByRole('option', { name: /Plain One/ });

    expect(frontier).not.toHaveAttribute('aria-disabled', 'true');
    expect(medium).toHaveAttribute('aria-disabled', 'true');
    expect(within(medium).getByText('Does not support hosted tools')).toBeInTheDocument();
    expect(plain).toHaveAttribute('aria-disabled', 'true');
    expect(within(plain).getByText('Does not support structured output')).toBeInTheDocument();
  });

  it('applies an extra disabledReason on top of the capability check', async () => {
    const user = userEvent.setup();
    render(
      <AiModelSelect
        models={[mockFrontierModel, mockMediumModel]}
        value=""
        onChange={vi.fn()}
        capability="structured_output"
        disabledReason={(model) => (model.provider === 'openai' ? null : 'OpenAI only')}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    const medium = screen.getByRole('option', { name: /Medium One/ });
    expect(medium).toHaveAttribute('aria-disabled', 'true');
    expect(within(medium).getByText('OpenAI only')).toBeInTheDocument();
  });

  it('reports the picked key', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AiModelSelect models={[mockFrontierModel]} value="" onChange={onChange} />);

    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await user.click(screen.getByRole('option', { name: /Frontier One/ }));
    expect(onChange).toHaveBeenCalledWith('openai:frontier-1');
  });
});
