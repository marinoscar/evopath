/**
 * `RoleStateBanner`: the copy for every role resolution state (#173: models
 * are an administrator's choice, so no state sends a user to pick one).
 */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render, mockAdminUser } from '../../utils/test-utils';
import { RoleStateBanner } from '../../../components/training/RoleStateBanner';
import { mockRoleResolution } from '../../mocks/fixtures/trainingAgents';

describe('RoleStateBanner', () => {
  it('ready: names the model, whose key pays, and that the administrator chose it', () => {
    render(<RoleStateBanner resolution={mockRoleResolution({ role: 'planner', state: 'ready', source: 'admin_feature' })} />);
    expect(screen.getByText('Using Frontier One (your key). Chosen by your administrator.')).toBeInTheDocument();
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
    expect(screen.getByText(/Using Medium One \(organisation key\)/)).toBeInTheDocument();
  });

  it('auto: says the model was chosen automatically, and offers no picker', () => {
    render(<RoleStateBanner resolution={mockRoleResolution({ role: 'critic', state: 'auto', source: 'auto' })} />);
    expect(screen.getByText(/Using Frontier One \(your key\)\. Chosen automatically/)).toBeInTheDocument();
    expect(screen.queryByText(/Choose/)).not.toBeInTheDocument();
  });

  it('notes an administrator assignment the caller’s key cannot use', () => {
    render(
      <RoleStateBanner
        resolution={mockRoleResolution({
          role: 'planner',
          state: 'auto',
          assignmentUnavailable: { provider: 'anthropic', modelId: 'big-1' },
        })}
      />,
    );
    expect(screen.getByText(/administrator's choice \(big-1\) isn't available with your keys/)).toBeInTheDocument();
  });

  it('no_key: links to the AI Keys page', () => {
    render(
      <RoleStateBanner resolution={mockRoleResolution({ role: 'planner', state: 'no_key', model: undefined, fix: 'keys' })} />,
    );
    expect(screen.getByText(/needs an AI key/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a key' })).toHaveAttribute('href', '/settings/ai');
  });

  it('no_models: an administrator has to act; no link for a user who cannot', () => {
    render(
      <RoleStateBanner resolution={mockRoleResolution({ role: 'planner', state: 'no_models', model: undefined, fix: 'admin' })} />,
    );
    expect(screen.getByText(/Your administrator hasn't assigned or enabled one yet/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('missing_capability (admin fix) links an AI administrator to the assignments page', () => {
    render(
      <RoleStateBanner
        resolution={mockRoleResolution({ role: 'critic', state: 'missing_capability', model: undefined, fix: 'admin' })}
      />,
      { wrapperOptions: { user: mockAdminUser } },
    );
    expect(screen.getByText(/needs a model with structured output\. Your administrator hasn't assigned one yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Assign a model' })).toHaveAttribute('href', '/admin/settings/ai/assignments');
  });

  it('missing_capability for the researcher (keys fix), with candidates', () => {
    render(
      <RoleStateBanner
        resolution={mockRoleResolution({
          role: 'researcher',
          state: 'missing_capability',
          model: undefined,
          fix: 'keys',
          candidates: [
            { provider: 'openai', modelId: 'frontier-1', displayName: 'Frontier One', enabled: true },
            { provider: 'openai', modelId: 'frontier-2', displayName: 'Frontier Two', enabled: false },
          ],
        })}
      />,
    );
    expect(screen.getByText(/needs a model with web search/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a key' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Models that would work' })).toHaveTextContent('Frontier One (openai)');
    expect(screen.getByText(/Frontier Two \(openai, not enabled by an administrator\)/)).toBeInTheDocument();
  });

  it('web_search_disabled: says where an administrator turns it on', () => {
    render(
      <RoleStateBanner
        resolution={mockRoleResolution({ role: 'researcher', state: 'web_search_disabled', model: undefined, fix: 'admin' })}
      />,
    );
    expect(screen.getByText(/Admin, AI, Hosted tools, Web search/)).toBeInTheDocument();
  });

  it('ai_disabled', () => {
    render(
      <RoleStateBanner resolution={mockRoleResolution({ role: 'planner', state: 'ai_disabled', model: undefined, fix: 'admin' })} />,
    );
    expect(screen.getByText('AI is switched off for this app.')).toBeInTheDocument();
  });

  it('says when the effort was clamped to what the model offers', () => {
    render(
      <RoleStateBanner
        resolution={mockRoleResolution({ role: 'planner', state: 'ready', effortNote: 'clamped', effectiveEffort: 'medium' })}
      />,
    );
    expect(screen.getByText('This model offers up to medium; using that.')).toBeInTheDocument();
  });
});
