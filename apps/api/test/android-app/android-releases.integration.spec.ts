// =============================================================================
// Integration tests for hosted Android APK releases (issue #285, epic #276)
// =============================================================================
//
//   POST   /api/admin/android-app/releases                    system_settings:write
//   GET    /api/admin/android-app/releases                    system_settings:read
//   POST   /api/admin/android-app/releases/:id/make-current   system_settings:write
//   DELETE /api/admin/android-app/releases/:id                system_settings:write
//   GET    /api/android-app/releases/latest                   any signed-in user
//   POST   /api/android-app/releases/:id/download-link        any signed-in user
//   GET    /api/android-app/download/:token                   public, token-validated
//
// Through the real AppModule, guard stack and multipart plugin, with an
// in-memory object store (which consumes the upload stream, so the magic,
// size and SHA-256 checks run for real) and an in-memory release table over
// the Prisma mock.
// =============================================================================

// Must precede the first signing-key derivation — secret-cipher caches its master key.
const ORIGINAL_KEY_ENV = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { ANDROID_APK_STEM, ANDROID_PACKAGE_NAME } from '@app/shared';
import request from 'supertest';

import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { IS_PUBLIC_KEY } from '../../src/auth/decorators/public.decorator';
import { ANDROID_APP_SETTINGS_KEY } from '../../src/android-app/android-app.schema';
import { AndroidReleaseAdminController } from '../../src/android-app/releases/android-release-admin.controller';
import { AndroidReleaseController } from '../../src/android-app/releases/android-release.controller';
import { deriveSigningKey } from '../../src/common/crypto/secret-cipher';
import { signDownloadToken } from '../../src/android-app/releases/download-token';
import { StorageConfigService } from '../../src/storage/config/storage-config.service';
import { STORAGE_PROVIDER, type StorageProvider } from '../../src/storage/providers/storage-provider.interface';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockInactiveUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

const ADMIN = '/api/admin/android-app/releases';
const LATEST = '/api/android-app/releases/latest';
const SHA = Array.from({ length: 32 }, () => 'AB').join(':');
const PKG = ANDROID_PACKAGE_NAME;
const MISSING_ID = '99999999-9999-4999-8999-999999999999';

function apkBytes(size = 4096): Buffer {
  const body = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) body[i] = (i * 31) % 251;
  Buffer.from('PK\x03\x04', 'latin1').copy(body, 0);
  return body;
}

/** An object store that really consumes upload streams. */
class MemoryStorage {
  objects = new Map<string, Buffer>();
  upload = jest.fn(async (key: string, stream: Readable) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    this.objects.set(key, Buffer.concat(chunks));
    return { key, bucket: 'test-bucket', location: `test-bucket/${key}` };
  });
  download = jest.fn(async (key: string) => {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error(`no object ${key}`);
    return Readable.from([bytes]);
  });
  delete = jest.fn(async (key: string) => {
    this.objects.delete(key);
  });
}

type Row = Record<string, any>;

