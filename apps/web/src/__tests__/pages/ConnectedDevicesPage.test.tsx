/**
 * `ConnectedDevicesPage` (#283, epic #276) against MSW: the real page, hooks
 * and services, so each request (runs, diagnostics, the unpair DELETE and its
 * `deleteEntries` flag) is asserted on the wire.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { REPO_SLUG } from '@app/shared';
import { server } from '../mocks/server';
import { setViewportWidth } from '../setup';
import { mockUser, render, type MockUser } from '../utils/test-utils';
import ConnectedDevicesPage, { OPEN_HEALTH_SYNC_LABEL } from '../../pages/ConnectedDevicesPage';
import { DELETE_ENTRIES_LABEL } from '../../components/settings/connectedDevices/UnpairDialog';
import { TWA_SESSION_KEY } from '../../utils/twa';
import { ANDROID_HEALTH_SYNC_DEEP_LINK } from '../../utils/androidIdentity';
import {
  DEVICE_ID,
  REPORT_ID,
  mockDevice,
  mockFailedRun,
  mockReport,
  mockReportSummary,
  mockRun,
  mockRunWithTypes,
  mockRelease,
} from '../mocks/fixtures/healthSync';
import type { Device } from '../../services/healthSync';

const goalsUser: MockUser = {
  ...mockUser,
  permissions: [...mockUser.permissions, 'goals:read', 'goals:write'],
};
const readOnlyUser: MockUser = {
  ...mockUser,
  permissions: [...mockUser.permissions, 'goals:read'],
};

function serveDevices(devices: Device[]) {
  server.use(http.get('*/api/health-sync/devices', () => HttpResponse.json({ data: devices })));
}

function renderPage(user: MockUser = goalsUser) {
  return render(<ConnectedDevicesPage />, { wrapperOptions: { user } });
}

