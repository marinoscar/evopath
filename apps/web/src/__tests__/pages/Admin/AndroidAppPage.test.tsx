/**
 * `AndroidAppPage` (#283, epic #276) against MSW: trusting a reported app and
 * adding one by hand send the full list with `PUT /api/admin/android-app`;
 * validation catches a bad package or fingerprint before the round trip; and
 * every write control is disabled without `system_settings:write`.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { mockAdminUser, render, type MockUser } from '../../utils/test-utils';
import AndroidAppPage, { PACKAGE_ERROR, READ_ONLY_MESSAGE, SHA_ERROR } from '../../../pages/Admin/AndroidAppPage';
import { PIXEL_SHA, mockAndroidAppConfig } from '../../mocks/fixtures/healthSync';
import type { AndroidAppConfig, TrustedApp } from '../../../services/healthSync';
import { ANDROID_PACKAGE_NAME } from '../../../utils/androidIdentity';

const readOnlyAdmin: MockUser = {
  ...mockAdminUser,
  permissions: mockAdminUser.permissions.filter((p) => p !== 'system_settings:write'),
};

const OTHER_SHA = PIXEL_SHA.replace(/^AB/, '12');

/** Echo every PUT back as the saved config, recording its body. */
function capturePuts() {
  const bodies: Array<{ trustedApps: TrustedApp[] }> = [];
  server.use(
    http.put('*/api/admin/android-app', async ({ request }) => {
      const body = (await request.json()) as { trustedApps: TrustedApp[] };
      bodies.push(body);
      const saved: AndroidAppConfig = { ...mockAndroidAppConfig, trustedApps: body.trustedApps };
      return HttpResponse.json({ data: saved });
    }),
  );
  return bodies;
}

describe('AndroidAppPage', () => {
  it('trusts a reported app with a PUT of the whole list', async () => {
    const puts = capturePuts();
    const user = userEvent.setup();
    render(<AndroidAppPage />, { wrapperOptions: { user: mockAdminUser } });

    const reported = await screen.findByRole('list', { name: 'Reported apps' });
    await user.click(within(reported).getByRole('button', { name: `Trust ${ANDROID_PACKAGE_NAME}` }));

    await waitFor(() =>
      expect(puts).toEqual([{ trustedApps: [{ packageName: ANDROID_PACKAGE_NAME, sha256: PIXEL_SHA }] }]),
    );
    const trusted = await screen.findByRole('list', { name: 'Trusted apps' });
    expect(within(trusted).getByText(ANDROID_PACKAGE_NAME)).toBeInTheDocument();
    expect(within(reported).getByRole('button', { name: `${ANDROID_PACKAGE_NAME} is trusted` })).toBeDisabled();
  });

  it('validates the add form, then adds a trusted app (upper-casing the fingerprint)', async () => {
    const puts = capturePuts();
    const user = userEvent.setup();
    render(<AndroidAppPage />, { wrapperOptions: { user: mockAdminUser } });

    const trustForm = await screen.findByRole('form', { name: 'Add a trusted app' });
    const pkg = within(trustForm).getByLabelText('Package name');
    const sha = within(trustForm).getByLabelText('Signing certificate SHA-256');
    await user.type(pkg, 'notapackage');
    await user.type(sha, 'AB:CD');
    await user.click(screen.getByRole('button', { name: 'Add trusted app' }));
    expect(await screen.findByText(PACKAGE_ERROR)).toBeInTheDocument();
    expect(screen.getByText(SHA_ERROR)).toBeInTheDocument();
    expect(puts).toHaveLength(0);

    await user.clear(pkg);
    await user.type(pkg, 'com.example.debug');
    await user.clear(sha);
    await user.type(sha, OTHER_SHA.toLowerCase());
    await user.click(screen.getByRole('button', { name: 'Add trusted app' }));

    await waitFor(() =>
      expect(puts).toEqual([{ trustedApps: [{ packageName: 'com.example.debug', sha256: OTHER_SHA }] }]),
    );
  });

  it('removes a trusted app', async () => {
    server.use(
      http.get('*/api/admin/android-app', () =>
        HttpResponse.json({
          data: {
            ...mockAndroidAppConfig,
            trustedApps: [{ packageName: ANDROID_PACKAGE_NAME, sha256: PIXEL_SHA }],
          },
        }),
      ),
    );
    const puts = capturePuts();
    const user = userEvent.setup();
    render(<AndroidAppPage />, { wrapperOptions: { user: mockAdminUser } });

    await user.click(await screen.findByRole('button', { name: `Remove ${ANDROID_PACKAGE_NAME}` }));
    await waitFor(() => expect(puts).toEqual([{ trustedApps: [] }]));
  });

  it('previews the asset links JSON', async () => {
    const statements = [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: ANDROID_PACKAGE_NAME, sha256_cert_fingerprints: [PIXEL_SHA] },
      },
    ];
    server.use(
      http.get('*/api/admin/android-app', () =>
        HttpResponse.json({ data: { ...mockAndroidAppConfig, assetLinks: statements } }),
      ),
    );
    render(<AndroidAppPage />, { wrapperOptions: { user: mockAdminUser } });
    const preview = await screen.findByTestId('assetlinks-preview');
    await waitFor(() => expect(preview).toHaveTextContent('delegate_permission/common.handle_all_urls'));
  });

  it('is read-only without system_settings:write', async () => {
    const puts = capturePuts();
    render(<AndroidAppPage />, { wrapperOptions: { user: readOnlyAdmin } });

    expect(await screen.findByText(READ_ONLY_MESSAGE)).toBeInTheDocument();
    const reported = await screen.findByRole('list', { name: 'Reported apps' });
    expect(within(reported).getByRole('button', { name: `Trust ${ANDROID_PACKAGE_NAME}` })).toBeDisabled();
    const trustForm = screen.getByRole('form', { name: 'Add a trusted app' });
    expect(within(trustForm).getByLabelText('Package name')).toBeDisabled();
    expect(within(trustForm).getByLabelText('Signing certificate SHA-256')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add trusted app' })).toBeDisabled();
    expect(puts).toHaveLength(0);
  });
});
