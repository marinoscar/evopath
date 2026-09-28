import { describe, expect, it } from 'vitest';

import type { ContainerState } from '../../../deploy/health.js';
import { containersSummary } from './status.js';

// =============================================================================
// `containersSummary`, the "Containers: ..." line's contents  (issue #24)
// =============================================================================
//
// Extracted pure so this is testable without ink/react-testing. Must match the
// plain `deploy status` command's own rendering: a `health` suffix appears
// only when the field is present, with no space before the paren.
// =============================================================================

function container(overrides: Partial<ContainerState> & Pick<ContainerState, 'service'>): ContainerState {
  return {
    name: overrides.service,
    state: 'running',
    image: 'image:latest',
    ...overrides,
  };
}

describe('containersSummary', () => {
  it('renders "none" for an empty array', () => {
    expect(containersSummary([])).toBe('none');
  });

  it('renders a container with no health field with no parens at all', () => {
    const containers = [container({ service: 'api', state: 'running' })];
    expect(containersSummary(containers)).toBe('api=running');
  });

  it('renders a container with health: "healthy" with no space before the paren', () => {
    const containers = [container({ service: 'greptimedb', state: 'running', health: 'healthy' })];
    expect(containersSummary(containers)).toBe('greptimedb=running(healthy)');
  });

  it('renders a container with health: "unhealthy"', () => {
    const containers = [container({ service: 'greptimedb', state: 'running', health: 'unhealthy' })];
    expect(containersSummary(containers)).toBe('greptimedb=running(unhealthy)');
  });

  it('joins multiple containers with a single space', () => {
    const containers = [
      container({ service: 'api', state: 'running' }),
      container({ service: 'greptimedb', state: 'running', health: 'healthy' }),
    ];
    expect(containersSummary(containers)).toBe('api=running greptimedb=running(healthy)');
  });
});