describe('ConnectedDevicesPage', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('shows how to get the Android app when no phone is paired', async () => {
    renderPage();
    const link = await screen.findByRole('link', { name: /get the android app/i });
    expect(link).toHaveAttribute('href', `https://github.com/${REPO_SLUG}/releases/tag/android-latest`);
    const steps = screen.getByRole('list', { name: 'Setup steps' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(4);
    expect(screen.queryByRole('link', { name: OPEN_HEALTH_SYNC_LABEL })).not.toBeInTheDocument();
  });

  it('lists a device with its failed last sync, error, expiring token and timezone mismatch', async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    serveDevices([
      mockDevice({
        lastSyncStatus: 'failed',
        lastError: 'Health Connect permission was revoked',
        tokenExpiresAt: soon,
        timezone: 'Europe/Madrid',
        userTimezone: 'America/Costa_Rica',
      }),
    ]);
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Pixel 9' })).toBeInTheDocument();
    expect(screen.getByTestId('run-status-failed')).toHaveTextContent('Failed');
    expect(screen.getByTestId('device-last-error')).toHaveTextContent('Health Connect permission was revoked');
    expect(screen.getByTestId('token-expiring')).toBeInTheDocument();
    expect(screen.getByTestId('timezone-mismatch')).toHaveTextContent('Europe/Madrid');
    expect(screen.getByText(/^Last sync /)).toBeInTheDocument();
  });

  it('warns about an expired token', async () => {
    serveDevices([mockDevice({ tokenExpiresAt: '2020-01-01T00:00:00.000Z' })]);
    renderPage();
    expect(await screen.findByTestId('token-expired')).toBeInTheDocument();
    expect(screen.queryByTestId('timezone-mismatch')).not.toBeInTheDocument();
  });

  it('loads the sync history on open, with the failed run and its error', async () => {
    serveDevices([mockDevice()]);
    const seen: string[] = [];
    server.use(
      http.get(`*/api/health-sync/devices/${DEVICE_ID}/runs`, ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json({ data: [mockFailedRun, mockRun()] });
      }),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Sync history' }));
    const table = await screen.findByRole('table', { name: 'Sync history' });
    expect(seen).toEqual(['?limit=50']);
    expect(within(table).getByText(/HC_PERMISSION_DENIED: Health Connect permission was revoked/)).toBeInTheDocument();
    expect(within(table).getAllByTestId('run-status-failed')).toHaveLength(1);
    expect(within(table).getAllByTestId('run-status-ok')).toHaveLength(1);
  });

  it('expands a run to its per-type read and sent counts', async () => {
    serveDevices([mockDevice()]);
    server.use(
      http.get(`*/api/health-sync/devices/${DEVICE_ID}/runs`, () =>
        HttpResponse.json({ data: [mockRunWithTypes, mockRun()] }),
      ),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Sync history' }));
    const table = await screen.findByRole('table', { name: 'Sync history' });
    // Only the run that carries per-type details offers the toggle.
    const toggles = within(table).getAllByRole('button', { name: 'Show per-type counts' });
    expect(toggles).toHaveLength(1);
    await user.click(toggles[0]);
    const perType = await screen.findByTestId(`run-per-type-${mockRunWithTypes.id}`);
    expect(perType).toHaveTextContent('steps · read 7 · sent 7');
    expect(perType).toHaveTextContent('sleep · permission denied · read 0 · sent 0');
  });

  it('collapses the sync history into a list below sm', async () => {
    setViewportWidth(390);
    serveDevices([mockDevice()]);
    server.use(
      http.get(`*/api/health-sync/devices/${DEVICE_ID}/runs`, () => HttpResponse.json({ data: [mockFailedRun] })),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Sync history' }));
    const list = await screen.findByRole('list', { name: 'Sync history' });
    expect(within(list).getByText(/HC_PERMISSION_DENIED/)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Sync history' })).not.toBeInTheDocument();
  });

  it('opens a diagnostic report and renders its checks, environment and log', async () => {
    serveDevices([mockDevice()]);
    server.use(
      http.get(`*/api/health-sync/devices/${DEVICE_ID}/diagnostics`, () =>
        HttpResponse.json({ data: [mockReportSummary] }),
      ),
      http.get(`*/api/health-sync/devices/${DEVICE_ID}/diagnostics/${REPORT_ID}`, () =>
        HttpResponse.json({ data: mockReport }),
      ),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Diagnostics' }));
    expect(await screen.findByText('2 warnings, 1 failure')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /view report from/i }));

    const dialog = await screen.findByRole('dialog', { name: 'Diagnostic report' });
    const checks = await within(dialog).findByRole('list', { name: 'Self-test checks' });
    expect(within(checks).getByText('hc.permissions')).toBeInTheDocument();
    expect(within(checks).getByText('Fix: Grant exercise access in Health Connect')).toBeInTheDocument();
    expect(within(dialog).getByTestId('check-icon-pass')).toBeInTheDocument();
    expect(within(dialog).getByTestId('check-icon-warn')).toBeInTheDocument();
    expect(within(dialog).getByTestId('check-icon-fail')).toBeInTheDocument();
    expect(within(dialog).getByTestId('check-icon-skip')).toBeInTheDocument();
    expect(within(dialog).getByText(/Android 16/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Log tail')).toHaveTextContent('12:00:02 sync ok');
    expect(within(dialog).getByRole('button', { name: 'Download JSON' })).toBeInTheDocument();
  });

  it('shows the Health Connect inventory, highlighting granted types with no data, and the sources', async () => {
    serveDevices([mockDevice()]);
    server.use(
      http.get(`*/api/health-sync/devices/${DEVICE_ID}/diagnostics`, () =>
        HttpResponse.json({ data: [mockReportSummary] }),
      ),
      http.get(`*/api/health-sync/devices/${DEVICE_ID}/diagnostics/${REPORT_ID}`, () =>
        HttpResponse.json({ data: mockReport }),
      ),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Diagnostics' }));
    await user.click(await screen.findByRole('button', { name: /view report from/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Diagnostic report' });

    const inventory = await within(dialog).findByRole('table', { name: 'Health Connect data' });
    const steps = within(inventory).getByTestId('inventory-steps');
    expect(steps).toHaveTextContent('1000+');
    expect(steps).toHaveTextContent('Samsung Health');
    expect(steps).not.toHaveAttribute('data-empty');
    expect(within(inventory).getByTestId('inventory-sleep')).toHaveAttribute('data-empty', 'true');
    // Denied is its own failure, not "granted but empty".
    expect(within(inventory).getByTestId('inventory-weight')).not.toHaveAttribute('data-empty');
    expect(within(inventory).getByTestId('inventory-weight')).toHaveTextContent('Denied');

    const sources = within(dialog).getByRole('list', { name: 'Health Connect sources' });
    expect(within(sources).getByText('Samsung Health')).toBeInTheDocument();
    expect(within(sources).getByText(/steps, exercise/)).toBeInTheDocument();
  });

  it('unpairs with deleteEntries=true when the box is ticked', async () => {
    serveDevices([mockDevice()]);
    const deletes: string[] = [];
    server.use(
      http.delete(`*/api/health-sync/devices/${DEVICE_ID}`, ({ request }) => {
        deletes.push(new URL(request.url).search);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Unpair Pixel 9' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unpair Pixel 9?' });
    await user.click(within(dialog).getByRole('checkbox', { name: DELETE_ENTRIES_LABEL }));
    await user.click(within(dialog).getByRole('button', { name: 'Unpair' }));

    await waitFor(() => expect(deletes).toEqual(['?deleteEntries=true']));
    expect(await screen.findByText(/was unpaired and its imported activity deleted/)).toBeInTheDocument();
  });

  it('unpairs with deleteEntries=false by default', async () => {
    serveDevices([mockDevice()]);
    const deletes: string[] = [];
    server.use(
      http.delete(`*/api/health-sync/devices/${DEVICE_ID}`, ({ request }) => {
        deletes.push(new URL(request.url).search);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Unpair Pixel 9' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unpair Pixel 9?' });
    await user.click(within(dialog).getByRole('button', { name: 'Unpair' }));
    await waitFor(() => expect(deletes).toEqual(['?deleteEntries=false']));
  });

  it('offers no Unpair without goals:write', async () => {
    serveDevices([mockDevice()]);
    renderPage(readOnlyUser);
    expect(await screen.findByRole('heading', { name: 'Pixel 9' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unpair Pixel 9' })).not.toBeInTheDocument();
  });

  it('offers Open Health sync only inside the TWA', async () => {
    window.sessionStorage.setItem(TWA_SESSION_KEY, '1');
    renderPage();
    const button = await screen.findByRole('link', { name: OPEN_HEALTH_SYNC_LABEL });
    expect(button).toHaveAttribute('href', ANDROID_HEALTH_SYNC_DEEP_LINK);
  });

  describe('APK releases (#287)', () => {
    function serveRelease() {
      server.use(http.get('*/api/android-app/releases/latest', () => HttpResponse.json({ data: mockRelease() })));
    }

    it('links the empty state to the Android app page when this server hosts a release', async () => {
      serveRelease();
      renderPage();
      const link = await screen.findByRole('link', { name: /get the android app/i });
      await waitFor(() => expect(link).toHaveAttribute('href', '/settings/android-app'));
      expect(screen.getByText(/download it from the Android app page/i)).toBeInTheDocument();
    });

    it('shows an Update available chip linking to the Android app page', async () => {
      serveRelease();
      serveDevices([mockDevice({ appVersionCode: 1, latestVersionCode: 2, updateAvailable: true })]);
      renderPage();
      const chip = await screen.findByTestId('device-update-available');
      await waitFor(() => expect(chip).toHaveTextContent('Update available (v0.2.0)'));
      expect(chip).toHaveAttribute('href', '/settings/android-app');
      expect(screen.getByRole('link', { name: /get the android app/i })).toHaveAttribute(
        'href',
        '/settings/android-app',
      );
    });

    it('names the build when the latest release is not loaded', async () => {
      serveDevices([mockDevice({ appVersionCode: 1, latestVersionCode: 3, updateAvailable: true })]);
      renderPage();
      expect(await screen.findByTestId('device-update-available')).toHaveTextContent('Update available (build 3)');
    });

    it('shows no chip when the device is current', async () => {
      serveDevices([mockDevice({ appVersionCode: 2, latestVersionCode: 2, updateAvailable: false })]);
      renderPage();
      expect(await screen.findByRole('heading', { name: 'Pixel 9' })).toBeInTheDocument();
      expect(screen.queryByTestId('device-update-available')).not.toBeInTheDocument();
    });
  });
});