/** The `android_app_releases` table, including its unique indexes. */
function installReleaseTable(prisma: any, users: () => Map<string, Row>) {
  const rows: Row[] = [];
  const withUploader = (row: Row, include?: any) => {
    if (!include?.uploadedBy) return { ...row };
    const user = row.uploadedById ? users().get(row.uploadedById) : null;
    return {
      ...row,
      uploadedBy: user ? { id: user.id, email: user.email, displayName: user.displayName ?? null } : null,
    };
  };
  const matches = (row: Row, where: any = {}) =>
    Object.entries(where).every(([key, value]: [string, any]) => {
      if (key === 'packageName_versionCode') {
        return row.packageName === value.packageName && row.versionCode === value.versionCode;
      }
      if (value && typeof value === 'object' && 'not' in value) return row[key] !== value.not;
      return row[key] === value;
    });
  const unique = (error: string) => {
    const { Prisma } = jest.requireActual('@prisma/client');
    return new Prisma.PrismaClientKnownRequestError(`Unique constraint failed: ${error}`, {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: error },
    });
  };

  prisma.androidAppRelease.findUnique.mockImplementation(async ({ where, include }: any) => {
    const row = rows.find((r) => matches(r, where));
    return row ? withUploader(row, include) : null;
  });
  prisma.androidAppRelease.findFirst.mockImplementation(async ({ where, include }: any = {}) => {
    const row = rows.find((r) => matches(r, where));
    return row ? withUploader(row, include) : null;
  });
  prisma.androidAppRelease.findMany.mockImplementation(async ({ include }: any = {}) =>
    [...rows].sort((a, b) => b.createdAt - a.createdAt).map((row) => withUploader(row, include)),
  );
  prisma.androidAppRelease.create.mockImplementation(async ({ data, include }: any) => {
    if (rows.some((r) => r.packageName === data.packageName && r.versionCode === data.versionCode)) {
      throw unique('android_app_releases_package_name_version_code_key');
    }
    if (data.isCurrent && rows.some((r) => r.isCurrent)) throw unique('android_app_releases_one_current_uniq_idx');
    const row = { notes: null, createdAt: new Date(Date.now() + rows.length), ...data };
    rows.push(row);
    return withUploader(row, include);
  });
  prisma.androidAppRelease.updateMany.mockImplementation(async ({ where, data }: any) => {
    const hit = rows.filter((r) => matches(r, where));
    hit.forEach((r) => Object.assign(r, data));
    return { count: hit.length };
  });
  prisma.androidAppRelease.update.mockImplementation(async ({ where, data, include }: any) => {
    const row = rows.find((r) => matches(r, where));
    if (!row) throw new Error('not found');
    if (data.isCurrent && rows.some((r) => r.isCurrent && r !== row)) {
      throw unique('android_app_releases_one_current_uniq_idx');
    }
    Object.assign(row, data);
    return withUploader(row, include);
  });
  prisma.androidAppRelease.deleteMany.mockImplementation(async ({ where }: any) => {
    const before = rows.length;
    for (let i = rows.length - 1; i >= 0; i -= 1) if (matches(rows[i], where)) rows.splice(i, 1);
    return { count: before - rows.length };
  });
  return rows;
}

