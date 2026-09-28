// =============================================================================
// Integration tests for GET /api/admin/about (issue #401, epic #397)
// =============================================================================
//
// `src/about/about.service.spec.ts` proves what the service DECIDES. This suite
// exists for the things only the real Nest router, the real guards and the real
// response interceptor can answer, and every case below fails for a reason a
// direct call to the service could not produce.
//
// -----------------------------------------------------------------------------
// ⚠ THE PERMISSIONLESS-ROUTE TRAP, AND WHY A UNIT TEST CANNOT SEE IT
// -----------------------------------------------------------------------------
//
// A route declared as merely AUTHENTICATED — `@UseGuards(JwtAuthGuard)` with no
// permission decorator — may never attach the RESOLVED user to the request.
// `PermissionsGuard` is what resolves and attaches it; without a declared
// permission it does not run, `request.user.permissions` reads as `undefined`,
// and every downstream consumer treats that as an empty set. The route then
// answers a perfectly cheerful 200 with permissioned content silently filtered
// out of it, and no error is logged anywhere.
//
// A unit test CONSTRUCTS the user it passes in, so it supplies exactly the
// permissions it expects to find and proves nothing about whether the request
// pipeline would have produced them. The only thing that can catch this is a
// real HTTP request through the real guard chain, with a real signed token, for
// a caller whose permissions come from where the application actually reads
// them. That is what the RBAC block at the bottom of this file does, in both
// directions: a holder of `system_settings:read` gets a POPULATED 200, and a
// caller without it is refused outright.
//
// The other three reasons this file exists:
//
//   1. ⚠ THE 200 CONTRACT ON THE WIRE. The endpoint's central promise is that a
//      missing document, a malformed one and a dead database are all 200s. Only
//      a real request through the real exception filter can prove that nothing
//      in the pipeline turns one of them into a 404, a 500 or a 503.
//   2. THE ENVELOPE. `TransformInterceptor` wraps the handler's return value in
//      `{ data, meta }`. A unit test compares the INNER object and would pass
//      identically if the envelope were removed.
//   3. THE PERMISSION STRING ITSELF, asserted as metadata. The web settings card
//      that reaches this route must declare the same string byte for byte
//      (CLAUDE.md, Settings UI Pattern rule 3), and a route that had drifted to
//      some other permission would still refuse a viewer and pass every
//      request-level test in this file.
//
// The database is the shared deep mock, so `$queryRaw` is what decides whether
// the liveness probe succeeds — which is precisely the control this suite needs
// and one a real database would not give it on demand.
// =============================================================================

import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';

import { AboutController } from '../../src/about/about.controller';
import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { DEFAULT_DEPLOY_INFO_PATH } from '../../src/about/deploy-info';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';

const ROUTE = '/api/admin/about';

const GOOD_DOCUMENT = {
  schema: 1,
  app: {
    name: 'EnterpriseAppBase',
    version: '1.4.0',
    commitSha: '9f1c2b7e4a5d6c8f0e1a2b3c4d5e6f7a8b9c0d1e',
    ref: 'main',
  },
  installedAt: '2026-01-04T09:00:00.000Z',
  updatedAt: '2026-09-12T18:30:00.000Z',
  deployedBy: { cli: 'appctl', version: '1.4.0' },
  domain: 'app.example.com',
  remote: { commitsBehind: 3, checkedAt: '2026-09-14T06:00:00.000Z' },
  run: { completed: ['pull', 'migrate', 'up'], outcome: 'success' },
};

