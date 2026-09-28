// =============================================================================
// Storage Configuration Integration (issue #375, epic #372)
// =============================================================================
//
// HTTP-level coverage for the four `/api/admin/storage-config*` routes, modelled
// on `push-config.integration.spec.ts`:
//
//   * RBAC: `storage_config:read` gates the GET, `storage_config:write` gates
//     every write — asserted both as declared metadata (drift-proof against a
//     route that silently changes its guard) and by driving real 401s and 403s.
//   * `If-Match`, including the malformed-header case, which is the one that
//     turns a settings page into an unrecoverable 409 loop when it is wrong.
//   * The `SWITCH` confirmation gate, end to end, against seeded row counts.
//   * ⚠ THE SECRET NEVER APPEARS IN ANY RESPONSE BODY, on any of the four
//     routes, including when the object store echoed it back inside an error.
//   * The two probes answer 200 with a verdict in the body rather than a 4xx.
//
// `CredentialsService` is overridden with a controllable stub; everything else
// — the controller, the three services, the guards, the validation pipe — is
// the REAL class `AppModule` wires, which is the boundary a production request
// crosses. The AWS SDK is mocked at the module level so no test here opens a
// socket; `fetch` is stubbed for the same reason.
// =============================================================================

const s3SendMock = jest.fn();
const s3DestroyMock = jest.fn();

function commandMock(name: string) {
  return jest.fn().mockImplementation((input: unknown) => ({ __command: name, input }));
}

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: s3SendMock,
    destroy: s3DestroyMock,
  })),
  HeadBucketCommand: commandMock('HeadBucketCommand'),
  ListBucketsCommand: commandMock('ListBucketsCommand'),
  PutObjectCommand: commandMock('PutObjectCommand'),
  GetObjectCommand: commandMock('GetObjectCommand'),
  DeleteObjectCommand: commandMock('DeleteObjectCommand'),
  CreateBucketCommand: commandMock('CreateBucketCommand'),
  PutBucketCorsCommand: commandMock('PutBucketCorsCommand'),
  PutBucketEncryptionCommand: commandMock('PutBucketEncryptionCommand'),
  PutPublicAccessBlockCommand: commandMock('PutPublicAccessBlockCommand'),
  HeadObjectCommand: commandMock('HeadObjectCommand'),
  CopyObjectCommand: commandMock('CopyObjectCommand'),
  CreateMultipartUploadCommand: commandMock('CreateMultipartUploadCommand'),
  UploadPartCommand: commandMock('UploadPartCommand'),
  CompleteMultipartUploadCommand: commandMock('CompleteMultipartUploadCommand'),
  AbortMultipartUploadCommand: commandMock('AbortMultipartUploadCommand'),
  NotFound: class MockNotFound extends Error {},
}));

jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn().mockImplementation(() => ({ done: jest.fn() })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://example.invalid/presigned'),
}));

import request from 'supertest';
import { JwtService } from '@nestjs/jwt';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockAdminUser,
  createMockViewerUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { CredentialsService } from '../../src/credentials/credentials.service';
import { StorageConfigController } from '../../src/storage/config/storage-config.controller';

const BASE = '/api/admin/storage-config';

/**
 * ⚠ The value that must never come back out of the API. It is handed to the
 * stubbed credential store as plaintext AND echoed inside a provider error, so
 * both the "never serialise it" rule and the redaction path are exercised.
 */
const KNOWN_SECRET = 'do-not-leak-this-storage-secret-Xk9q2';

const SAVED_STORAGE = {
  provider: 's3',
  bucket: 'live-bucket',
  region: 'us-west-2',
  endpoint: '',
  accountId: '',
  accessKeyId: 'AKIAEXAMPLE',
  forcePathStyle: null,
};

/** A complete PUT/test/bucket body. */
function body(overrides: Record<string, unknown> = {}) {
  return { ...SAVED_STORAGE, secretAccessKey: '', ...overrides };
}

