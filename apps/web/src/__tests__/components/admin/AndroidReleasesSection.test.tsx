/**
 * Console → Android app → Releases (#287, epic #276) through the real page,
 * hooks and services against MSW: the list, the upload's multipart fields,
 * the Force retry on RELEASE_VERSION_NOT_NEWER, make current (with a rollback
 * confirmation), delete, and read-only without `system_settings:write`.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { mockAdminUser, render, type MockUser } from '../../utils/test-utils';
import { readMultipartFile } from '../../utils/multipart';
import AndroidAppPage from '../../../pages/Admin/AndroidAppPage';
import {
  CLI_HINT_COMMAND,
  NOT_NEWER_MESSAGE,
  VERSION_EXISTS_MESSAGE,
  parseReleaseMetadata,
  soleKnownSigner,
} from '../../../components/admin/androidApp/AndroidReleasesSection';
import {
  OLD_RELEASE_ID,
  PIXEL_SHA,
  RELEASE_ID,
  mockAdminRelease,
  mockAndroidAppConfig,
  mockOldRelease,
} from '../../mocks/fixtures/healthSync';
import type { AdminRelease } from '../../../services/healthSync';
import { ANDROID_PACKAGE_NAME, androidApkFileName, androidMetadataFileName } from '../../../utils/androidIdentity';

const readOnlyAdmin: MockUser = {
  ...mockAdminUser,
  permissions: mockAdminUser.permissions.filter((p) => p !== 'system_settings:write'),
};

function serveReleases(releases: AdminRelease[]) {
  server.use(http.get('*/api/admin/android-app/releases', () => HttpResponse.json({ data: releases })));
}

/** One text field out of a raw multipart body (see `utils/multipart.ts` for why not `formData()`). */
function field(body: string, name: string): string | null {
  const match = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(body);
  return match ? match[1] : null;
}

function apkFile(name = androidApkFileName('0.3.0')) {
  return new File([new Uint8Array([0x50, 0x4b, 3, 4])], name, { type: 'application/vnd.android.package-archive' });
}

async function releasesSection() {
  return screen.findByRole('region', { name: 'Releases' });
}

async function fillUpload(user: ReturnType<typeof userEvent.setup>, code = '3') {
  const form = screen.getByRole('form', { name: 'Upload a release' });
  await user.upload(screen.getByTestId('release-file-input'), apkFile());
  await user.type(within(form).getByLabelText('Version name'), '0.3.0');
  await user.type(within(form).getByLabelText('Version code'), code);
  await user.type(within(form).getByLabelText('Release notes'), 'New sync');
  return form;
}

