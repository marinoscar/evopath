/**
 * `AgentModelCard`: the model picker's disabling, the reasoning-effort options
 * per model, and what it saves.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { AgentModelCard } from '../../../components/training/AgentModelCard';
import {
  mockFrontierModel,
  mockMediumModel,
  mockPlainModel,
  mockRoleResolution,
  mockTrainingUsableModels,
} from '../../mocks/fixtures/trainingAgents';
import type { AiTaskModel, TrainingAgentRole } from '../../../types';

function renderCard(
  role: TrainingAgentRole,
  value?: AiTaskModel,
  onSave = vi.fn().mockResolvedValue(undefined),
) {
  const user = userEvent.setup();
  render(
    <AgentModelCard
      role={role}
      resolution={mockRoleResolution({ role, state: value ? 'ready' : 'auto' })}
      models={mockTrainingUsableModels}
      value={value}
      onSave={onSave}
      providerNames={{ openai: 'OpenAI', anthropic: 'Anthropic' }}
    />,
  );
  return { user, onSave };
}

describe('AgentModelCard', () => {
  it('shows the role job and where requests go', () => {
    renderCard('planner');
    const card = screen.getByRole('region', { name: 'Planner' });
    expect(within(card).getByText(/Drafts your training plan/)).toBeInTheDocument();
    expect(within(card).getByText('Requests for this agent go to OpenAI using your key.')).toBeInTheDocument();
  });

  it('researcher: disables models without hosted tools or outside OpenAI', async () => {
    const { user } = renderCard('researcher');
    await user.click(screen.getByRole('combobox', { name: 'Model' }));

    const medium = screen.getByRole('option', { name: /Medium One/ });
    expect(medium).toHaveAttribute('aria-disabled', 'true');
    expect(within(medium).getByText('Does not support hosted tools')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Plain One/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: /Frontier One/ })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('planner: a model with structured output is pickable, and picking saves it', async () => {
    const { user, onSave } = renderCard('planner');
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await user.click(screen.getByRole('option', { name: /Medium One/ }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ provider: 'anthropic', modelId: 'medium-1', reasoningEffort: null }),
    );
  });

  it('effort select is disabled until a model is chosen', () => {
    renderCard('planner');
    expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Choose a model to set its reasoning effort.')).toBeInTheDocument();
  });

  it('lists only the efforts the chosen model offers, role default first', async () => {
    const { user, onSave } = renderCard('planner', {
      provider: mockMediumModel.provider,
      modelId: mockMediumModel.modelId,
      reasoningEffort: null,
    });
    await user.click(screen.getByRole('combobox', { name: 'Reasoning effort' }));
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Default (role default)', 'low', 'medium']);

    await user.click(screen.getByRole('option', { name: 'medium' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ provider: 'anthropic', modelId: 'medium-1', reasoningEffort: 'medium' }),
    );
  });

  it('a model without reasoning disables the effort select with the reason', () => {
    renderCard('planner', { provider: mockPlainModel.provider, modelId: mockPlainModel.modelId, reasoningEffort: null });
    expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('This model has no adjustable reasoning.')).toBeInTheDocument();
  });

  it('clears the choice back to automatic', async () => {
    const { user, onSave } = renderCard('critic', {
      provider: mockFrontierModel.provider,
      modelId: mockFrontierModel.modelId,
      reasoningEffort: 'high',
    });
    await user.click(screen.getByRole('button', { name: 'Use the automatic choice' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });

  it('shows a save failure inline', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Settings were updated elsewhere. Please try again.'));
    const { user } = renderCard('critic', {
      provider: mockFrontierModel.provider,
      modelId: mockFrontierModel.modelId,
      reasoningEffort: null,
    }, onSave);
    await user.click(screen.getByRole('button', { name: 'Use the automatic choice' }));
    expect(await screen.findByText('Settings were updated elsewhere. Please try again.')).toBeInTheDocument();
  });
});