describe('Storage Configuration Integration', () => {
  let context: TestContext;
  let mockCredentials: {
    describe: jest.Mock;
    setSecret: jest.Mock;
    getSecret: jest.Mock;
    deleteSecret: jest.Mock;
  };

  beforeAll(async () => {
    mockCredentials = {
      describe: jest.fn(),
      setSecret: jest.fn(),
      getSecret: jest.fn(),
      deleteSecret: jest.fn(),
    };

    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [{ provide: CredentialsService, useValue: mockCredentials }],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();

    mockCredentials.describe.mockReset().mockResolvedValue({
      purpose: 'storage',
      name: 'default',
      hint: '••••Xk9q2',
      label: 'Storage secret access key',
      updatedByUserId: 'admin-1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-02-02T00:00:00.000Z'),
    });
    mockCredentials.setSecret.mockReset().mockResolvedValue(undefined);
    // Plaintext, as the real store would hand it to a probe at the moment of use.
    mockCredentials.getSecret.mockReset().mockResolvedValue(KNOWN_SECRET);
    mockCredentials.deleteSecret.mockReset().mockResolvedValue(undefined);

    // One row serves all three read shapes (`getStoragePolicy`'s `select`,
    // `loadOrCreateRow`'s `include`, and the admin service's provenance read).
    context.prismaMock.systemSettings.findUnique.mockResolvedValue({
      id: 'settings-global',
      key: 'global',
      value: { storage: SAVED_STORAGE },
      version: 4,
      updatedAt: new Date('2026-03-03T00:00:00.000Z'),
      updatedByUserId: 'admin-1',
      updatedByUser: { id: 'admin-1', email: 'admin@example.com' },
    });
    context.prismaMock.systemSettings.update.mockImplementation(async ({ data }: any) => ({
      id: 'settings-global',
      key: 'global',
      value: data.value,
      version: 5,
      updatedAt: new Date(),
      updatedByUserId: 'admin-1',
      updatedByUser: { id: 'admin-1', email: 'admin@example.com' },
    }));
    context.prismaMock.auditEvent.create.mockResolvedValue({} as never);
    context.prismaMock.storageObject.count.mockResolvedValue(0);
    context.prismaMock.databaseBackupRun.count.mockResolvedValue(0);

    s3SendMock.mockReset();
    s3DestroyMock.mockReset();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'not found',
    }) as unknown as typeof fetch;
  });

  /** A user holding ONLY `storage_config:read` — no write. */
  async function createReadOnlyUser(): Promise<{ accessToken: string }> {
    const jwtService = context.module.get<JwtService>(JwtService);
    const id = 'storage-config-read-only';
    const email = 'storage-config-read-only@example.com';

    context.prismaMock.user.findUnique.mockImplementation(async ({ where }: any) => {
      if (where?.id !== id && where?.email !== email) return null;
      return {
        id,
        email,
        displayName: null,
        providerDisplayName: 'Storage Config Read Only',
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [
          {
            role: {
              id: 'role-storage-config-readonly',
              name: 'storage-config-readonly',
              description: 'Read-only storage configuration access',
              rolePermissions: [
                {
                  permission: {
                    id: 'perm-storage-config-read',
                    name: 'storage_config:read',
                    description: 'View the object-storage configuration',
                  },
                },
              ],
            },
          },
        ],
      };
    });

    return {
      accessToken: jwtService.sign({
        sub: id,
        email,
        roles: ['storage-config-readonly'],
      }),
    };
  }

  // ==========================================================================
  // RBAC — declared metadata (drift-proof)
  // ==========================================================================

  describe('declared permission metadata', () => {
    it.each([
      ['getConfig', 'storage_config:read'],
      ['replaceConfig', 'storage_config:write'],
      ['testConfig', 'storage_config:write'],
      ['provisionBucket', 'storage_config:write'],
    ] as Array<[keyof StorageConfigController, string]>)(
      '%s requires exactly %s',
      (handler, permission) => {
        const target = StorageConfigController.prototype[handler];
        expect(Reflect.getMetadata(PERMISSIONS_KEY, target)).toEqual([permission]);
      },
    );

    it('⚠ uses NEITHER system_settings:* NOR storage:* on any route', () => {
      // `storage:read` is seeded to Viewer, so reusing it here would put the
      // credential-bearing configuration screen in front of every user.
      const declared = (
        ['getConfig', 'replaceConfig', 'testConfig', 'provisionBucket'] as const
      ).flatMap(
        (handler) =>
          (Reflect.getMetadata(
            PERMISSIONS_KEY,
            StorageConfigController.prototype[handler],
          ) as string[]) ?? [],
      );

      expect(declared.every((permission) => permission.startsWith('storage_config:'))).toBe(
        true,
      );
    });
  });

  // ==========================================================================
  // RBAC — driven through real requests
  // ==========================================================================

  describe('RBAC', () => {
    it.each([
      ['GET', BASE, {}],
      ['PUT', BASE, body()],
      ['POST', `${BASE}/test`, body()],
      ['POST', `${BASE}/bucket`, body()],
    ] as Array<['GET' | 'PUT' | 'POST', string, Record<string, unknown>]>)(
      '%s %s: a viewer gets 403',
      async (method, path, payload) => {
        const viewer = await createMockViewerUser(context);

        const req = request(context.app.getHttpServer())[
          method.toLowerCase() as 'get' | 'put' | 'post'
        ](path).set(authHeader(viewer.accessToken));

        await (method === 'GET' ? req : req.send(payload)).expect(403);
      },
    );

    it.each([
      ['PUT', BASE],
      ['POST', `${BASE}/test`],
      ['POST', `${BASE}/bucket`],
    ] as Array<['PUT' | 'POST', string]>)(
      '%s %s: storage_config:read does NOT imply storage_config:write',
      async (method, path) => {
        const readOnly = await createReadOnlyUser();

        await request(context.app.getHttpServer())
          [method.toLowerCase() as 'put' | 'post'](path)
          .set(authHeader(readOnly.accessToken))
          .send(body())
          .expect(403);
      },
    );

    it('GET succeeds for a caller holding only storage_config:read', async () => {
      const readOnly = await createReadOnlyUser();

      await request(context.app.getHttpServer())
        .get(BASE)
        .set(authHeader(readOnly.accessToken))
        .expect(200);
    });

    it('returns 401 without auth on every route', async () => {
      const server = context.app.getHttpServer();

      await request(server).get(BASE).expect(401);
      await request(server).put(BASE).send(body()).expect(401);
      await request(server).post(`${BASE}/test`).send(body()).expect(401);
      await request(server).post(`${BASE}/bucket`).send(body()).expect(401);
    });
  });

  // ==========================================================================
  // ⚠ The secret never appears in a response body
  // ==========================================================================

  describe('the secret access key never appears in any response', () => {
    it('GET returns a mask, never the value', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get(BASE)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain(KNOWN_SECRET);
      expect(response.body.data.secretStatus).toMatchObject({
        configured: true,
        hint: '••••Xk9q2',
      });
      // The identifier half IS returned: an admin who cannot see the key id
      // cannot tell a rotated key from a mistyped one.
      expect(response.body.data.accessKeyId).toBe('AKIAEXAMPLE');
    });

    it('PUT echoes the saved configuration without the secret it was just given', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .put(BASE)
        .set(authHeader(admin.accessToken))
        .send(body({ secretAccessKey: KNOWN_SECRET }))
        .expect(200);

      expect(mockCredentials.setSecret).toHaveBeenCalled();
      expect(JSON.stringify(response.body)).not.toContain(KNOWN_SECRET);
    });

    it('⚠ POST /test redacts it even when the object store echoed it back', async () => {
      const admin = await createMockAdminUser(context);
      const echoed = new Error(
        `SignatureDoesNotMatch: computed for key=${KNOWN_SECRET}`,
      );
      echoed.name = 'SignatureDoesNotMatch';
      (echoed as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 403 };
      s3SendMock.mockRejectedValue(echoed);

      const response = await request(context.app.getHttpServer())
        .post(`${BASE}/test`)
        .set(authHeader(admin.accessToken))
        .send(body())
        .expect(200);

      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain(KNOWN_SECRET);
      expect(serialised).toContain('[redacted]');
      // The stored secret was used because the body left the field blank.
      expect(response.body.data.usedStoredSecret).toBe(true);
    });

    it('POST /bucket redacts it too', async () => {
      const admin = await createMockAdminUser(context);
      const echoed = new Error(`InvalidAccessKeyId: key=${KNOWN_SECRET}`);
      echoed.name = 'InvalidAccessKeyId';
      (echoed as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 403 };
      s3SendMock.mockRejectedValue(echoed);

      const response = await request(context.app.getHttpServer())
        .post(`${BASE}/bucket`)
        .set(authHeader(admin.accessToken))
        .send(body())
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain(KNOWN_SECRET);
    });
  });

  // ==========================================================================
  // If-Match
  // ==========================================================================

  describe('If-Match', () => {
    it('saves when the version matches', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(BASE)
        .set(authHeader(admin.accessToken))
        .set('If-Match', '4')
        .send(body())
        .expect(200);

      expect(context.prismaMock.systemSettings.update).toHaveBeenCalled();
    });

    it('409s on a stale version, and writes nothing', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(BASE)
        .set(authHeader(admin.accessToken))
        .set('If-Match', '3')
        .send(body({ secretAccessKey: 'a-rotation-that-must-not-happen' }))
        .expect(409);

      expect(context.prismaMock.systemSettings.update).not.toHaveBeenCalled();
      // ⚠ The reason the version is checked before the credential is touched.
      expect(mockCredentials.setSecret).not.toHaveBeenCalled();
    });

    it('treats a MALFORMED If-Match as absent rather than as a permanent 409', async () => {
      // `parseInt('abc')` is NaN and `NaN !== version` is always true, so the
      // naive implementation makes every save fail forever.
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(BASE)
        .set(authHeader(admin.accessToken))
        .set('If-Match', 'not-a-number')
        .send(body())
        .expect(200);
    });

    it('omitting it overwrites unconditionally', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(BASE)
        .set(authHeader(admin.accessToken))
        .send(body())
        .expect(200);
    });
  });

  // ==========================================================================
  // The switch confirmation
  // ==========================================================================

  describe('the SWITCH confirmation', () => {
    beforeEach(() => {
      context.prismaMock.storageObject.count.mockResolvedValue(1284);
      context.prismaMock.databaseBackupRun.count.mockResolvedValue(30);
    });

    it('409s with the row counts when a relocation is unconfirmed', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .put(BASE)
        .set(authHeader(admin.accessToken))
        .send(body({ bucket: 'a-different-bucket' }))
        .expect(409);

      expect(response.body.message).toContain('1284 stored object(s)');
      expect(response.body.message).toContain('30 database backup(s)');
      expect(response.body.message).toContain('does NOT copy them');
      expect(context.prismaMock.systemSettings.update).not.toHaveBeenCalled();
    });

    it('saves when the confirmation is present', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(BASE)
        .set(authHeader(admin.accessToken))
        .send(body({ bucket: 'a-different-bucket', confirmation: 'SWITCH' }))
        .expect(200);

      expect(context.prismaMock.systemSettings.update).toHaveBeenCalled();
    });

    it.each([
      ['a lower-case word', 'switch'],
      ["another route's word", 'RESTORE'],
      ['a misspelling', 'SWTICH'],
    ] as Array<[string, string]>)(
      'rejects %s at the DTO layer, before the handler runs',
      async (_label, confirmation) => {
        const admin = await createMockAdminUser(context);

        await request(context.app.getHttpServer())
          .put(BASE)
          .set(authHeader(admin.accessToken))
          .send(body({ bucket: 'a-different-bucket', confirmation }))
          .expect(400);

        expect(context.prismaMock.systemSettings.update).not.toHaveBeenCalled();
      },
    );

    it('is not required for an edit that does not relocate anything', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(BASE)
        .set(authHeader(admin.accessToken))
        .send(body({ region: 'eu-west-1' }))
        .expect(200);
    });
  });

  // ==========================================================================
  // ⚠ Both probes answer 200 with a verdict, not a 4xx
  // ==========================================================================

  describe('the probes answer 200 even when the answer is bad', () => {
    it('POST /test: a refused bucket check is a 200 with success:false', async () => {
      const admin = await createMockAdminUser(context);
      const notFound = new Error('NotFound');
      notFound.name = 'NotFound';
      (notFound as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 404 };
      s3SendMock.mockRejectedValue(notFound);

      const response = await request(context.app.getHttpServer())
        .post(`${BASE}/test`)
        .set(authHeader(admin.accessToken))
        .send(body())
        .expect(200);

      // A caller that reads the status code instead of this field reports
      // success for every misconfiguration there is.
      expect(response.body.data.success).toBe(false);
      expect(response.body.data.checks).toHaveLength(4);
      expect(
        response.body.data.checks.find((check: any) => check.id === 'bucket').code,
      ).toBe('bucket_missing');
    });

    it('POST /bucket: a credential without s3:CreateBucket is a 200 outcome:"guided"', async () => {
      const admin = await createMockAdminUser(context);
      const denied = new Error('AccessDenied');
      denied.name = 'AccessDenied';
      (denied as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 403 };
      s3SendMock.mockRejectedValue(denied);

      const response = await request(context.app.getHttpServer())
        .post(`${BASE}/bucket`)
        .set(authHeader(admin.accessToken))
        .send(body())
        .expect(200);

      expect(response.body.data.outcome).toBe('guided');
      expect(response.body.data.guidance.commands).toContain('live-bucket');
      // ⚠ The one setting whose absence breaks uploads invisibly survives into
      // the guided path.
      expect(response.body.data.guidance.commands).toContain('ETag');
    });

    it('a malformed body is still a 400 — a diagnostic is not an excuse to accept anything', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .post(`${BASE}/test`)
        .set(authHeader(admin.accessToken))
        .send({ provider: 'not-a-provider' })
        .expect(400);
    });
  });

  // ==========================================================================
  // Blank preserves, over HTTP
  // ==========================================================================

  describe('blank preserves', () => {
    it('an empty secretAccessKey does not touch the credential store', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .put(BASE)
        .set(authHeader(admin.accessToken))
        .send(body({ secretAccessKey: '' }))
        .expect(200);

      expect(mockCredentials.setSecret).not.toHaveBeenCalled();
      expect(context.prismaMock.systemSettings.update).toHaveBeenCalled();
    });

    it('an omitted secretAccessKey behaves the same way', async () => {
      const admin = await createMockAdminUser(context);
      const payload = body();
      delete (payload as Record<string, unknown>).secretAccessKey;

      await request(context.app.getHttpServer())
        .put(BASE)
        .set(authHeader(admin.accessToken))
        .send(payload)
        .expect(200);

      expect(mockCredentials.setSecret).not.toHaveBeenCalled();
    });
  });
});
