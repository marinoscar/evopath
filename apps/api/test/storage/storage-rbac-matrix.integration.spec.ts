// =============================================================================
// Storage objects RBAC matrix — cross-cutting conformance (issue #516)
// =============================================================================
//
// Every route under `/api/storage/objects*`, DISCOVERED from the real Nest
// router (never hand-listed — same technique as
// `ai-rbac-matrix.integration.spec.ts`), crossed against Admin / Contributor /
// Viewer / unauthenticated, with the EXPECTED permission read off each
// route's own `x-rbac` metadata (`@Auth()`'s vendor extension) rather than
// re-declared by hand — and the seeded grant for each role read from
// `prisma/seed-data.ts`'s own `ROLE_PERMISSIONS`, the actual source of truth
// a fresh deployment seeds. A route or a seed changing without the other
// catching up fails this suite, not a reviewer's memory.
//
// DISTINGUISHING "DENIED BY RBAC" FROM "DENIED FOR A BUSINESS REASON". Both
// can be 403. `PermissionsGuard` throws a `ForbiddenException` whose message
// is always exactly `Missing permissions: ...` (`permissions.guard.ts`); every
// other 403 this controller can produce — "you do not own this object", "you
// do not own this upload", the profile-image refusal on delete — carries a
// different message. Only that guard's own shape counts as an RBAC denial
// below, so a case that EXPECTS the permission to be held only requires the
// response NOT be that bare guard denial — not a full 200/204, which would
// need a real object row this matrix does not set up per route.
// =============================================================================

import request from 'supertest';

import { createOpenApiDocument } from '../../src/openapi/document';
import { forEachOperation, MutableDocument } from '../../src/openapi/types';
import { RBAC_EXTENSION_KEY, type RbacExtension } from '../../src/auth/decorators/auth.decorator';
import { ROLE_PERMISSIONS } from '../../prisma/seed-data';
import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockTestUser, authHeader } from '../helpers/auth-mock.helper';
import { STORAGE_PROVIDER } from '../../src/storage/providers/storage-provider.interface';
import { createMockStorageProvider } from '../mocks/storage-provider.mock';

interface StorageRoute {
  path: string;
  method: string;
  permissions: string[];
}

type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

function concretePath(path: string): string {
  return path.replace(/\{[^}]+\}/g, '550e8400-e29b-41d4-a716-446655440000');
}

/** True when the response is `PermissionsGuard`'s own, reason-less denial. */
function isPermissionDenied(res: request.Response): boolean {
  return (
    res.status === 403 &&
    typeof res.body?.message === 'string' &&
    res.body.message.startsWith('Missing permissions:')
  );
}

const ROLES = ['admin', 'contributor', 'viewer'] as const;

describe('Storage objects RBAC matrix — every /api/storage/objects* route x every role (#516)', () => {
  let context: TestContext;
  let routes: StorageRoute[];
  const tokensByRole: Record<(typeof ROLES)[number], string> = {
    admin: '',
    contributor: '',
    viewer: '',
  };

  beforeAll(async () => {
    const mockStorageProvider = createMockStorageProvider();
    context = await createTestApp({ useMockDatabase: true });

    const storageProviderToken = context.module.get(STORAGE_PROVIDER, { strict: false });
    if (storageProviderToken) {
      Object.assign(storageProviderToken, mockStorageProvider);
    }

    const document = createOpenApiDocument(context.app) as unknown as MutableDocument;
    routes = [];

    forEachOperation(document, (operation, path, method) => {
      if (!path.startsWith('/api/storage/objects')) return;

      const rbac = operation[RBAC_EXTENSION_KEY] as RbacExtension | undefined;
      routes.push({ path, method: method.toUpperCase(), permissions: rbac?.permissions ?? [] });
    });
  }, 60_000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();

    // Quiets `GET /api/storage/objects` for a role that holds `storage:read`:
    // this matrix only cares whether `PermissionsGuard` let the request
    // through, not whether the business logic behind it fully succeeds (there
    // is no per-route object row set up here), so an empty, valid list is
    // enough to keep a granted role from hitting an unrelated 500.
    context.prismaMock.storageObject.findMany.mockResolvedValue([]);
    context.prismaMock.storageObject.count.mockResolvedValue(0);

    for (const role of ROLES) {
      const user = await createMockTestUser(context, { roleName: role });
      tokensByRole[role] = user.accessToken;
    }
  });

  it('discovers every storage-objects route, each declaring exactly one of storage:read / storage:write', () => {
    expect(routes.length).toBeGreaterThanOrEqual(9);

    const failures = routes
      .filter((r) => !(r.permissions.length === 1 && ['storage:read', 'storage:write'].includes(r.permissions[0])))
      .map((r) => `${r.method} ${r.path}: ${JSON.stringify(r.permissions)}`);

    expect(failures).toEqual([]);
  });

  describe('unauthenticated', () => {
    it('every route answers 401, whatever permission it declares', async () => {
      const failures: string[] = [];

      for (const route of routes) {
        const res = await request(context.app.getHttpServer())
          [route.method.toLowerCase() as HttpMethod](concretePath(route.path))
          .send({});

        if (res.status !== 401) failures.push(`${route.method} ${route.path}: expected 401, got ${res.status}`);
      }

      expect(failures).toEqual([]);
    });
  });

  describe.each(ROLES)('%s (per prisma/seed-data.ts ROLE_PERMISSIONS)', (role) => {
    const granted = new Set(ROLE_PERMISSIONS[role]);

    it('is granted or denied exactly as the seeded permission set says, for every discovered route', async () => {
      const failures: string[] = [];

      for (const route of routes) {
        const shouldHold = route.permissions.every((p) => granted.has(p));

        const res = await request(context.app.getHttpServer())
          [route.method.toLowerCase() as HttpMethod](concretePath(route.path))
          .set(authHeader(tokensByRole[role]))
          .send({});

        const denied = isPermissionDenied(res);

        if (shouldHold && denied) {
          failures.push(`${route.method} ${route.path}: ${role} holds ${JSON.stringify(route.permissions)} but was denied by PermissionsGuard`);
        } else if (!shouldHold && !denied) {
          failures.push(
            `${route.method} ${route.path}: ${role} lacks ${JSON.stringify(route.permissions)} but was not denied (status ${res.status})`,
          );
        }
      }

      expect(failures).toEqual([]);
    });
  });
});