describe('AndroidReleasesSection', () => {
  it('lists releases with the current chip, size, sha prefix and the CLI hint', async () => {
    serveReleases([mockAdminRelease(), mockOldRelease]);
    render(<AndroidAppPage />, { wrapperOptions: { user: mockAdminUser } });
    const section = await releasesSection();
    const current = await within(section).findByTestId('release-2');
    expect(within(current).getByText('Current')).toBeInTheDocument();
    expect(within(current).getByText(/12\.3 MB/)).toBeInTheDocument();
    expect(within(current).getByText(/sha256 aaaaaaaaaaaa…/)).toBeInTheDocument();
    expect(within(section).getByText(CLI_HINT_COMMAND)).toBeInTheDocument();
    // The current release has no Make current and cannot be deleted.
    expect(within(current).queryByRole('button', { name: /make 0\.2\.0 current/i })).not.toBeInTheDocument();
    expect(within(current).getByRole('button', { name: 'Delete 0.2.0' })).toBeDisabled();
    expect(within(section).getByRole('button', { name: 'Delete 0.1.0' })).toBeEnabled();
  });

  it('prefills the signer the deployment knows and uploads every field as multipart', async () => {
    let body = '';
    let apkPart: { name: string } | null = null;
    server.use(
      http.post('*/api/admin/android-app/releases', async ({ request }) => {
        body = await request.clone().text();
        apkPart = await readMultipartFile(request, 'apk');
        return HttpResponse.json(
          { data: mockAdminRelease({ id: 'new', versionName: '0.3.0', versionCode: 3 }) },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    render(<AndroidAppPage />, { wrapperOptions: { user: mockAdminUser } });
    await releasesSection();
    const form = screen.getByRole('form', { name: 'Upload a release' });
    // The one reported signer and package prefill the form.
    await waitFor(() => expect(within(form).getByLabelText('Signing certificate SHA-256')).toHaveValue(PIXEL_SHA));
    expect(within(form).getByLabelText('Package name')).toHaveValue(ANDROID_PACKAGE_NAME);

    await fillUpload(user);
    await user.click(within(form).getByRole('switch'));
    await user.click(within(form).getByRole('button', { name: 'Upload release' }));

    expect(await screen.findByText('Uploaded 0.3.0 (3).')).toBeInTheDocument();
    expect(field(body, 'versionName')).toBe('0.3.0');
    expect(field(body, 'versionCode')).toBe('3');
    expect(field(body, 'packageName')).toBe(ANDROID_PACKAGE_NAME);
    expect(field(body, 'signingSha256')).toBe(PIXEL_SHA);
    expect(field(body, 'notes')).toBe('New sync');
    expect(field(body, 'makeCurrent')).toBe('false');
    expect(field(body, 'force')).toBeNull();
    // jsdom's File loses its name crossing undici's FormData, so only the part's presence is asserted here;
    // `healthSyncReleases.test.ts` pins the filename on the FormData itself.
    expect(apkPart).toMatchObject({ name: 'apk' });
  });

  it('offers Force on RELEASE_VERSION_NOT_NEWER and retries with force=true', async () => {
    serveReleases([mockAdminRelease({ versionCode: 5, versionName: '0.5.0' })]);
    const forces: Array<string | null> = [];
    server.use(
      http.post('*/api/admin/android-app/releases', async ({ request }) => {
        const force = field(await request.text(), 'force');
        forces.push(force);
        if (force !== 'true') {
          return HttpResponse.json(
            { message: 'Not newer than the current release', code: 'RELEASE_VERSION_NOT_NEWER' },
            { status: 409 },
          );
        }
        return HttpResponse.json({ data: mockAdminRelease({ id: 'new', versionName: '0.3.0', versionCode: 3 }) }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    render(<AndroidAppPage />, { wrapperOptions: { user: mockAdminUser } });
    await releasesSection();
    const form = await fillUpload(user);
    await user.click(within(form).getByRole('button', { name: 'Upload release' }));

    const warning = await screen.findByTestId('upload-not-newer');
    expect(warning).toHaveTextContent(NOT_NEWER_MESSAGE);
    await user.click(within(warning).getByRole('button', { name: 'Force' }));
    expect(await screen.findByText('Uploaded 0.3.0 (3).')).toBeInTheDocument();
    expect(forces).toEqual([null, 'true']);
  });

  it('explains RELEASE_VERSION_EXISTS without offering Force', async () => {
    server.use(
      http.post('*/api/admin/android-app/releases', () =>
        HttpResponse.json({ message: 'exists', code: 'RELEASE_VERSION_EXISTS' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    render(<AndroidAppPage />, { wrapperOptions: { user: mockAdminUser } });
    await releasesSection();
    const form = await fillUpload(user, '2');
    await user.click(within(form).getByRole('button', { name: 'Upload release' }));
    expect(await screen.findByTestId('upload-version-exists')).toHaveTextContent(VERSION_EXISTS_MESSAGE);
    expect(screen.queryByRole('button', { name: 'Force' })).not.toBeInTheDocument();
  });

  it('validates the form before uploading', async () => {
    let posted = false;
    server.use(
      http.post('*/api/admin/android-app/releases', () => {
        posted = true;
        return HttpResponse.json({ data: mockAdminRelease() }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    render(<AndroidAppPage />, { wrapperOptions: { user: mockAdminUser } });
    await releasesSection();
    const form = screen.getByRole('form', { name: 'Upload a release' });
    await user.type(within(form).getByLabelText('Version code'), '0');
    await user.click(within(form).getByRole('button', { name: 'Upload release' }));
    expect(await within(form).findByText('Choose the APK file.')).toBeInTheDocument();
    expect(within(form).getByText('Enter the version name, such as 0.2.0.')).toBeInTheDocument();
    expect(within(form).getByText(/A whole number from 1 to/)).toBeInTheDocument();
    expect(posted).toBe(false);
  });

  it('fills the form from the CLI metadata file', async () => {
    const user = userEvent.setup();
    render(<AndroidAppPage />, { wrapperOptions: { user: mockAdminUser } });
    await releasesSection();
    const form = screen.getByRole('form', { name: 'Upload a release' });
    const other = PIXEL_SHA.replace(/^AB/, '12').toLowerCase();
    const meta = new File(
      [JSON.stringify({ packageName: 'com.example.fit', versionName: '1.4.0', versionCode: 14, signingSha256: other })],
      androidMetadataFileName('1.4.0'),
      { type: 'application/json' },
    );
    await user.upload(screen.getByTestId('release-file-input'), [apkFile(androidApkFileName('1.4.0')), meta]);
    await waitFor(() => expect(within(form).getByLabelText('Version name')).toHaveValue('1.4.0'));
    expect(within(form).getByLabelText('Version code')).toHaveValue('14');
    expect(within(form).getByLabelText('Package name')).toHaveValue('com.example.fit');
    expect(within(form).getByLabelText('Signing certificate SHA-256')).toHaveValue(other.toUpperCase());
    expect(screen.getByTestId('release-file-name')).toHaveTextContent(androidApkFileName('1.4.0'));
  });

  it('makes a newer release current without asking', async () => {
    serveReleases([mockAdminRelease({ isCurrent: false }), { ...mockOldRelease, isCurrent: true }]);
    const calls: string[] = [];
    server.use(
      http.post('*/api/admin/android-app/releases/:id/make-current', ({ params }) => {
        calls.push(String(params.id));
        return HttpResponse.json({ data: mockAdminRelease() });
      }),
    );
    const user = userEvent.setup();
    render(<AndroidAppPage />, { wrapperOptions: { user: mockAdminUser } });
    const section = await releasesSection();
    await user.click(await within(section).findByRole('button', { name: 'Make 0.2.0 current' }));
    expect(await screen.findByText('0.2.0 is now the current release.')).toBeInTheDocument();
    expect(calls).toEqual([RELEASE_ID]);
  });

  it('confirms a rollback to a lower version code', async () => {
    serveReleases([mockAdminRelease(), mockOldRelease]);
    const calls: string[] = [];
    server.use(
      http.post('*/api/admin/android-app/releases/:id/make-current', ({ params }) => {
        calls.push(String(params.id));
        return HttpResponse.json({ data: mockOldRelease });
      }),
    );
    const user = userEvent.setup();
    render(<AndroidAppPage />, { wrapperOptions: { user: mockAdminUser } });
    const section = await releasesSection();
    await user.click(await within(section).findByRole('button', { name: 'Make 0.1.0 current' }));
    const dialog = await screen.findByRole('dialog', { name: 'Roll back to 0.1.0?' });
    expect(calls).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Roll back' }));
    await waitFor(() => expect(calls).toEqual([OLD_RELEASE_ID]));
  });

  it('deletes a release that is not current after confirming', async () => {
    serveReleases([mockAdminRelease(), mockOldRelease]);
    const deleted: string[] = [];
    server.use(
      http.delete('*/api/admin/android-app/releases/:id', ({ params }) => {
        deleted.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    render(<AndroidAppPage />, { wrapperOptions: { user: mockAdminUser } });
    const section = await releasesSection();
    await user.click(await within(section).findByRole('button', { name: 'Delete 0.1.0' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete 0.1.0?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleted).toEqual([OLD_RELEASE_ID]));
    expect(await screen.findByText('Deleted 0.1.0.')).toBeInTheDocument();
  });

  it('disables every write control without system_settings:write', async () => {
    serveReleases([mockAdminRelease(), mockOldRelease]);
    render(<AndroidAppPage />, { wrapperOptions: { user: readOnlyAdmin } });
    const section = await releasesSection();
    expect(await within(section).findByRole('button', { name: 'Make 0.1.0 current' })).toBeDisabled();
    expect(within(section).getByRole('button', { name: 'Delete 0.1.0' })).toBeDisabled();
    const form = within(section).getByRole('form', { name: 'Upload a release' });
    expect(within(form).getByRole('button', { name: 'Choose APK or metadata' })).toBeDisabled();
    expect(within(form).getByLabelText('Version name')).toBeDisabled();
    expect(within(form).getByLabelText('Signing certificate SHA-256')).toBeDisabled();
    expect(within(form).getByRole('switch')).toBeDisabled();
    expect(within(form).getByRole('button', { name: 'Upload release' })).toBeDisabled();
  });
});

describe('release form helpers', () => {
  it('parses the CLI metadata and ignores junk', () => {
    expect(parseReleaseMetadata('{"versionName":"1.0.0","versionCode":3,"signingSha256":"ab:cd","x":1}')).toEqual({
      versionName: '1.0.0',
      versionCode: 3,
      signingSha256: 'AB:CD',
    });
    expect(parseReleaseMetadata('not json')).toBeNull();
    expect(parseReleaseMetadata('{"versionCode":"3"}')).toEqual({});
  });

  it('prefills a signer only when exactly one is known', () => {
    expect(soleKnownSigner(mockAndroidAppConfig)).toBe(PIXEL_SHA);
    expect(soleKnownSigner(null)).toBe('');
    expect(
      soleKnownSigner({
        ...mockAndroidAppConfig,
        trustedApps: [{ packageName: ANDROID_PACKAGE_NAME, sha256: PIXEL_SHA.replace(/^AB/, '12') }],
      }),
    ).toBe('');
  });
});
