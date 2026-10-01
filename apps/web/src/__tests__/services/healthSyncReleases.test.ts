/** `services/healthSync.ts` APK release calls (#287): method, path, body, and the 404 → null rule. */
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { ApiError } from '../../services/api';
import {
  buildReleaseFormData,
  createDownloadLink,
  deleteRelease,
  formatMegabytes,
  getLatestRelease,
  listReleases,
  makeReleaseCurrent,
  uploadRelease,
  type UploadReleaseInput,
} from '../../services/healthSync';
import { PIXEL_SHA, RELEASE_ID, mockAdminRelease, mockRelease } from '../mocks/fixtures/healthSync';
import { ANDROID_PACKAGE_NAME, androidApkFileName } from '../../utils/androidIdentity';

function apk(name = androidApkFileName('0.2.0')) {
  return new File([new Uint8Array([0x50, 0x4b, 3, 4])], name, { type: 'application/vnd.android.package-archive' });
}

const input = (overrides: Partial<UploadReleaseInput> = {}): UploadReleaseInput => ({
  apk: apk(),
  versionName: '0.2.0',
  versionCode: 2,
  packageName: ANDROID_PACKAGE_NAME,
  signingSha256: PIXEL_SHA,
  notes: '  Fixes  ',
  makeCurrent: true,
  ...overrides,
});

describe('healthSync release calls', () => {
  it('reads the latest release', async () => {
    server.use(http.get('*/api/android-app/releases/latest', () => HttpResponse.json({ data: mockRelease() })));
    await expect(getLatestRelease()).resolves.toMatchObject({ id: RELEASE_ID, versionCode: 2 });
  });

  it('turns 404 NO_RELEASE into null', async () => {
    // The default handler answers 404 NO_RELEASE.
    await expect(getLatestRelease()).resolves.toBeNull();
  });

  it('still throws any other error', async () => {
    server.use(
      http.get('*/api/android-app/releases/latest', () => HttpResponse.json({ message: 'boom' }, { status: 500 })),
    );
    await expect(getLatestRelease()).rejects.toBeInstanceOf(ApiError);
  });

  it('asks for a download link with a POST to the release', async () => {
    let seen: { method?: string; path?: string } = {};
    server.use(
      http.post('*/api/android-app/releases/:id/download-link', ({ request }) => {
        seen = { method: request.method, path: new URL(request.url).pathname };
        return HttpResponse.json({ data: { url: '/api/android-app/download/tok', expiresAt: '2026-10-01T00:10:00Z' } });
      }),
    );
    await expect(createDownloadLink(RELEASE_ID)).resolves.toMatchObject({ url: '/api/android-app/download/tok' });
    expect(seen).toEqual({ method: 'POST', path: `/api/android-app/releases/${RELEASE_ID}/download-link` });
  });

  it('lists, promotes and deletes releases on the admin routes', async () => {
    const calls: string[] = [];
    server.use(
      http.get('*/api/admin/android-app/releases', () => HttpResponse.json({ data: [mockAdminRelease()] })),
      http.post('*/api/admin/android-app/releases/:id/make-current', ({ request }) => {
        calls.push(`POST ${new URL(request.url).pathname}`);
        return HttpResponse.json({ data: mockAdminRelease() });
      }),
      http.delete('*/api/admin/android-app/releases/:id', ({ request }) => {
        calls.push(`DELETE ${new URL(request.url).pathname}`);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(listReleases()).resolves.toHaveLength(1);
    await makeReleaseCurrent(RELEASE_ID);
    await deleteRelease(RELEASE_ID);
    expect(calls).toEqual([
      `POST /api/admin/android-app/releases/${RELEASE_ID}/make-current`,
      `DELETE /api/admin/android-app/releases/${RELEASE_ID}`,
    ]);
  });

  it('builds the multipart body with every field and the apk part', () => {
    const form = buildReleaseFormData(input({ force: true }));
    expect(form.get('versionName')).toBe('0.2.0');
    expect(form.get('versionCode')).toBe('2');
    expect(form.get('packageName')).toBe(ANDROID_PACKAGE_NAME);
    expect(form.get('signingSha256')).toBe(PIXEL_SHA);
    expect(form.get('notes')).toBe('Fixes');
    expect(form.get('makeCurrent')).toBe('true');
    expect(form.get('force')).toBe('true');
    expect((form.get('apk') as File).name).toBe(androidApkFileName('0.2.0'));
  });

  it('omits empty notes and force, and sends makeCurrent=false', () => {
    const form = buildReleaseFormData(input({ notes: '  ', makeCurrent: false }));
    expect(form.has('notes')).toBe(false);
    expect(form.has('force')).toBe(false);
    expect(form.get('makeCurrent')).toBe('false');
  });

  it('uploads with a multipart POST and surfaces the API error code', async () => {
    let contentType: string | null = null;
    server.use(
      http.post('*/api/admin/android-app/releases', ({ request }) => {
        contentType = request.headers.get('content-type');
        return HttpResponse.json(
          { message: 'Not newer', code: 'RELEASE_VERSION_NOT_NEWER' },
          { status: 409 },
        );
      }),
    );
    const err = await uploadRelease(input()).catch((e: unknown) => e);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('RELEASE_VERSION_NOT_NEWER');
  });

  it('formats sizes in decimal megabytes', () => {
    expect(formatMegabytes(12_345_678)).toBe('12.3 MB');
  });
});