describe('About API (Integration)', () => {
  let context: TestContext;
  let prisma: any;
  let dir: string;
  let path: string;

  const originalPath = process.env.DEPLOY_INFO_PATH;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);

    if (originalPath === undefined) delete process.env.DEPLOY_INFO_PATH;
    else process.env.DEPLOY_INFO_PATH = originalPath;
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
    prisma = context.prismaMock;

    // The liveness probe's one query. The REAL `DatabaseHealthIndicator` runs
    // it — nothing about the health module is substituted here.
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    dir = await mkdtemp(join(tmpdir(), 'about-integration-'));
    path = join(dir, 'info.json');
    process.env.DEPLOY_INFO_PATH = path;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const server = () => context.app.getHttpServer();
  const write = (value: unknown) =>
    writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

  /**
   * An `Authorization` header for a signed-in caller holding
   * `system_settings:read`, minted through the same path the app resolves.
   *
   * Returns the HEADER rather than a prepared request on purpose: supertest's
   * `Test` is itself a thenable, so an `async` helper returning one has its
   * type collapsed from `Test` to `Response` and `.expect()` disappears.
   */
  const adminAuth = async () =>
    authHeader((await createMockAdminUser(context)).accessToken);

  // ===========================================================================
  // The 200 contract — the endpoint's whole reason for existing
  // ===========================================================================

  describe('always answers 200', () => {
    it('200 with deployInfoStatus "absent" when the file is not there', async () => {
      // ⚠ NOT a 404. This is the state of every environment today — every
      // developer machine, every CI job, every running container — because the
      // CLI half of this feature ships later.
      const response = await request(server()).get(ROUTE).set(await adminAuth()).expect(200);

      expect(response.body.data.deployInfoStatus).toBe('absent');
      expect(response.body.data.deployInfoError).toBeNull();
    });

    it('200 with deployInfoStatus "invalid" when the file is malformed', async () => {
      await write('{ this is not json');

      const response = await request(server()).get(ROUTE).set(await adminAuth()).expect(200);

      expect(response.body.data.deployInfoStatus).toBe('invalid');
      expect(typeof response.body.data.deployInfoError).toBe('string');
    });

    it('200 with database: null when the database probe fails', async () => {
      // ⚠ NOT a 503. `DatabaseHealthIndicator` throws `HealthCheckError`, which
      // Nest would otherwise render as a 503 — proving it does not escape needs
      // the real filter, which is why this case lives here.
      prisma.$queryRaw.mockRejectedValue(new Error("Can't reach database server"));

      const response = await request(server()).get(ROUTE).set(await adminAuth()).expect(200);

      expect(response.body.data.database).toBeNull();
      expect(response.body.data.databaseError).toBe("Can't reach database server");
      // The rest of the report survives the database being gone.
      expect(response.body.data.api.version).toEqual(expect.any(String));
    });

    it('200 with everything degraded at once', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('down'));
      await write({ schema: 2 });

      const response = await request(server()).get(ROUTE).set(await adminAuth()).expect(200);

      expect(response.body.data.deployInfoStatus).toBe('invalid');
      expect(response.body.data.database).toBeNull();
      expect(response.body.data.api.version).toEqual(expect.any(String));
    });

    it('reports the database as healthy when it answers', async () => {
      const response = await request(server()).get(ROUTE).set(await adminAuth()).expect(200);

      expect(response.body.data.database).toEqual({
        status: 'up',
        responseTime: expect.any(String),
      });
      expect(response.body.data.databaseError).toBeNull();
    });
  });

  // ===========================================================================
  // The three states, over HTTP
  // ===========================================================================

  describe('state: ok', () => {
    it('returns the whole document', async () => {
      await write(GOOD_DOCUMENT);

      const { body } = await request(server()).get(ROUTE).set(await adminAuth()).expect(200);

      expect(body.data).toMatchObject({
        deployInfoStatus: 'ok',
        deployInfoError: null,
        deployInfoPath: path,
        app: GOOD_DOCUMENT.app,
        installedAt: GOOD_DOCUMENT.installedAt,
        updatedAt: GOOD_DOCUMENT.updatedAt,
        deployedBy: GOOD_DOCUMENT.deployedBy,
        domain: 'app.example.com',
        remote: GOOD_DOCUMENT.remote,
        run: { completed: ['pull', 'migrate', 'up'], failedStep: null, outcome: 'success' },
      });
    });

    it('serves a rewritten document without a restart', async () => {
      await write(GOOD_DOCUMENT);
      const first = await request(server()).get(ROUTE).set(await adminAuth()).expect(200);
      expect(first.body.data.app.commitSha).toBe(GOOD_DOCUMENT.app.commitSha);

      // `appctl deploy update` rewrites the bind-mounted file in place against
      // this exact running process. Nothing may cache across these two requests.
      await write({ ...GOOD_DOCUMENT, app: { ...GOOD_DOCUMENT.app, commitSha: 'feedface' } });

      const second = await request(server()).get(ROUTE).set(await adminAuth()).expect(200);
      expect(second.body.data.app.commitSha).toBe('feedface');
    });
  });

  describe('state: absent', () => {
    it('nulls every document field and asserts nothing about why', async () => {
      const { body } = await request(server()).get(ROUTE).set(await adminAuth()).expect(200);

      expect(body.data).toMatchObject({
        deployInfoStatus: 'absent',
        deployInfoError: null,
        app: null,
        installedAt: null,
        updatedAt: null,
        deployedBy: null,
        domain: null,
        remote: null,
        run: null,
      });
    });

    it('reports the path it looked at, and no claim beyond it', async () => {
      // ⚠ The body must not mean "this instance was not deployed with the CLI".
      // That is false when the path is mis-set, the bind mount did not attach,
      // or a run stopped before writing the file — all of which the path is what
      // distinguishes. The client words the sentence; the API supplies the fact.
      const { body } = await request(server()).get(ROUTE).set(await adminAuth()).expect(200);

      expect(body.data.deployInfoPath).toBe(path);

      const wire = JSON.stringify(body).toLowerCase();
      for (const claim of ['not deployed', 'was not installed', 'no deployment']) {
        expect(wire).not.toContain(claim);
      }
    });

    it('defaults to the container bind-mount path when DEPLOY_INFO_PATH is unset', async () => {
      delete process.env.DEPLOY_INFO_PATH;

      const { body } = await request(server()).get(ROUTE).set(await adminAuth()).expect(200);

      expect(body.data.deployInfoPath).toBe(DEFAULT_DEPLOY_INFO_PATH);
      expect(body.data.deployInfoStatus).toBe('absent');
    });
  });

  describe('state: a complete document describing a FAILED run', () => {
    const FAILED = {
      ...GOOD_DOCUMENT,
      run: { completed: ['pull', 'migrate'], failedStep: 'up', outcome: 'failure' },
    };

    it('is a 200 with deployInfoStatus "ok" — a failed run is not an error here', async () => {
      await write(FAILED);

      const { body } = await request(server()).get(ROUTE).set(await adminAuth()).expect(200);

      expect(body.data.deployInfoStatus).toBe('ok');
      expect(body.data.deployInfoError).toBeNull();
    });

    it('surfaces run.failedStep alongside every other fact it has', async () => {
      await write(FAILED);

      const { body } = await request(server()).get(ROUTE).set(await adminAuth()).expect(200);

      expect(body.data.run).toEqual({
        completed: ['pull', 'migrate'],
        failedStep: 'up',
        outcome: 'failure',
      });
      // The run deployed something. Withholding these would be the bug.
      expect(body.data.app).toEqual(GOOD_DOCUMENT.app);
      expect(body.data.domain).toBe('app.example.com');
      expect(body.data.deployedBy).toEqual(GOOD_DOCUMENT.deployedBy);
    });
  });

  describe('schema is the one strictly validated field', () => {
    it('rejects schema: 2 as invalid', async () => {
      await write({ ...GOOD_DOCUMENT, schema: 2 });

      const { body } = await request(server()).get(ROUTE).set(await adminAuth()).expect(200);

      expect(body.data.deployInfoStatus).toBe('invalid');
      expect(body.data.app).toBeNull();
      expect(body.data.deployInfoError).toContain('2');
    });

    it('accepts a document carrying fields this API has never heard of', async () => {
      await write({ ...GOOD_DOCUMENT, futureField: { anything: true } });

      const { body } = await request(server()).get(ROUTE).set(await adminAuth()).expect(200);

      expect(body.data.deployInfoStatus).toBe('ok');
      expect(body.data.app).toEqual(GOOD_DOCUMENT.app);
    });
  });

  // ===========================================================================
  // The response envelope
  // ===========================================================================

  it('wraps the report in the { data, meta } envelope the interceptor produces', async () => {
    const { body } = await request(server()).get(ROUTE).set(await adminAuth()).expect(200);

    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta');
    expect(body.data).not.toHaveProperty('data');
  });

  // ===========================================================================
  // RBAC — through the REAL guard stack. See this file's header.
  // ===========================================================================

  describe('permissions', () => {
    it('declares exactly system_settings:read, and invents no about:read', async () => {
      // The API half of the contract a settings card's `permission` field must
      // mirror byte for byte (CLAUDE.md, Settings UI Pattern rule 3).
      const declared = Reflect.getMetadata(
        PERMISSIONS_KEY,
        AboutController.prototype.getAbout,
      );

      expect(declared).toEqual(['system_settings:read']);
      expect(declared).not.toContain('about:read');
    });

    it('gives a holder of system_settings:read a POPULATED 200', async () => {
      // ⚠ The trap: a route that is authenticated but declares no permission can
      // answer 200 with content silently filtered away. So this asserts the
      // BODY, not just the status — a caller who is genuinely authorized must
      // receive the real report.
      await write(GOOD_DOCUMENT);

      const admin = await createMockAdminUser(context);
      const { body } = await request(server())
        .get(ROUTE)
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(body.data.api.version).toEqual(expect.any(String));
      expect(body.data.deployInfoStatus).toBe('ok');
      expect(body.data.app.commitSha).toBe(GOOD_DOCUMENT.app.commitSha);
      expect(body.data.database).not.toBeNull();
    });

    it('refuses a viewer, who does not hold system_settings:read', async () => {
      const viewer = await createMockViewerUser(context);

      await request(server()).get(ROUTE).set(authHeader(viewer.accessToken)).expect(403);
    });

    it('refuses a contributor, who does not hold it either', async () => {
      const contributor = await createMockContributorUser(context);

      await request(server()).get(ROUTE).set(authHeader(contributor.accessToken)).expect(403);
    });

    it('refuses an unauthenticated caller', async () => {
      await request(server()).get(ROUTE).expect(401);
    });

    it('refuses a bad token', async () => {
      await request(server()).get(ROUTE).set(authHeader('not-a-token')).expect(401);
    });
  });
});
