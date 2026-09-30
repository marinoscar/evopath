/**
 * `AgentModelCard`: one training agent role, READ-ONLY (#173). It shows the
 * model, effort and destination the API resolved, who chose the model, and a
 * blocking state; it never offers a model or effort picker.
 */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { AgentModelCard } from '../../../components/training/AgentModelCard';
import { mockRoleResolution } from '../../mocks/fixtures/trainingAgents';

const PROVIDERS = { openai: 'OpenAI', anthropic: 'Anthropic' };

describe('AgentModelCard', () => {
  it('shows the resolved model, effort and destination, with no pickers', () => {
    render(
      <AgentModelCard
        role="planner"
        resolution={mockRoleResolution({ role: 'planner', state: 'ready', effectiveEffort: 'high' })}
        providerNames={PROVIDERS}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Planner' })).toBeInTheDocument();
    expect(screen.getByText('Model: Frontier One (OpenAI)')).toBeInTheDocument();
    expect(screen.getByText('Reasoning effort: high')).toBeInTheDocument();
    expect(screen.getByText('Requests for this agent go to OpenAI using your key.')).toBeInTheDocument();
    expect(screen.getByText(/Chosen by your administrator/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says when the model has no adjustable reasoning', () => {
    render(
      <AgentModelCard
        role="critic"
        resolution={mockRoleResolution({
          role: 'critic',
          state: 'auto',
          effectiveEffort: null,
          effortNote: 'model_has_no_reasoning',
        })}
        providerNames={PROVIDERS}
      />,
    );
    expect(screen.getByText('This model has no adjustable reasoning.')).toBeInTheDocument();
    expect(screen.getByText(/Chosen automatically/)).toBeInTheDocument();
  });

  it('shows only the blocking state when there is no model', () => {
    render(
      <AgentModelCard
        role="evaluator"
        resolution={mockRoleResolution({ role: 'evaluator', state: 'no_key', model: undefined, fix: 'keys' })}
        providerNames={PROVIDERS}
      />,
    );
    expect(screen.getByText(/needs an AI key/)).toBeInTheDocument();
    expect(screen.queryByText(/^Model:/)).not.toBeInTheDocument();
  });
});