describe('Android APK releases (Integration)', () => {
  let context: TestContext;
  let storage: MemoryStorage;
  let storageConfigured = true;
  let rows: Row[];
  let trusted: unknown;
  const registry = new Map<string, Row>();

  beforeAll(async () => {
    storage = new MemoryStorage();
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [{ provide: STORAGE_PROVIDER, useValue: storage as unknown as StorageProvider }],
    });
    const storageConfig = context.module.get(StorageConfigService, { strict: false });
    jest.spyOn(storageConfig, 'resolve').mockImplementation(async () =>
      storageConfigured
        ? ({ configured: true, config: {} } as never)
        : ({ configured: false, provider: 's3', missing: ['bucket'] } as never),
    );
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
    if (ORIGINAL_KEY_ENV === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = ORIGINAL_KEY_ENV;
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    storage.objects.clear();
    storage.upload.mockClear();
    storage.delete.mockClear();
    storageConfigured = true;
    trusted = undefined;
    registry.clear();

    const prisma = context.prismaMock;
    const findUser = prisma.user.findUnique.getMockImplementation();
    prisma.user.findUnique.mockImplementation(async (args: any) => {
      const user = await findUser(args);
      if (user) registry.set(user.id, user);
      return user;
    });
    rows = installReleaseTable(prisma, () => registry);

    const globalFindUnique = prisma.systemSettings.findUnique.getMockImplementation();
    prisma.systemSettings.findUnique.mockImplementation(async (args: { where: { key: string } }) => {
      if (args.where.key === ANDROID_APP_SETTINGS_KEY) {
        return trusted === undefined ? null : { key: ANDROID_APP_SETTINGS_KEY, value: trusted, version: 1 };
      }
      return globalFindUnique ? globalFindUnique(args) : null;
    });
    prisma.systemSettings.upsert.mockImplementation(async (args: any) => {
      trusted = args.create.value;
      return { key: args.where.key, value: args.create.value, version: 1 };
    });
    prisma.healthSyncDevice.groupBy.mockResolvedValue([]);
  });

  const server = () => context.app.getHttpServer();

  async function admin() {
    const user = await createMockAdminUser(context);
    registry.set(user.id, { id: user.id, email: user.email, displayName: null, isActive: true });
    return { user, headers: authHeader(user.accessToken) };
  }

  function upload(headers: Record<string, string>, fields: Record<string, string>, file: Buffer | null = apkBytes()) {
    let req = request(server()).post(ADMIN).set(headers);
    for (const [name, value] of Object.entries(fields)) req = req.field(name, value);
    if (file) req = req.attach('apk', file, { filename: 'app-release.apk', contentType: 'application/octet-stream' });
    return req;
  }

  const fields = (versionCode: number, extra: Record<string, string> = {}) => ({
    packageName: PKG,
    versionName: `0.${versionCode}.0`,
    versionCode: String(versionCode),
    signingSha256: SHA,
    ...extra,
  });

  describe('permissions', () => {
    it('declares system_settings strings on the admin routes and none on the user routes', () => {
      const admin = AndroidReleaseAdminController.prototype;
      expect(Reflect.getMetadata(PERMISSIONS_KEY, admin.upload)).toEqual(['system_settings:write']);
      expect(Reflect.getMetadata(PERMISSIONS_KEY, admin.list)).toEqual(['system_settings:read']);
      expect(Reflect.getMetadata(PERMISSIONS_KEY, admin.makeCurrent)).toEqual(['system_settings:write']);
      expect(Reflect.getMetadata(PERMISSIONS_KEY, admin.remove)).toEqual(['system_settings:write']);

      const user = AndroidReleaseController.prototype;
      expect(Reflect.getMetadata(PERMISSIONS_KEY, user.latest) ?? []).toEqual([]);
      expect(Reflect.getMetadata(PERMISSIONS_KEY, user.downloadLink) ?? []).toEqual([]);
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, user.download)).toBe(true);
    });

    it('refuses unauthenticated callers on every non-public route', async () => {
      await request(server()).get(ADMIN).expect(401);
      await upload({}, fields(1)).expect(401);
      await request(server()).post(`${ADMIN}/${MISSING_ID}/make-current`).expect(401);
      await request(server()).delete(`${ADMIN}/${MISSING_ID}`).expect(401);
      await request(server()).get(LATEST).expect(401);
      await request(server()).post(`/api/android-app/releases/${MISSING_ID}/download-link`).expect(401);
    });

    it('refuses a viewer and a contributor on the admin routes with 403', async () => {
      for (const user of [await createMockViewerUser(context), await createMockContributorUser(context)]) {
        const headers = authHeader(user.accessToken);
        await request(server()).get(ADMIN).set(headers).expect(403);
        await upload(headers, fields(1)).expect(403);
        await request(server()).post(`${ADMIN}/${MISSING_ID}/make-current`).set(headers).expect(403);
        await request(server()).delete(`${ADMIN}/${MISSING_ID}`).set(headers).expect(403);
      }
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('lets a viewer read the latest release and ask for a download link', async () => {
      const { headers } = await admin();
      const { body } = await upload(headers, fields(1)).expect(201);
      const viewer = authHeader((await createMockViewerUser(context)).accessToken);

      await request(server()).get(LATEST).set(viewer).expect(200);
      await request(server()).post(`/api/android-app/releases/${body.data.id}/download-link`).set(viewer).expect(200);
    });
  });

  describe('POST /api/admin/android-app/releases', () => {
    it('streams the APK to storage, records its size and SHA-256, makes it current and trusts its key', async () => {
      const { user, headers } = await admin();
      const apk = apkBytes(10_000);

      const { body } = await upload(headers, fields(3, { notes: 'First build' }), apk).expect(201);

      expect(body.data).toEqual({
        id: expect.any(String),
        packageName: PKG,
        versionName: '0.3.0',
        versionCode: 3,
        fileSha256: createHash('sha256').update(apk).digest('hex'),
        sizeBytes: apk.length,
        notes: 'First build',
        createdAt: expect.any(String),
        signingSha256: SHA,
        isCurrent: true,
        uploadedBy: { id: user.id, email: user.email, displayName: null },
      });
      const key = `android-releases/${body.data.id}.apk`;
      expect(storage.objects.get(key)?.equals(apk)).toBe(true);
      expect(storage.upload).toHaveBeenCalledWith(key, expect.anything(), expect.objectContaining({
        mimeType: 'application/vnd.android.package-archive',
      }));
      expect(trusted).toEqual({ trustedApps: [{ packageName: PKG, sha256: SHA }] });
      expect(context.prismaMock.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'android_app.release.uploaded',
          targetType: 'android_app_release',
          targetId: body.data.id,
        }),
      });
    });

    it('accepts the fields after the file too', async () => {
      const { headers } = await admin();
      let req = request(server()).post(ADMIN).set(headers).attach('apk', apkBytes(), 'a.apk');
      for (const [name, value] of Object.entries(fields(4))) req = req.field(name, value);

      const { body } = await req.expect(201);
      expect(body.data.versionCode).toBe(4);
    });

    it('does not make it current or trust it with makeCurrent=false', async () => {
      const { headers } = await admin();
      const { body } = await upload(headers, fields(1, { makeCurrent: 'false' })).expect(201);

      expect(body.data.isCurrent).toBe(false);
      expect(trusted).toBeUndefined();
    });

    it('refuses a file without the ZIP signature (400 RELEASE_NOT_AN_APK) and keeps nothing', async () => {
      const { headers } = await admin();
      const { body } = await upload(headers, fields(1), Buffer.from('MZ\x90\x00 not a zip at all')).expect(400);

      expect(body.details.reason).toBe('RELEASE_NOT_AN_APK');
      expect(storage.objects.size).toBe(0);
      expect(rows).toHaveLength(0);
    });

    it('refuses an upload without the apk field, or with the file under another name', async () => {
      const { headers } = await admin();
      expect((await upload(headers, fields(1), null).expect(400)).body.details.reason).toBe('RELEASE_INVALID_UPLOAD');

      const { body } = await request(server())
        .post(ADMIN)
        .set(headers)
        .field('packageName', PKG)
        .attach('file', apkBytes(), 'a.apk')
        .expect(400);
      expect(body.details.reason).toBe('RELEASE_INVALID_UPLOAD');
    });

    it('refuses a non-multipart body', async () => {
      const { headers } = await admin();
      await request(server()).post(ADMIN).set(headers).send(fields(1)).expect(400);
    });

    it.each([
      ['a versionCode of 0', { versionCode: '0' }],
      ['a versionCode above 2_100_000_000', { versionCode: '2100000001' }],
      ['a bad package name', { packageName: 'app' }],
      ['a bad fingerprint', { signingSha256: 'AB:CD' }],
      ['an unknown field', { flavour: 'beta' }],
    ])('refuses %s with 400 and stores nothing', async (_label, override) => {
      const { headers } = await admin();
      const { body } = await upload(headers, { ...fields(1), ...override }).expect(400);

      expect(body.details.reason).toBe('RELEASE_INVALID_UPLOAD');
      expect(body.details.issues.length).toBeGreaterThan(0);
      expect(storage.objects.size).toBe(0);
    });

    it('refuses a versionCode that already exists for the package (409 RELEASE_VERSION_EXISTS)', async () => {
      const { headers } = await admin();
      await upload(headers, fields(2, { makeCurrent: 'false' })).expect(201);
      storage.upload.mockClear();

      const { body } = await upload(headers, fields(2, { makeCurrent: 'false' })).expect(409);
      expect(body.details.reason).toBe('RELEASE_VERSION_EXISTS');
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('refuses a current upload not newer than the current release, unless forced', async () => {
      const { headers } = await admin();
      await upload(headers, fields(5)).expect(201);

      const { body } = await upload(headers, fields(4)).expect(409);
      expect(body.details).toMatchObject({ reason: 'RELEASE_VERSION_NOT_NEWER', currentVersionCode: 5 });

      // Not current: allowed. Forced: allowed and now current.
      await upload(headers, fields(3, { makeCurrent: 'false' })).expect(201);
      const forced = await upload(headers, fields(2, { force: 'true' })).expect(201);
      expect(forced.body.data.isCurrent).toBe(true);
      expect(rows.filter((row) => row.isCurrent)).toHaveLength(1);
    });

    it('answers 503 when object storage is not configured, before reading the file', async () => {
      storageConfigured = false;
      const { headers } = await admin();

      const { body } = await upload(headers, fields(1)).expect(503);
      expect(body.details.reason).toBe('storage_not_configured');
      expect(storage.upload).not.toHaveBeenCalled();
    });
  });

  describe('list, make-current and delete', () => {
    it('lists newest first in { data }, marking the current one', async () => {
      const { headers } = await admin();
      await upload(headers, fields(1)).expect(201);
      await upload(headers, fields(2)).expect(201);

      const { body } = await request(server()).get(ADMIN).set(headers).expect(200);
      expect(body.data.map((r: Row) => [r.versionCode, r.isCurrent])).toEqual([
        [2, true],
        [1, false],
      ]);
    });

    it('make-current swaps the current release (rollback allowed) and audits it', async () => {
      const { headers } = await admin();
      const first = (await upload(headers, fields(1)).expect(201)).body.data;
      await upload(headers, fields(2)).expect(201);

      const { body } = await request(server()).post(`${ADMIN}/${first.id}/make-current`).set(headers).expect(200);

      expect(body.data).toMatchObject({ id: first.id, isCurrent: true });
      expect(rows.filter((row) => row.isCurrent).map((row) => row.id)).toEqual([first.id]);
      expect(context.prismaMock.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'android_app.release.made_current', targetId: first.id }),
      });
    });

    it('make-current and delete answer 404 for an unknown id and 400 for a non-UUID', async () => {
      const { headers } = await admin();
      const missing = await request(server()).post(`${ADMIN}/${MISSING_ID}/make-current`).set(headers).expect(404);
      expect(missing.body.details.reason).toBe('RELEASE_NOT_FOUND');
      await request(server()).delete(`${ADMIN}/${MISSING_ID}`).set(headers).expect(404);
      await request(server()).delete(`${ADMIN}/not-a-uuid`).set(headers).expect(400);
    });

    it('deletes a release and its stored APK, but never the current one', async () => {
      const { headers } = await admin();
      const old = (await upload(headers, fields(1)).expect(201)).body.data;
      const current = (await upload(headers, fields(2)).expect(201)).body.data;

      const refused = await request(server()).delete(`${ADMIN}/${current.id}`).set(headers).expect(409);
      expect(refused.body.details.reason).toBe('RELEASE_IS_CURRENT');

      await request(server()).delete(`${ADMIN}/${old.id}`).set(headers).expect(204);
      expect(storage.delete).toHaveBeenCalledWith(`android-releases/${old.id}.apk`);
      expect(storage.objects.has(`android-releases/${old.id}.apk`)).toBe(false);
      expect(rows.map((row) => row.id)).toEqual([current.id]);
    });
  });

  describe('latest and downloads', () => {
    it('latest is 404 NO_RELEASE until a release is current, then the public fields only', async () => {
      const { headers } = await admin();
      expect((await request(server()).get(LATEST).set(headers).expect(404)).body.details.reason).toBe('NO_RELEASE');

      const created = (await upload(headers, fields(1, { notes: 'n' })).expect(201)).body.data;
      const { body } = await request(server()).get(LATEST).set(headers).expect(200);
      expect(body.data).toEqual({
        id: created.id,
        packageName: PKG,
        versionName: '0.1.0',
        versionCode: 1,
        fileSha256: created.fileSha256,
        sizeBytes: created.sizeBytes,
        notes: 'n',
        createdAt: created.createdAt,
      });
    });

    it('streams the exact bytes through a signed link, with the APK headers', async () => {
      const { headers } = await admin();
      const apk = apkBytes(20_000);
      const created = (await upload(headers, fields(7), apk).expect(201)).body.data;

      const link = await request(server())
        .post(`/api/android-app/releases/${created.id}/download-link`)
        .set(headers)
        .expect(200);
      expect(link.body.data.url).toMatch(/^\/api\/android-app\/download\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(new Date(link.body.data.expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60 * 1000);

      const response = await request(server())
        .get(link.body.data.url)
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(response.headers['content-type']).toBe('application/vnd.android.package-archive');
      expect(response.headers['content-disposition']).toBe(`attachment; filename="${ANDROID_APK_STEM}-0.7.0.apk"`);
      expect(response.headers['content-length']).toBe(String(apk.length));
      expect((response.body as Buffer).equals(apk)).toBe(true);
    });

    it('download-link is 404 for an unknown release', async () => {
      const { headers } = await admin();
      const { body } = await request(server())
        .post(`/api/android-app/releases/${MISSING_ID}/download-link`)
        .set(headers)
        .expect(404);
      expect(body.details.reason).toBe('RELEASE_NOT_FOUND');
    });

    it('answers 404 for a malformed or tampered token and 410 for an expired one', async () => {
      const { user, headers } = await admin();
      const created = (await upload(headers, fields(1)).expect(201)).body.data;
      const key = deriveSigningKey('android-app-download');
      const now = Math.floor(Date.now() / 1000);

      const bad = await request(server()).get('/api/android-app/download/not-a-token').expect(404);
      expect(bad.body.details.reason).toBe('DOWNLOAD_LINK_INVALID');

      const valid = signDownloadToken(key, { releaseId: created.id, userId: user.id, expiresAt: now + 60 });
      const tampered = `${valid.slice(0, -2)}${valid.endsWith('AA') ? 'BB' : 'AA'}`;
      await request(server()).get(`/api/android-app/download/${tampered}`).expect(404);

      const expired = signDownloadToken(key, { releaseId: created.id, userId: user.id, expiresAt: now - 1 });
      const gone = await request(server()).get(`/api/android-app/download/${expired}`).expect(410);
      expect(gone.body.details.reason).toBe('DOWNLOAD_LINK_EXPIRED');
    });

    it('answers 404 once the release is deleted or the user deactivated', async () => {
      const { user, headers } = await admin();
      await upload(headers, fields(1)).expect(201);
      const old = (await upload(headers, fields(2, { makeCurrent: 'false' })).expect(201)).body.data;
      const key = deriveSigningKey('android-app-download');
      const exp = Math.floor(Date.now() / 1000) + 60;

      const token = signDownloadToken(key, { releaseId: old.id, userId: user.id, expiresAt: exp });
      await request(server()).delete(`${ADMIN}/${old.id}`).set(headers).expect(204);
      await request(server()).get(`/api/android-app/download/${token}`).expect(404);

      const inactive = await createMockInactiveUser(context);
      const current = rows.find((row) => row.isCurrent)!;
      const forInactive = signDownloadToken(key, { releaseId: current.id, userId: inactive.id, expiresAt: exp });
      await request(server()).get(`/api/android-app/download/${forInactive}`).expect(404);
    });
  });
});
