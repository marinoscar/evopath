// =============================================================================
// AI RBAC matrix — cross-cutting conformance (issue #435, epic #419)
// =============================================================================
//
// Every route under `/api/ai/*` and `/api/admin/ai/*`, DISCOVERED from the
// real Nest router (never hand-listed — same technique as
// `ai-kill-switch.integration.spec.ts`), crossed against Admin / Contributor /
// Viewer / unauthenticated, with the EXPECTED permission read off each
// route's own `x-rbac` metadata (`@Auth()`'s vendor extension) rather than
// re-declared by hand — and the seeded grant for each role read from
// `prisma/seed-data.ts`'s own `ROLE_PERMISSIONS`, the actual source of truth
// a fresh deployment seeds. A route or a seed changing without the other
// catching up fails this suite, not a reviewer's memory.
//
// DISTINGUISHING "DENIED BY RBAC" FROM "DENIED FOR A BUSINESS REASON". Both
// can be 403. `PermissionsGuard` throws a bare `ForbiddenException` with no
// `details` (`permissions.guard.ts`: "Missing permissions: …"); every AI
// business refusal (`AI_KEY_REQUIRED`, `AI_DISABLED`, …) is an `AiError`,
// which always carries `details.reason` (`ai-error.ts`). So a case that
// EXPECTS the permission to be held only requires the response NOT be a
// bare, reason-less 403 — it does not require a full 200, which would need a
// working key and model for every role this matrix exercises.
//
// PAT. `pat-universality.integration.spec.ts` already proves the general
// claim ("a PAT is accepted anywhere a session is, with no narrower scope")
// against unrelated controllers; this suite re-proves it specifically for
// the AI surface's own permission boundary — an Admin's PAT reaches
// `/api/admin/ai/*`, a Viewer's PAT does not. THERE IS NO PAT SCOPE CONCEPT
// in this schema (`PersonalAccessToken` carries no `scopes` column — see
// `prisma/schema.prisma`), so "PAT with and without scopes" in the issue's
// language is answered here as "a PAT inherits its owner's role grants,
// exactly like a session" rather than as a narrower-grant test that has
// nothing in this codebase to exercise.
// =============================================================================

import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';

import { createOpenApiDocument } from '../../src/openapi/document';
import { forEachOperation, MutableDocument } from '../../src/openapi/types';
import { RBAC_EXTENSION_KEY, type RbacExtension } from '../../src/auth/decorators/auth.decorator';
import { ROLE_PERMISSIONS } from '../../prisma/seed-data';
import { createMockTestUser, authHeader } from '../helpers/auth-mock.helper';
import { createAiHttpTestApp, type AiHttpTestApp } from './ai-http.helper';

interface AiRoute {
  path: string;
  method: string;
  permissions: string[];
}

function concretePath(path: string): string {
  return path.replace(/\{[^}]+\}/g, 'test-value');
}

/** True when the response is a bare, reason-less permission denial. */
function isPermissionDenied(res: request.Response): boolean {
  return res.status === 403 && res.body?.details === undefined;
}

const ROLES = ['admin', 'contributor', 'viewer'] as const;

