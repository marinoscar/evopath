/**
 * `/admin/settings/coach` (E7.3, #243): the deployment's coach policy.
 * Real hook, real permissions, MSW for the network.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { render, mockAdminUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import CoachAdminPage from '../../../pages/Admin/CoachAdminPage';
import SettingsHubPage from '../../../pages/Admin/SettingsHubPage';
import { mockSystemCoachSettings } from '../../mocks/fixtures/coach';
import type { SystemCoachSettings } from '../../../services/coach';

const API = '*/api';

const readOnlyAdmin = {
  ...mockAdminUser,
  permissions: mockAdminUser.permissions.filter((permission) => permission !== 'ai_config:write'),
};

function capturePut(status = 200) {
  const calls: Partial<SystemCoachSettings>[] = [];
  server.use(
    http.put(`${API}/admin/coach/settings`, async ({ request }) => {
      const body = (await request.json()) as Partial<SystemCoachSettings>;
      calls.push(body);
      if (status !== 200) return HttpResponse.json({ code: 'FORBIDDEN', message: 'Forbidden' }, { status });
      return HttpResponse.json({ data: { ...mockSystemCoachSettings, ...body } });
    }),
  );
  return calls;
}

async function renderPage(user = mockAdminUser) {
  const events = userEvent.setup();
  const result = render(<CoachAdminPage />, { wrapperOptions: { aiEnabled: true, user } });
  await screen.findByRole('switch', { name: 'Coach enabled' });
  return { user: events, ...result };
}

describe('CoachAdminPage', () => {
  it('renders every policy field from the API', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Coach' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Coach enabled' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Allow adult language' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Allow spoken messages' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Nudges per user per day, at most' })).toHaveTextContent('4');
    expect(screen.getByRole('textbox', { name: 'Keep spoken audio for (days)' })).toHaveValue('30');
    expect(screen.getByRole('textbox', { name: 'Back off after ignored nudges' })).toHaveValue('3');
    expect(screen.getByRole('textbox', { name: 'Stop after inactive days' })).toHaveValue('7');
  });

  it('links to AI Model Assignments for the models', async () => {
    await renderPage();
    expect(screen.getByRole('link', { name: 'AI Model Assignments' })).toHaveAttribute(
      'href',
      '/admin/settings/ai/assignments',
    );
  });

  it('renders the Engagement panel as an empty state, with no numbers', async () => {
    await renderPage();
    const panel = screen.getByTestId('coach-engagement-panel');
    expect(within(panel).getByRole('heading', { name: 'Engagement' })).toBeInTheDocument();
    expect(within(panel).getByText('No engagement data yet')).toBeInTheDocument();
    expect(panel.textContent).not.toMatch(/\d/);
  });

  it('with ai_config:write: saves only what changed and shows success', async () => {
    const calls = capturePut();
    const { user } = await renderPage();
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    await user.click(screen.getByRole('switch', { name: 'Allow adult language' }));
    await user.click(screen.getByRole('combobox', { name: 'Nudges per user per day, at most' }));
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: '2' }));
    const retention = screen.getByRole('textbox', { name: 'Keep spoken audio for (days)' });
    await user.clear(retention);
    await user.type(retention, '14');
    await user.click(save);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ allowProfanePersonas: true, maxNudgesPerDayCeiling: 2, audioRetentionDays: 14 });
    expect(await screen.findByText('Coach settings saved')).toBeInTheDocument();
  });

  it('rejects an out-of-range number inline and blocks saving', async () => {
    const calls = capturePut();
    const { user } = await renderPage();
    const inactive = screen.getByRole('textbox', { name: 'Stop after inactive days' });
    await user.clear(inactive);
    await user.type(inactive, '91');
    expect(screen.getByText('Enter a whole number from 1 to 90.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(calls).toHaveLength(0);
  });

  it('says so when a save is refused, never silently', async () => {
    capturePut(403);
    const { user } = await renderPage();
    await user.click(screen.getByRole('switch', { name: 'Allow spoken messages' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('You do not have permission to change the coach settings.')).toBeInTheDocument();
  });

  it('without ai_config:write: every control is disabled and a read-only notice shows', async () => {
    await renderPage(readOnlyAdmin);
    expect(screen.getByTestId('coach-admin-read-only-notice')).toBeInTheDocument();
    for (const name of ['Coach enabled', 'Allow adult language', 'Allow spoken messages']) {
      expect(screen.getByRole('switch', { name })).toBeDisabled();
    }
    expect(screen.getByRole('combobox', { name: 'Nudges per user per day, at most' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    for (const name of ['Keep spoken audio for (days)', 'Back off after ignored nudges', 'Stop after inactive days']) {
      expect(screen.getByRole('textbox', { name })).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('has no axe violations', async () => {
    const { container } = await renderPage();
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});

describe('the Coach card on /admin/settings', () => {
  it('appears in the AI group with ai_config:read while AI is on', async () => {
    render(<SettingsHubPage />, { wrapperOptions: { aiEnabled: true, user: mockAdminUser } });
    expect(await screen.findByText('Switch the AI Coach on or off, allow adult language and spoken messages, and cap daily nudges.')).toBeInTheDocument();
  });

  it('is hidden while AI is off', async () => {
    render(<SettingsHubPage />, { wrapperOptions: { aiEnabled: false, user: mockAdminUser } });
    // The AI card itself carries no feature gate, so the group renders.
    await screen.findByText('Switch AI on for this deployment, choose whose keys pay for calls, and configure each provider.');
    expect(
      screen.queryByText('Switch the AI Coach on or off, allow adult language and spoken messages, and cap daily nudges.'),
    ).not.toBeInTheDocument();
  });
});
