/**
 * `AndroidNotificationsSection` (#312) against MSW: the push subscription
 * counts from `GET /api/admin/android-app`, and the test send
 * (`POST /api/admin/android-app/test-notification`) with each outcome the
 * API can answer — delivered, a pruned (gone) subscription, no Android app
 * subscription, push not configured — plus the read-only gate.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { mockAdminUser, render, type MockUser } from '../../utils/test-utils';
import AndroidAppPage from '../../../pages/Admin/AndroidAppPage';
import {
  NO_ANDROID_SUBSCRIPTION_GUIDANCE,
  PUSH_NOT_CONFIGURED_GUIDANCE,
  PUSH_SETTINGS_PATH,
} from '../../../components/admin/androidApp/AndroidNotificationsSection';
import type { AndroidTestNotificationResponse } from '../../../services/healthSync';

const readOnlyAdmin: MockUser = {
  ...mockAdminUser,
  permissions: mockAdminUser.permissions.filter((p) => p !== 'system_settings:write'),
};

function answerTestSend(response: AndroidTestNotificationResponse) {
  const bodies: unknown[] = [];
  server.use(
    http.post('*/api/admin/android-app/test-notification', async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ data: response });
    }),
  );
  return bodies;
}

async function sendTest() {
  const user = userEvent.setup();
  render(<AndroidAppPage />, { wrapperOptions: { user: mockAdminUser } });
  const section = await screen.findByRole('region', { name: 'Notifications' });
  await user.click(within(section).getByRole('button', { name: 'Send test notification' }));
  return section;
}

describe('AndroidNotificationsSection', () => {
  it('shows the Android app subscription counts', async () => {
    render(<AndroidAppPage />, { wrapperOptions: { user: mockAdminUser } });
    const counts = await screen.findByTestId('android-push-counts');
    expect(within(counts).getByText('2 Android app subscriptions')).toBeInTheDocument();
    expect(within(counts).getByText('1 user')).toBeInTheDocument();
    expect(within(counts).getByText('5 browser subscriptions')).toBeInTheDocument();
  });

  it('sends a test to the caller and lists a delivered result', async () => {
    const bodies = answerTestSend({
      userId: 'admin-user-id',
      androidSubscriptions: 1,
      results: [{ subscriptionId: 's1', endpointHost: 'fcm.googleapis.com', status: 'sent' }],
    });
    const section = await sendTest();

    const results = await within(section).findByRole('list', { name: 'Test notification results' });
    expect(within(results).getByText('Sent')).toBeInTheDocument();
    expect(within(results).getByText('fcm.googleapis.com')).toBeInTheDocument();
    // Caller only: no userId in the body.
    expect(bodies).toEqual([{}]);
  });

  it('shows gone and failed results with their errors', async () => {
    answerTestSend({
      userId: 'admin-user-id',
      androidSubscriptions: 2,
      results: [
        { subscriptionId: 's1', endpointHost: 'fcm.googleapis.com', status: 'gone' },
        { subscriptionId: 's2', endpointHost: 'push.example.net', status: 'failed', error: 'HTTP 500' },
      ],
    });
    const section = await sendTest();

    const results = await within(section).findByRole('list', { name: 'Test notification results' });
    expect(within(results).getByText('Gone')).toBeInTheDocument();
    expect(within(results).getByText(/no longer accepts this subscription/)).toBeInTheDocument();
    expect(within(results).getByText('Failed')).toBeInTheDocument();
    expect(within(results).getByText('HTTP 500')).toBeInTheDocument();
  });

  it('explains how to turn notifications on when there is no Android subscription', async () => {
    answerTestSend({ userId: 'admin-user-id', androidSubscriptions: 0, results: [], reason: 'NO_ANDROID_SUBSCRIPTION' });
    const section = await sendTest();

    const guidance = await within(section).findByTestId('android-test-reason');
    expect(guidance).toHaveTextContent(NO_ANDROID_SUBSCRIPTION_GUIDANCE);
    expect(within(section).queryByRole('list', { name: 'Test notification results' })).not.toBeInTheDocument();
  });

  it('links to the Web Push settings when push is not configured', async () => {
    answerTestSend({ userId: 'admin-user-id', androidSubscriptions: 0, results: [], reason: 'PUSH_NOT_CONFIGURED' });
    const section = await sendTest();

    const guidance = await within(section).findByTestId('android-test-reason');
    expect(guidance).toHaveTextContent(PUSH_NOT_CONFIGURED_GUIDANCE);
    expect(within(guidance).getByRole('link', { name: 'Open Web Push settings' })).toHaveAttribute(
      'href',
      PUSH_SETTINGS_PATH,
    );
  });

  it('gives the same guidance when the API answers a reason as an error code', async () => {
    server.use(
      http.post('*/api/admin/android-app/test-notification', () =>
        HttpResponse.json({ message: 'Push is not configured', code: 'PUSH_NOT_CONFIGURED' }, { status: 409 }),
      ),
    );
    const section = await sendTest();
    expect(await within(section).findByTestId('android-test-reason')).toHaveTextContent(PUSH_NOT_CONFIGURED_GUIDANCE);
  });

  it('disables the test send without system_settings:write', async () => {
    const bodies = answerTestSend({ userId: 'x', androidSubscriptions: 0, results: [] });
    render(<AndroidAppPage />, { wrapperOptions: { user: readOnlyAdmin } });
    const section = await screen.findByRole('region', { name: 'Notifications' });
    expect(within(section).getByRole('button', { name: 'Send test notification' })).toBeDisabled();
    await waitFor(() => expect(bodies).toHaveLength(0));
  });
});