describe('AI RBAC matrix — every /api/ai/* and /api/admin/ai/* route x every role (#435)', () => {
  let app: AiHttpTestApp;
  let aiAndAdminRoutes: AiRoute[];
  const tokensByRole: Record<(typeof ROLES)[number], string> = { admin: '', contributor: '', viewer: '' };

  beforeAll(async () => {
    app = await createAiHttpTestApp(); // enabled: true, byok — RBAC is what is under test, not the kill switch.

    const document = createOpenApiDocument(app.context.app) as unknown as MutableDocument;
    aiAndAdminRoutes = [];

    forEachOperation(document, (operation, path, method) => {
      if (!path.startsWith('/api/ai') && !path.startsWith('/api/admin/ai')) return;

      const rbac = operation[RBAC_EXTENSION_KEY] as RbacExtension | undefined;
      aiAndAdminRoutes.push({ path, method: method.toUpperCase(), permissions: rbac?.permissions ?? [] });
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    app.reset();

    // A few routes (`UserAiKeysService`, `UsableModelsService`,
    // `AiModelsAdminService`) are REAL providers reading the REAL, mocked
    // `PrismaService` directly — not overridden by the harness, unlike
    // `AiService`/`AiRunsService`/`AiConfigService`. This matrix only cares
    // whether `PermissionsGuard` let the request through, not whether the
    // business logic behind it fully succeeds, so a bare empty result is
    // enough to keep those routes from throwing on an unmocked call.
    app.context.prismaMock.userAiKey.findMany.mockResolvedValue([]);
    app.context.prismaMock.userAiKey.deleteMany.mockResolvedValue({ count: 0 });
    app.context.prismaMock.aiModel.findMany.mockResolvedValue([]);
    app.context.prismaMock.aiModel.count.mockResolvedValue(0);

    for (const role of ROLES) {
      const user = await createMockTestUser(app.context, { roleName: role });
      tokensByRole[role] = user.accessToken;
    }
  });

  it('discovers a non-trivial route set carrying real x-rbac metadata', () => {
    expect(aiAndAdminRoutes.length).toBeGreaterThanOrEqual(15);
    expect(aiAndAdminRoutes.filter((r) => r.permissions.length > 0).length).toBeGreaterThanOrEqual(10);
  });

  it('every declared permission is one of the three literal AI permission strings — never invented, never dropped', () => {
    // Anchors the discovery itself: the role-vs-permission matrix below only
    // checks that DECLARED and ENFORCED agree with each other, so a route
    // that quietly lost its `@Auth({ permissions: [...] })` entirely would
    // adjust its own expectation downward and slip through undetected. This
    // pins each route's declaration against a fixed, external expectation
    // instead: every `/api/admin/ai/*` route names `ai_config:read` or
    // `ai_config:write` and nothing else; every `/api/ai/*` route names
    // `ai:use` and nothing else, except `GET /api/ai/config`, which names no
    // permission at all (any signed-in user).
    const failures: string[] = [];

    for (const route of aiAndAdminRoutes) {
      if (route.path === '/api/ai/config' && route.method === 'GET') {
        if (route.permissions.length !== 0) {
          failures.push(`${route.method} ${route.path}: expected no permission, got ${JSON.stringify(route.permissions)}`);
        }
        continue;
      }

      if (route.path.startsWith('/api/admin/ai')) {
        const ok =
          route.permissions.length === 1 &&
          (route.permissions[0] === 'ai_config:read' || route.permissions[0] === 'ai_config:write');
        if (!ok) failures.push(`${route.method} ${route.path}: expected exactly one ai_config:* permission, got ${JSON.stringify(route.permissions)}`);
        continue;
      }

      const ok = route.permissions.length === 1 && route.permissions[0] === 'ai:use';
      if (!ok) failures.push(`${route.method} ${route.path}: expected exactly ['ai:use'], got ${JSON.stringify(route.permissions)}`);
    }

    expect(failures).toEqual([]);
  });

  describe('unauthenticated', () => {
    it('every route answers 401, whatever permission it declares', async () => {
      const failures: string[] = [];

      for (const route of aiAndAdminRoutes) {
        const res = await request(app.context.app.getHttpServer())
          [route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](
            concretePath(route.path),
          )
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

      for (const route of aiAndAdminRoutes) {
        const shouldHold = route.permissions.every((p) => granted.has(p));

        const res = await request(app.context.app.getHttpServer())
          [route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](
            concretePath(route.path),
          )
          .set(authHeader(tokensByRole[role]))
          .send({});

        const denied = isPermissionDenied(res);

        if (shouldHold && denied) {
          failures.push(`${route.method} ${route.path}: ${role} holds ${JSON.stringify(route.permissions)} but was denied`);
        } else if (!shouldHold && !denied) {
          failures.push(
            `${route.method} ${route.path}: ${role} lacks ${JSON.stringify(route.permissions)} but was not denied (status ${res.status})`,
          );
        }
      }

      expect(failures).toEqual([]);
    });
  });

  describe('a PAT inherits its owner\'s role grants, exactly like a session', () => {
    async function givenLivePatFor(userId: string, rawToken: string): Promise<void> {
      const fullUser = await (app.context.prismaMock.user.findUnique as jest.Mock)({ where: { id: userId } });
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const expectedHash = createHash('sha256').update(rawToken).digest('hex');

      (app.context.prismaMock.personalAccessToken.findUnique as jest.Mock).mockImplementation(
        async ({ where }: { where: { tokenHash: string } }) => {
          if (where.tokenHash !== expectedHash) return null;

          return {
            id: randomUUID(),
            userId,
            name: 'RBAC matrix fixture',
            tokenHash: expectedHash,
            tokenPrefix: rawToken.slice(0, 8),
            expiresAt,
            lastUsedAt: null,
            revokedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            user: fullUser,
          };
        },
      );
      (app.context.prismaMock.personalAccessToken.update as jest.Mock).mockResolvedValue({});
    }

    it('an admin PAT reaches /api/admin/ai/config; a viewer PAT does not', async () => {
      const admin = await createMockTestUser(app.context, { roleName: 'admin' });
      const viewer = await createMockTestUser(app.context, { roleName: 'viewer' });

      await givenLivePatFor(admin.id, 'pat_rbac_admin_fixture');
      const adminRes = await request(app.context.app.getHttpServer())
        .get('/api/admin/ai/config')
        .set(authHeader('pat_rbac_admin_fixture'));
      expect(isPermissionDenied(adminRes)).toBe(false);

      await givenLivePatFor(viewer.id, 'pat_rbac_viewer_fixture');
      const viewerRes = await request(app.context.app.getHttpServer())
        .get('/api/admin/ai/config')
        .set(authHeader('pat_rbac_viewer_fixture'));
      expect(isPermissionDenied(viewerRes)).toBe(true);
    });

    it('a viewer PAT reaches GET /api/ai/config exactly as a viewer session does', async () => {
      const viewer = await createMockTestUser(app.context, { roleName: 'viewer' });
      await givenLivePatFor(viewer.id, 'pat_rbac_viewer_config_fixture');

      const res = await request(app.context.app.getHttpServer())
        .get('/api/ai/config')
        .set(authHeader('pat_rbac_viewer_config_fixture'))
        .expect(200);

      expect(res.body.data.enabled).toBe(true);
    });
  });
});
