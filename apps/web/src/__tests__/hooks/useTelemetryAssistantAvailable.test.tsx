/**
 * `useTelemetryAssistantAvailable` (issue #579, epic #576): the ONE condition
 * the Telemetry Explorer and Dashboard both use to offer the assistant.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { render, mockAdminUser, type MockUser } from '../utils/test-utils';
import { useTelemetryAssistantAvailable } from '../../hooks/useTelemetryAssistantAvailable';
import type { TelemetryPublicConfig } from '../../services/telemetry';

function Probe() {
  return <output data-testid="available">{String(useTelemetryAssistantAvailable())}</output>;
}

const withoutAiUse: MockUser = {
  ...mockAdminUser,
  permissions: mockAdminUser.permissions.filter((permission) => permission !== 'ai:use'),
};

const TELEMETRY_ON: TelemetryPublicConfig = { available: true, enabled: true, assistantEnabled: true };

function renderProbe(options: { telemetry?: TelemetryPublicConfig; aiEnabled?: boolean; user?: MockUser }) {
  render(<Probe />, {
    wrapperOptions: {
      user: options.user ?? mockAdminUser,
      aiEnabled: options.aiEnabled ?? true,
      telemetryEnabled: options.telemetry ?? TELEMETRY_ON,
    },
  });
  return screen.getByTestId('available').textContent;
}

describe('useTelemetryAssistantAvailable', () => {
  it('is true when the assistant and AI are on and the user holds ai:use', () => {
    expect(renderProbe({})).toBe('true');
  });

  it('is false while the assistant is switched off in the Telemetry settings', () => {
    expect(renderProbe({ telemetry: { ...TELEMETRY_ON, assistantEnabled: false } })).toBe('false');
  });

  it('is false while AI is switched off', () => {
    expect(renderProbe({ aiEnabled: false })).toBe('false');
  });

  it('is false without ai:use', () => {
    expect(renderProbe({ user: withoutAiUse })).toBe('false');
  });
});
