/**
 * `RoleStateBanner`: the copy for every role resolution state.
 */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { RoleStateBanner } from '../../../components/training/RoleStateBanner';
import { mockRoleResolution } from '../../mocks/fixtures/trainingAgents';

describe('RoleStateBanner', () => {
  it('ready: names the model and whose key pays', () => {
    render(<RoleStateBanner resolution={mockRoleResolution({ role: 'planner', state: 'ready' })} />);
    expect(screen.getByText('Using Frontier One (your key)')).toBeInTheDocument();
  });

  it('ready on the organisation key', () => {
    render(
      <RoleStateBanner
        resolution={mockRoleResolution({
          role: 'planner',
          state: 'ready',
          model: { provider: 'anthropic', modelId: 'medium-1', displayName: 'Medium One', keySource: 'org' },
        })}
      />,
    );
    expect(screen.getByText('Using Medium One (organisation key)')).toBeInTheDocument();
  });

  it('auto: says the model was chosen automatically', () => {
    render(<RoleStateBanner resolution={mockRoleResolution({ role: 'critic', state: 'auto' })} />);
    expect(screen.getByText(/Using Frontier One \(chosen automatically\)/)).toBeInTheDocument();
  });

  it('no_key: links to the AI Keys page', () => {
    render(
      <RoleStateBanner
        resolution={mockRoleResolution({ role: 'planner', state: 'no_key', model: undefined, fix: 'keys' })}
      />,
    );
    expect(screen.getByRole('link', { name: 'Add an AI key to use this' })).toHaveAttribute(
      'href',
      '/settings/ai',
    );
  });

  it('no_models', () => {
    render(
      <RoleStateBanner
        resolution={mockRoleResolution({ role: 'planner', state: 'no_models', model: undefined, fix: 'admin' })}
      />,
    );
    expect(
      screen.getByText('No enabled model is available. Ask an administrator or add a key.'),
    ).toBeInTheDocument();
  });

  it('missing_capability for the researcher, with candidates', () => {
    render(
      <RoleStateBanner
        resolution={mockRoleResolution({
          role: 'researcher',
          state: 'missing_capability',
          model: undefined,
          fix: 'admin',
          candidates: [{ provider: 'openai', modelId: 'frontier-2', displayName: 'Frontier Two', enabled: false }],
        })}
      />,
    );
    expect(screen.getByText(/None of your models can search the web/)).toBeInTheDocument();
    expect(screen.getByText(/Frontier Two \(openai, not enabled by an administrator\)/)).toBeInTheDocument();
  });

  it('missing_capability for another role', () => {
    render(
      <RoleStateBanner
        resolution={mockRoleResolution({ role: 'critic', state: 'missing_capability', model: undefined })}
      />,
    );
    expect(screen.getByText(/None of your models support structured output/)).toBeInTheDocument();
  });

  it('stale_preference: names the fallback', () => {
    render(
      <RoleStateBanner
        resolution={mockRoleResolution({
          role: 'planner',
          state: 'stale_preference',
          stalePreference: { provider: 'openai', modelId: 'gone-1' },
        })}
      />,
    );
    expect(
      screen.getByText('Your saved model is no longer available. Using Frontier One.'),
    ).toBeInTheDocument();
  });

  it('a stale preference that led to a blocking state says both', () => {
    render(
      <RoleStateBanner
        resolution={mockRoleResolution({
          role: 'planner',
          state: 'no_models',
          model: undefined,
          stalePreference: { provider: 'openai', modelId: 'gone-1' },
        })}
      />,
    );
    expect(screen.getByText('Your saved model (gone-1) is no longer available.')).toBeInTheDocument();
    expect(screen.getByText(/No enabled model is available/)).toBeInTheDocument();
  });

  it('web_search_disabled: says where an administrator turns it on', () => {
    render(
      <RoleStateBanner
        resolution={mockRoleResolution({ role: 'researcher', state: 'web_search_disabled', model: undefined })}
      />,
    );
    expect(screen.getByText(/Web search is switched off for this deployment/)).toBeInTheDocument();
    expect(screen.getByText(/Admin, AI, Hosted tools, Web search/)).toBeInTheDocument();
  });

  it('clamped effort', () => {
    render(
      <RoleStateBanner
        resolution={mockRoleResolution({
          role: 'planner',
          state: 'ready',
          requestedEffort: 'high',
          effectiveEffort: 'medium',
          effortNote: 'clamped',
        })}
      />,
    );
    expect(screen.getByText('This model offers up to medium; using that.')).toBeInTheDocument();
  });
});
