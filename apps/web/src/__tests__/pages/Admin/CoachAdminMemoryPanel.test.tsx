/**
 * The Memory panel of `/admin/settings/coach` (#325): the user memory policy
 * in the system settings document, read on `system_settings:read`, written on
 * `system_settings:write` (PATCH, only what changed), read-only otherwise.
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
import { mockSystemSettings } from '../../mocks/data';

const API = '*/api';

function capturePatch() {
  const calls: Array<{ body: unknown; ifMatch: string | null }> = [];
  server.use(
    http.patch(`${API}/system-settings`, async ({ request }) => {
      const body = (await request.json()) as { memory: object };
      calls.push({ body, ifMatch: request.headers.get('if-match') });
      return HttpResponse.json({
        data: { ...mockSystemSettings, memory: { ...mockSystemSettings.memory, ...body.memory }, version: 2 },
      });
    }),
  );
  return calls;
}

async function renderPage(user = mockAdminUser) {
  const events = userEvent.setup();
  const result = render(<CoachAdminPage />, { wrapperOptions: { aiEnabled: true, user } });
  await screen.findByRole('switch', { name: 'Coach enabled' });
  const panel = screen.getByTestId('coach-admin-memory-panel');
  return { user: events, panel, ...result };
}

describe('CoachAdminPage: Memory panel (#325)', () => {
  it('renders the policy from the system settings', async () => {
    const { panel } = await renderPage();
    expect(within(panel).getByRole('heading', { level: 2, name: 'Memory' })).toBeInTheDocument();
    expect(await within(panel).findByRole('switch', { name: 'Memory enabled' })).toBeChecked();
    expect(within(panel).getByRole('switch', { name: 'Learn from conversations' })).toBeChecked();
    expect(within(panel).getByRole('textbox', { name: 'Memories per user, at most' })).toHaveValue('200');
    expect(within(panel).getByRole('textbox', { name: 'Learning runs per user per day' })).toHaveValue('20');
    expect(within(panel).getByRole('textbox', { name: 'Purge deleted memories after (days)' })).toHaveValue('30');
  });

  it('with system_settings:write: PATCHes only what changed under memory, with If-Match', async () => {
    const calls = capturePatch();
    const { user, panel } = await renderPage();
    const save = await within(panel).findByRole('button', { name: 'Save memory settings' });
    expect(save).toBeDisabled();

    await user.click(within(panel).getByRole('switch', { name: 'Learn from conversations' }));
    const max = within(panel).getByRole('textbox', { name: 'Memories per user, at most' });
    await user.clear(max);
    await user.type(max, '300');
    await user.click(save);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ body: { memory: { autoExtract: false, maxPerUser: 300 } }, ifMatch: '1' });
    expect(await screen.findByText('Memory settings saved')).toBeInTheDocument();
  });

  it.each([
    ['Memories per user, at most', '49', 'Enter a whole number from 50 to 500.'],
    ['Memories per user, at most', '501', 'Enter a whole number from 50 to 500.'],
    ['Learning runs per user per day', '0', 'Enter a whole number from 1 to 200.'],
    ['Purge deleted memories after (days)', 'abc', 'Enter a whole number from 1 to 3650.'],
  ])('refuses %s = %s inline and keeps Save disabled', async (label, value, message) => {
    const { user, panel } = await renderPage();
    const field = await within(panel).findByRole('textbox', { name: label });
    await user.clear(field);
    await user.type(field, value);
    expect(within(panel).getByText(message)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Save memory settings' })).toBeDisabled();
  });

  it('without system_settings:write: every control is visible and disabled', async () => {
    const calls = capturePatch();
    const { panel } = await renderPage({
      ...mockAdminUser,
      permissions: mockAdminUser.permissions.filter((p) => p !== 'system_settings:write'),
    });
    expect(await within(panel).findByTestId('coach-admin-memory-read-only-notice')).toBeInTheDocument();
    expect(within(panel).getByRole('switch', { name: 'Memory enabled' })).toBeDisabled();
    expect(within(panel).getByRole('switch', { name: 'Learn from conversations' })).toBeDisabled();
    expect(within(panel).getByRole('textbox', { name: 'Memories per user, at most' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Save memory settings' })).toBeDisabled();
    expect(calls).toHaveLength(0);
  });

  it('without system_settings:read: explains instead of loading', async () => {
    let fetched = false;
    server.use(
      http.get(`${API}/system-settings`, () => {
        fetched = true;
        return HttpResponse.json({ data: mockSystemSettings });
      }),
    );
    const { panel } = await renderPage({
      ...mockAdminUser,
      permissions: mockAdminUser.permissions.filter((p) => !p.startsWith('system_settings:')),
    });
    expect(within(panel).getByTestId('coach-admin-memory-no-access')).toBeInTheDocument();
    expect(within(panel).queryByRole('switch')).not.toBeInTheDocument();
    expect(fetched).toBe(false);
  });

  it('has no axe violations', async () => {
    const { container, panel } = await renderPage();
    await within(panel).findByRole('switch', { name: 'Memory enabled' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
