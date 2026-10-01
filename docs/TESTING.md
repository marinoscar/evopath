# Testing

How this repository is tested: which tiers exist, what each one can and
cannot prove, how to run them, and how to add a test. This is the only
testing document; the testing agent (`.claude/agents/testing-dev.md`) points
here.

## Contents

1. [Overview](#overview)
2. [Running tests](#running-tests)
3. [API unit tests](#api-unit-tests)
4. [API integration tests](#api-integration-tests)
5. [API real-Postgres tests](#api-real-postgres-tests)
6. [API real-GreptimeDB tests](#api-real-greptimedb-tests)
7. [Tripwire suites](#tripwire-suites)
8. [API test configuration](#api-test-configuration)
9. [Web tests](#web-tests)
10. [CLI tests](#cli-tests)
11. [End-to-end tests (Playwright)](#end-to-end-tests-playwright)
12. [Visual regression](#visual-regression)
13. [Evals](#evals)
14. [Mocking OAuth](#mocking-oauth)
15. [Writing a new test](#writing-a-new-test)
16. [CI](#ci)
17. [Common issues](#common-issues)

## Overview

| Tier | File pattern | Uses | Command | CI job |
|---|---|---|---|---|
| API unit | `apps/api/src/**/*.spec.ts` | Jest, `@nestjs/testing`, mocked dependencies | `npm test --workspace=api` | `api-test` (2 shards) |
| API integration | `apps/api/test/**/*.integration.spec.ts` (60 files) | Full `AppModule` on Fastify, Supertest, **mocked** Prisma | `npm test --workspace=api` | `api-test` |
| API real-Postgres | `**/*.db.spec.ts` (26 files) | A real, migrated PostgreSQL 16; `pg_dump`/`pg_restore` for backup suites | `npm run test:db --workspace=api` | `smoke` |
| API real-GreptimeDB | `apps/api/src/telemetry/telemetry.greptime.spec.ts` | A real, disposable GreptimeDB standalone | `npm run test:greptime --workspace=api` | `greptime-test` |
| Web | `apps/web/src/**/*.test.{ts,tsx}` | Vitest, jsdom, React Testing Library, MSW | `npm run test:run --workspace=web` | `web-test` (6 shards) |
| CLI | `apps/cli/src/**/*.test.{ts,tsx}` | Vitest, Node environment | `npm run test:run --workspace=cli` | `build` |
| End-to-end | `tests/e2e/specs/*.spec.ts` | Playwright against the running Compose stack, `/testing/login` bypass | `cd tests/e2e && npm test` | none (run locally) |
| Visual regression | `tests/visual/specs/*.spec.ts` | Playwright, pinned Chromium, a Vite harness; no API or database | see [Visual regression](#visual-regression) | `visual` |

Only `*.db.spec.ts` needs a database; the integration tier mocks `PrismaService`.

## Running tests

There is no root `npm test`. Run each workspace, or use the root shortcuts
`npm run api:test` and `npm run web:test`.

```bash
# API: unit + integration (no database needed)
npm test --workspace=api
npm run test:watch --workspace=api
npm run test:cov --workspace=api          # coverage in apps/api/coverage
npm run test:debug --workspace=api        # node --inspect-brk, run in band

# API: real-Postgres tier (needs a database, see below)
npm run test:db --workspace=api

npm test --workspace=api -- users.integration          # one file
npm test --workspace=api -- -t "should return 403"     # one test by name
npm test --workspace=api -- --shard=1/2                # one CI shard

# Type-checking (Jest does not type-check)
npm run typecheck --workspace=api   # also web, cli

# Web: once, watch, coverage, Vitest UI
npm run test:run --workspace=web
npm test --workspace=web
npm run test:coverage --workspace=web
npm run test:ui --workspace=web

# CLI
npm run test:run --workspace=cli
```

API script reference (`apps/api/package.json`):

| Script | Runs |
|---|---|
| `test`, `test:unit` | Every `*.spec.ts` except `*.db.spec.ts` (identical scripts) |
| `test:watch`, `test:cov`, `test:ci` | The same set, watching / with coverage / with coverage and JUnit |
| `test:db` | Only `*.db.spec.ts`, `--runInBand` |
| `test:all` | Everything, including `*.db.spec.ts` |

## API unit tests

Unit tests sit next to the code they test (`auth.service.ts` →
`auth.service.spec.ts`). They build a small `TestingModule` with only the
class under test and mocked collaborators. The largest groups are services,
job handlers, cron tasks, DTOs (Zod schemas), mappers, guards and the AI
provider conformance kit.

```typescript
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { PatService } from './pat.service';

describe('PatService', () => {
  let service: PatService;
  let prisma: MockPrismaService;

  beforeEach(async () => {
    prisma = createMockPrismaService();
    const module = await Test.createTestingModule({
      providers: [PatService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(PatService);
  });

  it('refuses to revoke a token the caller does not own', async () => {
    prisma.personalAccessToken.findFirst.mockResolvedValue(null);
    await expect(service.revokeToken('user-1', 'pat-1')).rejects.toThrow(NotFoundException);
  });
});
```

Mock every other collaborator with a plain object of `jest.fn()` members
(`{ provide: JobsService, useValue: { enqueue: jest.fn() } }`).

## API integration tests

`*.integration.spec.ts` files under `apps/api/test/` drive real HTTP requests
through the **whole** application: every module, guard, pipe, filter and
interceptor that `AppModule` wires, on the Fastify adapter. Only the database
(and anything a spec opts to replace) is a mock. They prove routing, auth,
RBAC, validation, the response envelope and error mapping end to end.

### Layout

| Path | Contents |
|---|---|
| `test/helpers/` | `test-app.helper.ts` (app bootstrap), `auth-mock.helper.ts` (mock users, real JWTs), `scratch-database.helper.ts` and `tmp-storage-provider.helper.ts` (db tier) |
| `test/mocks/` | `prisma.mock.ts`, `google-oauth.mock.ts`, `storage-provider.mock.ts`, `pg-process.mock.ts` (fake `pg_dump`/`pg_restore`) |
| `test/fixtures/` | `mock-setup.helper.ts` (`setupBaseMocks`, `setupMockUser`, ...), `test-data.factory.ts` (`createMockUser`, `mockRoles`), user/role/settings fixtures |
| `test/<area>/` | Specs by feature: `auth`, `rbac`, `settings`, `ai`, `jobs`, `nodes`, `storage`, `notifications`, ... |

`test/setup.ts` loads `apps/api/.env.test` (JWT secret, a dummy Google client
id, `OTEL_ENABLED=false`, the test database address) and sets
`NODE_ENV=test`.

### `test-app.helper.ts`

```typescript
createTestApp(options?: {
  useMockDatabase?: boolean;                 // default true
  registerRoutes?: (app) => void;            // raw Fastify routes, added before init()
  overrideProviders?: { provide; useValue }[]; // extra substitutions
}): Promise<TestContext>

interface TestContext { app; prisma; prismaMock; module; isMocked }
closeTestApp(context): Promise<void>
```

With the default mocked database it:

- compiles the full `AppModule`, overriding `PrismaService` with the shared
  `prismaMock` and `JobWorker` with an empty object (so no polling loop runs);
- applies each `overrideProviders` entry, for a spec that needs to control one
  slice (a mail transport, a storage provider) while every other provider
  stays real;
- registers `@fastify/cookie` and `@fastify/multipart` the way `main.ts` does,
  sets the `api` prefix, and relies on the global `ZodValidationPipe` from
  `AppModule`;
- calls `app.init()` and waits for Fastify to be ready.

`useMockDatabase: false` compiles `AppModule` with no overrides. No suite in
the repository uses it; real-database coverage lives in the `*.db.spec.ts`
tier instead.

### `auth-mock.helper.ts`

| Function | Returns |
|---|---|
| `createMockTestUser(context, options?)` | Registers a mock user in `prismaMock` (via `setupMockUser`) and signs a real JWT with the app's own `JwtService`. `options` take `email`, `roleName`, `isActive` and so on |
| `createMockAdminUser(context, email?)` | The same, with the `admin` role |
| `createMockContributorUser` / `createMockViewerUser` / `createMockInactiveUser` | The other roles, and an inactive user |
| `authHeader(token)` | `{ Authorization: 'Bearer <token>' }` |

Because the JWT strategy reloads the user from Prisma on every request, the
mock user registered by these helpers is what the guards see.

### Mocked Prisma

`test/mocks/prisma.mock.ts` exports:

- `prismaMock`: a `mockDeep<PrismaClient>()` from `jest-mock-extended`, typed
  `any` so tests can return partial rows;
- `resetPrismaMock()`: call in `beforeEach`;
- `mockPrismaTransaction()`: makes `$transaction` run callbacks and arrays
  against the mock;
- `createMockPrismaService()`: a fresh deep mock for unit tests.

`fixtures/mock-setup.helper.ts` layers sensible defaults on top:
`setupBaseMocks()` (roles, permissions, users, system settings, audit events,
user settings), `setupMockUserList`, `setupMockAllowedEmail(List)`,
`setupMockSystemSettings`, `setupMockUserSettings`.

### A typical integration spec

```typescript
import request from 'supertest';
import { TestContext, createTestApp, closeTestApp } from './helpers/test-app.helper';
import { resetPrismaMock } from './mocks/prisma.mock';
import { setupBaseMocks, setupMockUserList } from './fixtures/mock-setup.helper';
import { createMockAdminUser, createMockViewerUser, authHeader } from './helpers/auth-mock.helper';

describe('Users (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
  });

  it('returns 401 without a token', async () => {
    await request(context.app.getHttpServer()).get('/api/users').expect(401);
  });

  it('returns 403 without users:read', async () => {
    const viewer = await createMockViewerUser(context);
    await request(context.app.getHttpServer())
      .get('/api/users')
      .set(authHeader(viewer.accessToken))
      .expect(403);
  });

  it('lists users for an admin', async () => {
    const admin = await createMockAdminUser(context);
    setupMockUserList([
      { email: admin.email, roleName: 'admin' },
      { email: 'user1@example.com', roleName: 'viewer' },
    ]);

    const res = await request(context.app.getHttpServer())
      .get('/api/users')
      .set(authHeader(admin.accessToken))
      .expect(200);

    expect(res.body.data.items).toHaveLength(2);
  });
});
```

For a PAT, pass `Authorization: Bearer pat_…` and mock
`prismaMock.personalAccessToken.findUnique`; `test/auth/pat-universality.integration.spec.ts`
proves a PAT works on every authenticated route.

A mock returns whatever the test told it to; it proves nothing about SQL,
indexes, constraints, locks or isolation. For those, write a `*.db.spec.ts`.

## API real-Postgres tests

`*.db.spec.ts` suites observe real PostgreSQL: the job claim's
`FOR UPDATE SKIP LOCKED`, the partial unique indexes Prisma cannot declare,
`ON DELETE SET NULL` foreign keys, two executors racing for one row, a lease
expiring between compute and submit, a real `pg_dump` streamed into storage,
and a database renamed under a live pool during restore.

They are excluded from every Jest script except `test:db` and `test:all`, so
a plain `npm test` never needs a database.

### Where they live

| Location | Covers |
|---|---|
| `apps/api/test/jobs/` | Claim, enqueue dedup, lease renewal, stuck reset, history purge, insights, admin delete veto, terminal-write claim guard, schema indexes |
| `apps/api/test/nodes/` | Node schema and FKs, claim contention with the in-process worker, fleet lifecycle, the `example.checksum` data plane, `job_node_secrets` schema |
| `apps/api/test/integration/` | Cross-seam scenarios: queue/fleet concurrency, node lease boundary, backup round trip, restore round trip |
| `apps/api/test/broadcasts/` | Broadcast model indexes and defaults, chunked fan-out |
| `apps/api/test/ai/ai-usage.db.spec.ts` | Usage aggregation SQL |
| `apps/api/test/user-credentials/` | Per-user credential store |
| `apps/api/src/db-backup/` | Cluster primitives for restore, the single-active-run index, the PostgreSQL job-role broker, run/job linkage |

Each file's header comment names what it proves and its measured wall-clock
time.

### Support code

- `apps/api/test/jobs/db-test-support.ts`
  - `resolveDbSuite(name)` returns `{ describeWithDb, dbReachable }`.
    `describeWithDb` is `describe` when a TCP probe reaches
    `POSTGRES_HOST:POSTGRES_PORT`, otherwise `describe.skip` with one warning.
    `npm run test:db` without a database therefore skips cleanly.
  - `createDbClient()` builds a `PrismaClient` from `POSTGRES_*`, ignoring the
    `DATABASE_URL` that `.env.test` also sets.
- `apps/api/test/helpers/scratch-database.helper.ts` builds throwaway
  databases for destructive suites: `envFor(db)`, `prismaClientFor(db)`,
  `pgConnectionFor(db)`, `migrateDeploy(db)` (runs the real
  `prisma migrate deploy`), and `engineForConnection(conn)` (a backup engine
  bound to that database only).
- `apps/api/test/helpers/tmp-storage-provider.helper.ts`:
  `TmpDirStorageProvider`, a real filesystem `StorageProvider` so backup
  suites stream actual archive bytes.

### Running them locally

`infra/compose/test.compose.yml` provides a dedicated PostgreSQL 16 on host
port **5433** (database `my_app_test`, user/password `postgres`), matching
`apps/api/.env.test`. It never touches your development database.

```bash
# 1. Start the test database
docker compose -f infra/compose/test.compose.yml up -d

# 2. Migrate it (explicit variables win over infra/compose/.env)
POSTGRES_HOST=localhost POSTGRES_PORT=5433 POSTGRES_USER=postgres \
POSTGRES_PASSWORD=postgres POSTGRES_DB=my_app_test \
  npm run prisma:migrate --workspace=api

# 3. Run the tier
npm run test:db --workspace=api
```

The suites read `POSTGRES_*`, never `DATABASE_URL`. To point them elsewhere,
export `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`,
`POSTGRES_PASSWORD` and `POSTGRES_DB` before running; exported values win
over `.env.test`. The database must be migrated first: several suites assert
on indexes that exist only in the migration SQL.

The backup and restore suites also shell out to `pg_dump`, `pg_restore` and
`psql`, which must be on `PATH` with a major version compatible with the
server. See [runbooks/postgres-client-version.md](runbooks/postgres-client-version.md).

### Rules for a new `*.db.spec.ts`

1. **Name it `<subject>.db.spec.ts`** and put it beside its siblings. The
   filename alone opts it into `test:db` and out of everything else.
2. **Wrap it in `describeWithDb`** from `resolveDbSuite`, so it skips without
   a database.
3. **Scope every row you create** behind a suite-and-process prefix, for
   example `` `test.claim.${process.pid}.` `` for job types, emails and node
   names. Delete by that prefix in `afterAll`, and in `beforeAll` to clean up
   after a crashed run. The database is shared by every suite.
4. **Assume serial execution.** `test:db` runs `--runInBand` because several
   suites must be the only thing touching the rows they lock.
5. **Never do anything destructive to the shared database.** Rename, drop or
   terminate sessions only on a scratch database from
   `scratch-database.helper.ts`. `database-restore-round-trip.db.spec.ts`
   shows the guard: `assertNeverTheSharedDatabase` throws before any work if
   a derived name could collide with `POSTGRES_DB`.

## API real-GreptimeDB tests

`apps/api/src/telemetry/telemetry.greptime.spec.ts` observes a real
GreptimeDB standalone: the reader/admin user split enforced by the server
itself (not the app's SQL guard), `TelemetryQueryService` end to end (SELECT
wrapping, truncation, multi-statement rejection, server-side SQL errors),
retention (`ALTER DATABASE ... SET 'ttl'`, `SHOW CREATE DATABASE`,
`TelemetryStatusService`), schema discovery and every export format,
including a real Parquet round trip through the child-process helper
(`apps/api/src/telemetry/testing/parquet-child.ts`).

It is excluded from every other Jest script (`test`, `test:db`, `test:all`
all skip it via `testPathIgnorePatterns`/their own `testRegex`) and only runs
under `test:greptime`, which every other Jest script's ignore pattern keeps
out.

### Running it locally

`infra/compose/test.compose.yml`'s `greptime-test` service is a disposable
GreptimeDB standalone with the same three users CI uses (`admin`, `writer`,
`reader`, all `readonly` except `admin`/`writer`), on host ports 14010
(HTTP) and 14013 (PostgreSQL wire):

```bash
# 1. Start it
docker compose -f infra/compose/test.compose.yml up -d greptime-test

# 2. Run the tier
GREPTIME_TEST_URL="postgres://reader:test-reader@localhost:14013/public" \
GREPTIME_TEST_ADMIN_URL="postgres://admin:test-admin@localhost:14013/public" \
  npm run test:greptime --workspace=api
```

Without `GREPTIME_TEST_URL` every test in the file is skipped — a plain
`npm run test:greptime --workspace=api` on a machine with no GreptimeDB
running exits cleanly. `GREPTIME_TEST_ADMIN_URL` is optional: without it, the
suite still runs everything that only needs the reader connection (queries,
schema, exports) but skips fixture seeding and the retention test, which need
`ALTER DATABASE` and `CREATE TABLE`/`INSERT`. `GREPTIME_TEST_OUT_DIR` is an
optional directory to save each exported file to, for manual inspection.

### In CI

`greptime-test` (see [CI](#ci)) starts the same image directly with `docker
run`, not a `services:` container: GitHub Actions' `services:` block cannot
pass GreptimeDB the `--user-provider` argument its reader/admin split needs,
so the job starts it as an explicit step and polls its `/health` endpoint
before running the tier.

 They discover it (from the Nest
router, the job registry, the seed file, the filesystem), so a new route, job
type, provider SDK import or doc link is covered the moment it exists, with
no edit to the suite.

| Suite | Invariant |
|---|---|
| `apps/api/test/docs-links.spec.ts` | Every relative link in `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `docs/**` and `.claude/agents/*.md` resolves to a real file (anchors stripped, fenced code ignored) |
| `apps/api/test/jobs/cron-enqueue-only.spec.ts` | Every `@Cron` only enqueues work, except the three permanent exemptions it names |
| `apps/api/test/jobs/on-event-no-io.spec.ts` | Every `@OnEvent` body is free of storage I/O (a direct storage-provider call, `.download(`, `.upload(`) |
| `apps/api/test/ai/ai-kill-switch.integration.spec.ts` | With `ai.enabled=false`, every discovered `/api/ai/*` route except `GET /api/ai/config` answers 403 `AI_DISABLED`, every `/api/admin/ai/*` route stays reachable, and no `ai.*` job reaches a provider |
| `apps/api/test/ai/ai-rbac-matrix.integration.spec.ts` | Every AI route crossed with Admin/Contributor/Viewer/anonymous; the expected permission comes from the route's `@Auth()` metadata and the grant from `prisma/seed-data.ts` |
| `apps/api/test/ai/ai-secret-egress.integration.spec.ts` | Sentinel keys never appear in any response, header, log line, audit row, usage row, run row or error body |
| `apps/api/test/ai/ai-key-policy.integration.spec.ts` | The BYOK / org-key resolution rule holds on every inference route, checked on the key the fake provider actually received |
| `apps/api/test/ai/ai-jobs-server-only.spec.ts` | No `ai.*` job type is node-eligible |
| `apps/api/test/ai/ai-no-sdk-leak.spec.ts` | No file outside `ai/providers/<provider>/` imports a provider SDK, in `apps/api/src` or `apps/web/src` |
| `apps/web/src/__tests__/config/aiSettingsRegistry.test.ts` | Every AI settings card's `permission` equals the string its API controller enforces, read from the controller source |

Related guards in the same spirit: `apps/api/src/ai/core/no-provider-sdk.spec.ts`
(no SDK in `ai/core`), the per-provider `*-sdk-boundary.spec.ts` files,
`apps/api/test/prisma/seed-data.spec.ts` (seed self-consistency without a
database), `apps/api/test/openapi/openapi-document.spec.ts` (the generated
document) and `apps/api/test/production-image.spec.ts` (every script an npm
script runs is copied into the production image).

## API test configuration

`apps/api/test/jest.config.js`:

- `rootDir: '..'`, `roots: ['src/', 'test/']`, `testRegex: '.*\.spec\.ts$'`.
- `setupFilesAfterEnv: test/setup.ts`, `globalTeardown: test/teardown.ts`,
  `testTimeout: 30000`, `testEnvironment: 'node'`.
- Coverage from `src/**/*.ts`, excluding modules, DTOs, `main.ts` and specs.
  There is no API coverage threshold.
- **Transpile only.** ts-jest runs with `isolatedModules: true`, so each file
  is transpiled on its own and nothing is type-checked inside Jest. Type
  errors in specs and helpers are caught by `npm run typecheck --workspace=api`,
  because `apps/api/tsconfig.json` includes `test/**`.
- **No `await import()` in a spec.** Under transpile-only NodeNext it stays a
  real ESM dynamic import, which Jest's CommonJS runtime rejects. Use a
  static import.

## Web tests

Vitest with jsdom, React Testing Library, `@testing-library/user-event` and
MSW. About 160 test files, mostly under `apps/web/src/__tests__/` mirroring
`src/` (`components/`, `pages/`, `hooks/`, `contexts/`, `config/`,
`services/`, `pwa/`), plus a few colocated `__tests__/` folders such as
`src/components/datatable/__tests__/`.

### Configuration (`apps/web/vitest.config.ts`)

- `environment: 'jsdom'`, `globals: true`,
  `setupFiles: ./src/__tests__/setup.ts`,
  `include: src/**/*.{test,spec}.{ts,tsx}`.
- Coverage thresholds: 70% lines, branches, functions and statements.
  `src/sw.ts` is excluded (jsdom cannot load a service worker).
- `testTimeout` and `hookTimeout` 20 s (the DataTable suites render full
  grids and run axe).
- Aliases: `@` → `src`, and `virtual:pwa-register/react` → a test double.

### Setup (`src/__tests__/setup.ts`)

- A query-aware `window.matchMedia` driven by `setViewportWidth(px)` /
  `resetViewportWidth()`, so MUI breakpoints (`up('sm')`, `down('sm')`) can
  be tested.
- `ResizeObserver` and `IntersectionObserver` stubs.
- The MSW server: `listen({ onUnhandledRequest: 'warn' })` before all,
  `resetHandlers()` after each, `close()` after all.

### Rendering

`src/__tests__/utils/test-utils.tsx` re-exports Testing Library with
`render` replaced by `renderWithProviders`, which wraps the component in a
`MemoryRouter`, the theme provider, an `AuthContext` value and, optionally,
the AI config context:

```typescript
import { render, screen, mockAdminUser } from '../utils/test-utils';
import UserSettingsHubPage from '../../pages/UserSettingsHubPage';

render(<UserSettingsHubPage />, {
  wrapperOptions: {
    route: '/settings',
    authenticated: true,
    user: mockAdminUser,
    theme: 'dark',
    aiEnabled: true,
  },
});

expect(await screen.findByText('Profile')).toBeInTheDocument();
```

### Mocking the API

Default handlers live in `src/__tests__/mocks/handlers.ts` (response data in
`mocks/data.ts` and `mocks/fixtures/`). Override per test:

```typescript
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

server.use(
  http.get('/api/auth/me', () => new HttpResponse(null, { status: 500 })),
);
```

### What jsdom cannot see

jsdom has no layout engine: no text wrapping, truncation, overflow or real
widths. Anything that depends on layout belongs in the
[visual regression](#visual-regression) suite.

## CLI tests

`apps/cli` uses Vitest with `environment: 'node'` (deliberately no DOM
globals, so nothing passes in tests that could not work in a terminal).
About 90 test files sit beside the code in `src/**`, including `.test.tsx`
files for the ink screens. Notable ones:

- `src/template-identity.test.ts`: the rename guard; fails if the old product
  name survives anywhere it should not.
- `src/deploy/env-spec.test.ts`: parses `infra/compose/.env.example`. It
  treats every commented `# KEY=value` line as a declared variable, so never
  add illustrative commented assignments to that file.

```bash
npm run test:run --workspace=cli
```

## End-to-end tests (Playwright)

`tests/e2e/` is a separate npm package (not a workspace) that drives the real
running application with Playwright.

```
tests/e2e/
├── playwright.config.ts      # baseURL http://localhost:3535, Chromium
├── helpers/auth.helper.ts    # loginAsTestUser, loginAsAdmin/Contributor/Viewer, isLoggedIn, logout
├── helpers/ai.helper.ts      # configureFakeVisionProvider, setFakeFixture (fake vision provider); setupFakeAi, useScenario (fake Responses server)
├── helpers/coach.helper.ts   # setupFakeCoachAi, setupFakeCoachVoice, setFakeCoachMode, coach policy, settings and timeline helpers
├── fixtures/auth.fixture.ts  # adminPage / viewerPage fixtures
└── specs/                    # auth, example, health-check-in, health-history, health-log-weight, gym-scan, gyms, health-photo-read, shell-navigation, telemetry-dashboard, workouts, workout-prefill, training-plans, coach-settings, coach-page and progress-photos specs
```

It is not run in CI. Run it against a local stack:

```bash
cd tests/e2e
npm install
npx playwright install chromium
npm test                 # headless
npm run test:headed      # watch the browser
npm run test:ui          # Playwright UI mode
```

The `gyms` spec covers the manual path and needs no AI. The `gym-scan` spec
drives "Scan gym" against the fake vision server
(`tests/e2e/support/fake-vision-server.mjs`) and needs two things on the stack:

- The `infra/compose/fake-ai.compose.yml` overlay, which starts the fake.
- Object storage configured in the admin UI, because the spec uploads photos.

The spec runs serially, because the fake's fixture queue is global. It skips
with a message when `http://localhost:4010/v1/models` is unreachable
(`FAKE_AI_URL` overrides the host URL). Start the stack with the overlay,
migrate and seed, then:

```bash
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml -f fake-ai.compose.yml up
cd tests/e2e && npx playwright test gyms gym-scan
```

`tests/e2e/helpers/ai.helper.ts` exports `configureFakeVisionProvider` (turns AI
on and enables the `fake-vision` model through the admin API), `setFakeFixture`,
`fakeRequests`, `resetFake` and `isFakeVisionReachable`. Tests that assert the
AI-off or no-vision-model copy do not change deployment state: they stub
`/api/ai/config` and `/api/ai/models` with `page.route`
(`tests/e2e/helpers/ai-stub.helper.ts`, used by both gym specs). How the fake
works is in [the gyms spec](specs/gyms-and-equipment.md#212-the-fake-vision-server).
The `workouts` spec covers the manual logging path with AI off. The
`workout-prefill` spec drives "Prefill from photo" against the same fake and
skips the same way; the fixtures it uses are described in
[the workouts spec](specs/workouts.md#213-reference-examples-and-the-fake-vision-server).

```bash
cd tests/e2e && npx playwright test workouts workout-prefill
```

The Jest guard `apps/api/test/gyms/gym-scan-examples.spec.ts` checks that the
reference photos and fixtures the scan spec names exist.

Outside CI the config starts the dev stack itself
(`docker compose -f base.compose.yml -f dev.compose.yml up`) and waits for
`/api/health/live`, reusing a stack that is already up. `BASE_URL` overrides
the target.

### Fake Responses server and training scenarios

The agentic training-plan flow (see [the spec](specs/ai-training-plans.md))
spans a browser, an SSE stream, a queue job, a graph with checkpoints and real
Postgres. Its staged, deterministic scenarios live in **one set of fixtures**
that both Jest and a fake provider replay, so they cannot drift:

```
apps/api/test/fixtures/training/
├── scenarios/*.json     # one file per scenario: per-role call scripts and http behaviour
├── scenarios/{planner,critic,evaluator}/*.json   # the model outputs the scenarios name
├── research/*.json      # research fixtures (queries, search sources, citations, brief)
├── personas/ and signals/   # evals and signals fixtures
```

A scenario maps an agent role to a list of call specs, answered in order (the
last entry repeats):

```jsonc
{
  "name": "critic-reject-once",
  "description": "shown by GET /__control/scenarios",
  "calls": {
    "researcher": [{ "outputJson": "../research/valid.json", "usage": { "inputTokens": 9000, "outputTokens": 4200, "reasoningTokens": 1500 } }],
    "planner":    [{ "outputJson": "planner/valid-8w.json" }, { "outputJson": "planner/valid-8w-revised.json" }],
    "critic":     [{ "outputJson": "critic/reject-volume.json" }, { "outputJson": "critic/approve.json" }],
    "evaluator":  []
  },
  "http": { "rateLimitOnCall": null, "retryAfterSeconds": 2, "delayMs": 0 }
}
```

`outputJson` is resolved from the scenarios folder. A research fixture becomes
a hosted `web_search` call plus a cited message; any other file is the message
text. `http.rateLimitOnCall` (1-based, over every request since the scenario
was selected) answers one `429` with `retry-after`; `http.delayMs` delays every
answer (the server only; Jest does not sleep). A critic call without a
structured-output schema is an investigation round trip, answered with a fixed
note and not counted.

**Scenarios.**

| Flow | Scenarios |
|---|---|
| Create and revise | `happy`, `critic-reject-once`, `critic-exhausted`, `planner-hostile`, `research-fabricated-url`, `research-insufficient`, `research-page-injection`, `budget-tight`, `rate-limit-once`, `urgent-symptom`, `slow` (delayed, for reload and cancel) |
| Evaluate | `evaluator-no-change`, `evaluator-autonomous`, `evaluator-structural`, `evaluator-pain-response`, `evaluator-regenerate`, `evaluator-hostile` |

Descriptions are in each file and in the
[runbook](runbooks/ai-training-plans.md#3-try-it-with-the-fake-provider).

**The fake Responses server** (`tests/e2e/support/fake-responses-server.mjs`,
`node:http`, no dependencies) speaks the OpenAI Responses API: `GET /v1/models`
(`fake-frontier`, `fake-fast`) and `POST /v1/responses` (a message with
`output_text` and `url_citation` annotations, a `web_search_call` item, usage
with reasoning tokens), routed on `body.metadata.agent` and a per-scenario call
counter. The control plane is `POST /__control/scenario`, `GET
/__control/scenarios`, `GET /__control/requests` and `POST /__control/reset`.
The request log holds per request the agent, node, round, model, effort, tool
types, whether a schema was present, input size, canary hits and whether an
`Authorization` header was present: never a body, prompt or key. The server
accepts any bearer token of 8 or more characters (`sk-invalid...` is a `401`)
and never logs or echoes one. It counts the e2e canary markers
(`DEFAULT_CANARY_MARKERS` in the server; `CANARY_TOKENS` on the fake container
overrides them, never on the application): strings whose occurrences in any
request body are counted, so a test
proves data minimisation from outside the API. The `openai` provider slot's
base URL is a runtime setting, so pointing the API at the fake needs no
production hook and no environment variable. The Jest spec
`apps/api/test/fake-responses/fake-responses-server.spec.ts` runs it as a child
process and covers selection, the 429, auth, the log and canary counting; it
runs in the default API test script.

**Jest (the CI gate).**

- `test/training-agents/scenario-fixtures.spec.ts` parses every output file with
  the real Zod contract of its role and asserts the exercise slugs exist in the
  seed, so a contract or seed change fails here first.
- `test/training-agents/support/scenario-script.ts`: `scriptFromScenario(name)`
  returns a `FakeAiProvider` script that routes on `req.metadata.agent` and the
  per-role call counter; `evaluate-scenario.ts` and `scenario-context.ts` build
  the plan and context the evaluator fixtures name their refs against.
- `test/training-agents/scenarios/create-flow.integration.spec.ts` replays the
  create and revise scenarios through the real `AiService`, runs service,
  graph, guardrails and `AgentCaller` over `createAiRuntimeHarness()`, asserting
  the ordered event log, the provider call log (roles, counts, models, efforts,
  tools), usage, the final status and error code, and that hostile content never
  reaches the plan. `evaluate-flow.integration.spec.ts` does the same for the
  evaluate scenarios, the ask-first pause and resume across a restart, envelope
  clamps, pain, thin data and AI off.
- `test/training-agents/training-flow.db.spec.ts` (real Postgres) runs one
  user's journey with real services and the scripted provider: create run,
  draft, activate, Today, start and finish a workout, the `workout.finished`
  evaluation, an autonomous change, the banner count, revert, suppression, the
  ask-first interrupt across a restart, approval, AI off mid-flow.

**Playwright.** `tests/e2e/specs/training-plans.spec.ts`, with
`setupFakeAi` and its helpers in `tests/e2e/helpers/ai.helper.ts`. It needs the
overlay on the stack and no real key:

```bash
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml -f fake-ai.compose.yml up
cd tests/e2e && npm test -- training-plans --workers=1
```

`setupFakeAi` (as admin, through the API) enables AI, points the `openai` slot at
`http://fake-ai-responses:4011/v1`, stores a fake admin key, refreshes and
classifies the fake models (only `fake-frontier` gets `hosted_tools`, so
`fake-fast` exercises the blocked-researcher case), switches web search on, and
`teardownFakeAi` restores the previous settings in `afterAll`. Each test signs
in as its own new contributor with its own gym; `setupFakeAiForUser` saves that
user's fake key and chooses the fake models per role. The
suite runs serially (the fake's scenario and log are global, and it shares AI
settings with the other AI specs), waits on what the page shows and never sleeps.
It covers the happy path, a critic rejecting once, a hostile planner, a
fabricated source, insufficient research, reload mid-run and cancel, the safety
stop (no request reaches the fake), canary-free requests, a blocked role, Today,
autonomous adaptation with Undo, ask-first approve and reject, and AI off.

**AI Coach.** The fakes answer the coach with no key
(`tests/e2e/support/fake-coach-scenarios.mjs`, wired into `fake-vision-server.mjs`
on 4010 for the structured nudge, the weekly review and the chat tool loop on
model `fake-coach`, and into both servers for `POST /v1/audio/speech`, model
`fake-tts` on 4011). `setupFakeCoachAi` and `setupFakeCoachVoice` in
`tests/e2e/helpers/coach.helper.ts` configure them as admin;
`setFakeCoachMode` switches nudges to decline and speech to fail or refuse. Specs
(serial, `--workers=1`, restart `fake-ai` and `fake-ai-responses` if they predate
the coach): `coach-settings` (persona, sample lines, the Sarge level 3 unlock and
re-lock), `coach-page` (kickoff nudge after a plan activation, chat round trips
with figures equal to `/api/training/signals`, the safety reply never reaching a
model, spoken nudges and text-only fallback), `progress-photos` (needs object
storage; no AI settings), the AI-on block of `shell-navigation` and "Meet your
coach" in `onboarding`. The hourly sweep, quiet hours, caps and the Sunday 18:00
weekly review need a controlled clock and are proven by the real-Postgres suites
(`coach-sweep.db.spec.ts`, `coach-weekly-review.db.spec.ts`), not here. The fakes
are tested by `apps/api/test/coach/fake-coach-server.spec.ts` (every canned line
through the real content guard) and the existing fake-server specs.

| Variable | Effect |
|---|---|
| `E2E_AI=0` | Skip the suites that need the fake Responses server |
| `E2E_ALLOW_DOCKER=1` | Also run kill and resume: restarts the `api` container mid-run and expects the run to resume |
| `E2E_COMPOSE_FILES` | Compose file names for that restart (default `base,dev,devdb,fake-ai`) |
| `FAKE_RESPONSES_URL` | Host URL of the fake (default `http://localhost:4011`) |
| `FAKE_RESPONSES_API_BASE_URL` | URL the API uses inside the compose network (default `http://fake-ai-responses:4011/v1`) |

An unreachable fake fails the suite at once with the exact fix. Like the rest of
the Playwright suites it is **not part of CI**; Jest is the gate.

**Add a scenario.**

1. Add the model outputs under `scenarios/planner/`, `critic/`, `evaluator/` or
   `research/` (or reuse existing ones), valid against the role's contract.
2. Add `scenarios/<name>.json` with `calls` per role (empty list for a role the
   flow never calls) and `http` if it throttles or delays.
3. Run `npm test --workspace=api -- scenario-fixtures`: the new files must parse
   and name seeded slugs.
4. Assert it in `create-flow.integration.spec.ts` or
   `evaluate-flow.integration.spec.ts` (and the browser spec when a user-visible
   path changes). Add the scenario name to `ScenarioName` in
   `tests/e2e/helpers/ai.helper.ts` if Playwright selects it.
5. Check it by hand: `curl -X POST localhost:4011/__control/scenario -d
   '{"name":"<name>"}'`, run the flow, then `curl localhost:4011/__control/requests`.

### Quick adaptation suites and the fake-provider e2e

The quick workout adaptation ([the spec, §2.13](specs/ai-training-plans.md#213-quick-adaptation-and-travel-workouts))
is covered at four levels. Jest is the CI gate.

| Level | Where | What it proves |
|---|---|---|
| Pure and graph | `apps/api/src/training-adaptation/` (`rules/`, `graph/`, `prompts/`, `context/`, `dto/`) | The rules table, the graph on `FakeAiProvider` through `createAdaptationGraphHarness` (accept, one revise, urgent stop with zero calls, hostile output, token cap), the pinned prompt markers and schema names, the never-send canary |
| Mocked integration | `apps/api/test/ai/training-adaptation.integration.spec.ts` | Per-route RBAC with the exact permission strings, the kill switch, validation, hostile free text, the revise ceiling |
| Real Postgres | `apps/api/test/training-adaptation/*.db.spec.ts`, `apps/api/test/gyms/temporary-gym-purge.db.spec.ts` | One active adaptation per user, apply idempotence under parallel taps, staleness on real rows, loads never from the model, purge reference safety |
| Web | `apps/web/src/__tests__/components/training/adapt/`, `pages/AdaptationReviewPage.test.tsx`, `AdaptRoutes.test.tsx` | The sheet, review, hotel step, routes and the run-event reducer |

```bash
npm test --workspace=api -- training-adaptation test/ai/training-adaptation
npm run test:db --workspace=api -- training-adaptation temporary-gym-purge
npm run test:run --workspace=web -- adapt
```

The Playwright spec is `tests/e2e/specs/training-adaptation.spec.ts` (15 serial
tests). It runs against the OpenAI-compatible fake that the gym-scan spec uses,
`tests/e2e/support/fake-vision-server.mjs`, extended with the adaptation models
and scenarios (`fake-adaptation-scenarios.mjs`); it is not the Responses fake of
the training-plans spec. It needs the `fake-ai.compose.yml` overlay and no real
key, runs serially because the fake's scenario and log are global, and is
skipped when `E2E_AI=0`. Its helpers are `setupFakeAdaptationAi` and its
teardown in `tests/e2e/helpers/ai.helper.ts` (enable AI, point the compatible
provider at the fake, classify the models, assign the planner and critic models through the admin assignments API, restore in
`afterAll`) and `tests/e2e/helpers/training.helper.ts` (seeds a gym, an active
plan and a check-in through the API). The hotel test uploads photos
(`tests/e2e/fixtures/hotel-gym-1.jpg`, `hotel-gym-2.jpg`; the fake ignores
pixels), so object storage must be configured in the admin UI.

```bash
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml -f fake-ai.compose.yml up
cd tests/e2e && npm test -- training-adaptation --workers=1
```

`FAKE_AI_URL` (runner, default `http://localhost:4010`) and
`FAKE_AI_API_BASE_URL` (what the API uses, default `http://fake-ai:4010/v1`)
override the addresses. The models are `fake-planner`, `fake-critic`,
`fake-vision` and `fake-text-only`, all keyless.

The fake routes a completion on `response_format.json_schema.name` and computes
the planner's answer from the `<context-json>` block of the request, because
exercise keys come from the running library. The markers and schema names are
pinned in `training-adaptation/prompts/markers.ts`. Control routes:

| Route | Purpose |
|---|---|
| `POST /__control/scenario` `{ name }` | Sets the default scenario and resets the counters; `GET` lists them |
| `GET /__control/log?after=<seq>` | One entry per completion: `seq`, `scenario`, `schemaName`, `model`, `imageCount`, `status`, `text` (never image bytes), so a test can assert what was not sent |
| `POST /__control/reset` | Clears the queue, the log and the counters |

A `SCENARIO:<name>` token in a request's free text overrides the scenario for
that request. The default is `valid`.

| Scenario | Behaviour |
|---|---|
| `valid` | Fitting proposal, critic accepts; scripted usage planner 1,200 in and 300 out, critic 800 in and 120 out |
| `critic-revise` | First critic answer is `revise` with one major issue; the revise pass drops an accessory. Two planner calls and one critic call |
| `unknown-exercise` | Adds the key `ghost_lift_9000`, which the guardrails remove |
| `over-time`, `over-volume` | Exceeds the minutes, or adds 2 sets; the guardrails repair it |
| `malformed` | Invalid structured output, `AI_STRUCTURED_OUTPUT_INVALID` |
| `rate-limit` | First adaptation call answers `429` with `Retry-After: 2`, then behaves as `valid` |
| `slow` | Delays each call by 3 seconds (progress and cancel) |
| `heavy-tokens` | First planner call reports 9,000 in and 3,000 out (token cap) |
| `scan-hotel`, `scan-empty` | The equipment scan returns dumbbells, an adjustable bench, a cable machine and a treadmill, or nothing |

`apps/api/test/ai/adaptation-fake-server-contract.spec.ts` is the Jest gate for
the fake: its literals equal the markers and schema names, its answers parse
under the real Zod schemas and the real `OpenAiCompatibleProviderAdapter`.

```bash
cd apps/api && npx jest --config test/jest.config.js test/ai/adaptation-fake-server-contract
```

Like every Playwright suite the spec is **not part of CI** (Jest is the gate),
and a run leaves no state behind.

### Signing in without Google

In development and test the web app serves `/testing/login` and the API
serves `POST /api/auth/test/login`. The page takes an email, a role
(`admin`, `contributor` or `viewer`) and an optional display name; the API
creates or updates that user, issues real tokens and redirects through the
normal `/auth/callback`.

```typescript
import { test, expect } from '../fixtures/auth.fixture';

test('admin reaches Users & Allowlist', async ({ adminPage }) => {
  await adminPage.goto('/admin/users');
  await expect(adminPage).toHaveURL('/admin/settings/users');
});
```

The bypass is absent in production builds and refused when
`NODE_ENV=production`. See
[SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md#13-test-authentication-development-only).

`.github/workflows/deploy-e2e.yml` is a different thing: it exercises
`evopathcli deploy` against real Docker on a simulated VPS.

## Visual regression

`tests/visual/` is a pixel-diff suite for the settings and navigation
surfaces. It exists because jsdom cannot see layout bugs such as a truncated
rail caption or a card grid with the wrong column count.

### How it works

- It screenshots a harness, not the running app. `apps/web/visual/` is a
  separate Vite entry that mounts the real components (`Layout`, the rail,
  the settings hubs) with no API, database or OAuth behind them. Query
  parameters pin the state: `?route=`, `?perms=`, `?roles=`, `?theme=`.
- `tests/visual/support/harness.ts` builds those URLs and provides
  `waitForInter(page)`, which every spec calls after `page.goto()` so no
  screenshot is taken before the Inter webfont loads. The harness uses the
  app's own font file (`apps/web/public/fonts/`).
- `tests/visual/playwright.config.ts` boots only the harness's Vite server
  on port 5183, disables animations, allows at most **4 differing pixels**
  (`maxDiffPixels`, an absolute count) with a pixelmatch `threshold` of 0.05,
  and never retries.
- 37 baselines across 11 spec files, in `tests/visual/specs/*-snapshots/`.
  Most are full-page shots that include the AppBar wordmark, so renaming the
  product changes them.
- The Telemetry Dashboard spec (`telemetry-dashboard.spec.ts`, #579) is the
  one whose page data is screenshotted. It answers the page's `/api` calls
  with fixtures through Playwright's `page.route()`
  (`tests/visual/support/telemetryDashboard.ts`), pins `Date.now()` with
  `page.clock.setFixedTime`, and pins the time zone and locale. Every other
  spec relies on its `/api` fetches failing, except the Health page spec
  (`health-page.spec.ts`), which uses the same technique with
  `tests/visual/support/health.ts`. The photo-reading spec
  (`health-photo-read.spec.ts`) does the same with
  `tests/visual/support/photoRead.ts`.

### Unit tests and the CSS-variable theme

The web theme uses CSS variables, so styles emit `var(--mui-palette-…)` and `calc(n * var(--mui-spacing))` instead of resolved colours and pixels. jsdom does not resolve them, so a unit test asserts on the emitted declaration or on the theme object, never on a computed rgb or px value. Pixel-level colour and spacing belong to the visual suite above.
`apps/web/src/__tests__/theme/theme.test.ts` is the token and contrast guard for the palettes in `apps/web/src/theme/`.

### Visual specs assert layout, not registry content

Appending a card to `ADMIN_SECTIONS`, `USER_SETTINGS_SECTIONS` or
`TODAY_CARDS` must change no baseline (#222). The harness never draws the
live registries: a resolve-time plugin in `apps/web/visual/vite.config.ts`
swaps `config/adminSections.tsx`, `config/userSettingsSections.tsx` and
`config/todayCards.tsx` for frozen copies in `apps/web/visual/fixtures/`, and
fails the harness if a live registry is ever loaded. The fixtures still run
the real filtering and title logic (`config/settingsRegistry.ts`) and the
real Today card bodies, so the permission, search and feature-gate specs keep
exercising their behaviour.

- Adding a card to the app: touch nothing under `tests/visual/` or
  `apps/web/visual/`. If a baseline moves anyway, that is a finding.
- Do not sync the fixtures with the live registries. Edit a fixture only when
  a spec needs a different shape, and regenerate the baselines that move in
  the same change.
- `src/__tests__/visual/registryFixtures.test.ts` fails if a fixture imports
  a value from a live registry, or lacks a name a live registry exports.

### The pinned browser

Pixel baselines depend on the exact browser build. `@playwright/test` is
pinned to `1.62.1` in `tests/visual/package.json`, and baselines are only
valid when produced in `mcr.microsoft.com/playwright:v1.62.1-noble`, the same
image the CI `visual` job uses. Three places carry that version: the package
pin, `ci.yml`'s `visual` job and `visual-baselines.yml`. Change all three
together.

Always invoke the pinned binary `tests/visual/node_modules/.bin/playwright`,
never `npx playwright`. From the repository root `npx` finds no local
Playwright, downloads the latest one, and loads a second `@playwright/test`
instance, which fails with "Playwright Test did not expect test() to be
called here".

### Regenerating baselines

This is the one canonical command. It runs in the pinned container and
rewrites every baseline:

```bash
REPO=$(git rev-parse --show-toplevel)
docker run --rm --user "$(id -u):$(id -g)" -v "$REPO:$REPO" -w "$REPO" \
  mcr.microsoft.com/playwright:v1.62.1-noble \
  tests/visual/node_modules/.bin/playwright test --config=tests/visual/playwright.config.ts --update-snapshots
```

- Install dependencies first, for Linux: `npm ci` at the root and
  `npm ci --prefix tests/visual`. On macOS or Windows the host's native
  binaries (esbuild, Rollup) do not run in the Linux container.
- `--user` keeps `test-results/` and `playwright-report/` owned by you.
- The repository is mounted at its own absolute path so worktree symlinks
  into the main checkout still resolve.
- Drop `--update-snapshots` to verify instead of regenerate.

Without Docker, or on macOS or Windows, use the **Regenerate visual
baselines** workflow (`.github/workflows/visual-baselines.yml`): Actions →
Run workflow → pick your branch. It runs the same command in the same image
and commits the result to the branch (or, with `commit: false`, only uploads
it as an artifact).

Open every changed PNG before committing. Regenerating to make a red job
green without looking is how a real layout regression gets blessed. A
baseline that changes on a screen your branch did not touch is a finding.

### In CI

The `visual` job runs the same binary without `--update-snapshots` and
uploads `tests/visual/playwright-report/` on every run; the report embeds the
expected, actual and diff images.

## Evals

Unit and scenario tests prove the guardrails do what their tables say and the pipeline is wired. Evals ask a different question: **are the plans good**, and does a new model, prompt or default make them better or worse. The suite lives in `apps/api/test/evals/` and adds no dependency.

### What it measures

Fifteen synthetic personas (`apps/api/test/fixtures/training/personas/*.json`, exercises and gyms named by seed slug, validated against the seed at load) run through the real create graph. Each is scored on twelve properties, pure functions `(persona, artifact) -> { pass, score, details }` in `test/evals/training/properties.ts`:

- **Hard** (weight 3): `equipment_feasible`, `schedule_fits`, `volume_in_range`, `limits_respected`, `loads_safe`, `citations_valid`, `safety_stop`, `injection_inert`. A hard failure on the shipped plan fails the persona whatever its score.
- **Soft** (weight 1): `goal_fit`, `progression_present`, `variety_and_balance`, `rationale_quality`. These use heuristics independent of the guardrails.

Two layers are scored separately: **raw** (the planner's draft compiled before the guardrails: the model) and **shipped** (the tree the pipeline creates: what ships).

**Limitation, by design:** the hard properties on the shipped layer reuse the guardrail tables as instruments, so they are partly circular. A green shipped column proves the pipeline applies the guardrails to a hostile model; it does not prove a model plans well. The soft properties and the raw layer measure the model. Every report says so in its header. A statistic the brief does not hold is flagged by the guardrails rather than removed, so on the shipped layer a flagged statistic passes and an unflagged one fails.

### Pipeline evals (deterministic, free, in CI)

`test/evals/training/pipeline.eval.spec.ts` runs every persona over the fake provider with four scripted planner outputs (`test/evals/support/draft-synth.ts`): **good**, **mediocre** (one revision, then ships), **hostile** (unsupported, avoid-listed and invented exercises, invented loads and citations, sessions outside the schedule) and **broken** (nothing repairable: the run is rejected). Safety personas assert zero provider calls; the injection persona asserts the goal text only reaches the planner inside the delimited context block. The suite is part of `npm test --workspace=api`, so a change to a guardrail, table, contract or route that lets a bad plan through fails CI.

```bash
npm run eval:training --workspace=api     # fake mode: a table, and reports under apps/api/test/evals/reports/
```

Reports are a flat JSON and a Markdown table (`<timestamp>-<mode>.{json,md}`, git-ignored). They hold scores, counts and model names, never a key, a bearer token or an environment variable value (a sentinel test proves it).

### Evaluator evals (adaptation)

Four evaluate personas (`apps/api/test/fixtures/training/personas/evaluator-*.json`: `evaluator-plateau`, `evaluator-adherence-gap`, `evaluator-pain-pattern`, `evaluator-thin-data`) replay scripted evaluator outputs (good, mediocre, hostile) through the real evaluate graph over an adaptation fixture. They are scored on two layers: the operations applied as proposed (the model) and the plan after the run (what ships). Properties live in `test/evals/training/properties.ts`:

- **Hard:** `no_increase_after_pain` (no load, set or RPE increase on a pain-flagged exercise, anywhere while automation is paused), `respects_frozen` (past and started workouts are unchanged), `holds_on_thin_data` (no change with fewer than three due sessions).
- **Soft:** `increases_on_plateau` (a small in-bounds increase), `adapts_to_adherence_gap` (frequency or volume moves toward reality, nothing is added).

`pipeline.eval.spec.ts` asserts every hard property on every shipped variant, so a change to the envelope, the safety stops or the thin-data rule that lets a bad adaptation through fails `npm test --workspace=api`.

### Model evals (on demand, real models)

`test/evals/training/live.eval.spec.ts` runs the same graph against real models. It is skipped unless `EVAL_LIVE=1`, `EVAL_MODELS` names a planner and a critic, and a test key is set for each provider used. These variables are read by the eval only: the application never reads them and none belongs in `.env.example`.

| Variable | Meaning |
|---|---|
| `EVAL_LIVE=1` | Enables the live run. |
| `OPENAI_API_KEY_FOR_TESTS`, `ANTHROPIC_API_KEY_FOR_TESTS`, `GEMINI_API_KEY_FOR_TESTS` | The key for each provider used. |
| `EVAL_MODELS` | `role=provider:model[:effort]`, comma separated: `planner=openai:gpt-x:high,critic=openai:gpt-y:medium`. |
| `EVAL_PERSONAS` | Comma-separated persona ids; default all. |
| `EVAL_SAMPLES` | Runs per persona (1 to 10); more than one reports mean and spread. |
| `EVAL_RESEARCH=live` | Uses real web search; default is each persona's stored brief so planner and critic comparisons are not confounded by search variance. |
| `EVAL_JUDGE=1` | Adds a model-graded score (1 to 5) from the critic model, which must differ from the planner. Reported, never gating. |
| `EVAL_CONFIRM=1` | Required above about 500,000 estimated tokens. |
| `EVAL_LABEL`, `EVAL_UPDATE_BASELINE=1` | Record `baselines/live-<label>.json`. |

```bash
EVAL_LIVE=1 OPENAI_API_KEY_FOR_TESTS=sk-... \
EVAL_MODELS="planner=openai:gpt-x:high,critic=openai:gpt-y:high" \
EVAL_PERSONAS=knee-pain-intermediate,time-crunched-two-days EVAL_SAMPLES=3 \
npm run eval:training --workspace=api
```

**Cost.** A full live run over the whole persona set is roughly 2 to 3 million tokens; narrow it with `EVAL_PERSONAS` and `EVAL_SAMPLES`. The runner prints an estimate first. Personas run one after another, a provider throttle is retried with backoff, and a partial report is written after each persona so an interruption keeps its results. A model that cannot produce strict-mode output is recorded as `AI_STRUCTURED_OUTPUT_INVALID` with a quality score of 0. Live scores never fail the run: they are compared with a committed baseline when one exists and the deltas are printed.

### Baselines and the prompt tripwire

- `test/evals/training/baselines/pipeline.json` holds the fake-mode scores. The good variants must score at or above it, and the persona set must match it.
- Each agent prompt module exports `PROMPT_VERSION` (bump it when the text changes meaningfully); reports record it. `prompt-versions.spec.ts` pins the content hash of the planner, critic and researcher prompts and the shared prompt blocks in `baselines/prompt-hashes.json`. Changing a prompt fails the spec until the evals were run and the hashes updated.
- Baselines and hashes are rewritten only with `EVAL_UPDATE_BASELINE=1`, for example `EVAL_UPDATE_BASELINE=1 npm run eval:training --workspace=api`. Note the result in the PR.

### Adding a persona or a property

- **Persona:** add `test/fixtures/training/personas/<id>.json` (the file name is the id; see `persona.schema.ts`), listing the properties it expects. Run the evals, check the scores, then update the baseline. A persona the baseline does not know fails until it is recorded.
- **Property:** add a pure function to `properties.ts`, register it in `PROPERTY_FNS` and `EVAL_PROPERTIES` (and `HARD_PROPERTIES` if it gates), and test it in `properties.spec.ts` on a good plan and on the same plan made bad.

## Mocking OAuth

No test talks to Google.

- **Unit**: `apps/api/src/auth/auth.service.spec.ts` drives
  `handleGoogleLogin` with plain profile objects and a mocked Prisma:
  allowlist denial, identity linking, the transactional user creation and the
  admin bootstrap. `auth.controller.spec.ts` and
  `strategies/google.strategy.spec.ts` cover the controller and strategy.
- **Integration**: `.env.test` provides a dummy `GOOGLE_CLIENT_ID`, so the
  real `GoogleStrategy` registers and `GET /api/auth/google` answers a 302 to
  Google without any network call. `test/auth/oauth.integration.spec.ts`
  checks that redirect, the refresh cookie attributes, and that guard-level
  callback failures redirect with a code from the closed sign-in error set
  ([SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md#sign-in-failure-contract)).
  The full callback round trip is skipped there, because it needs a real
  authorization code.
- **Test doubles**: `test/mocks/google-oauth.mock.ts` exports
  `MockGoogleStrategy` (a `passport-custom` strategy named `google` with
  `setMockProfile` / `resetMockProfile`) and `createMockGoogleProfile()`.
  `createTestApp` does not register `MockGoogleStrategy`; a spec that wants a
  canned profile to reach the callback must provide it itself.
- **E2E**: use `/testing/login` ([above](#signing-in-without-google)).

### Fastify and Passport regressions

Several bugs in the Fastify + Passport integration are pinned by tests:

| Behavior | Pinned by |
|---|---|
| The exception filter replies with Fastify's `code()`/`send()`, not Express's `status()`/`json()` | `src/common/filters/http-exception.filter.spec.ts` |
| `GoogleOAuthGuard` hands Passport the raw request/response and copies `user` back | the OAuth redirect cases in `test/auth/oauth.integration.spec.ts` |
| New users (and the bootstrap admin role) are created in one transaction | `src/auth/auth.service.spec.ts` |
| A sign-in failure redirects with a closed error code, never a message | `src/auth/auth.controller.spec.ts`, `src/auth/filters/google-oauth-exception.filter.spec.ts`, `test/auth/oauth.integration.spec.ts` |

## Writing a new test

| You changed | Write |
|---|---|
| A service, guard, handler, mapper or DTO | A unit spec beside it |
| A controller route (auth, RBAC, validation, envelope) | An `*.integration.spec.ts` in `apps/api/test/<area>/` using `createTestApp` |
| SQL behavior: an index, constraint, lock, raw query or transaction | A `*.db.spec.ts` following the [rules](#rules-for-a-new-dbspects) |
| A job type | A unit spec for the handler; add a `*.db.spec.ts` if it depends on claim or lease behavior |
| A React component, hook or page | A Vitest spec under `apps/web/src/__tests__/` |
| Anything layout-dependent in the shell or settings hubs | A visual spec, then regenerate baselines |
| A CLI command | A Vitest spec beside it in `apps/cli/src/` |

For every new protected route, test at least: 401 without a token, 403
without the permission, and the success path with it. If you change behavior,
add or adjust the test in the same commit or the next one.

Conventions:

- Nested `describe` blocks, test names that state behavior
  (`'returns 403 when the caller lacks users:write'`), Arrange-Act-Assert.
- Test both success and failure paths.
- Reset shared state in `beforeEach` (`resetPrismaMock()`, MSW
  `resetHandlers()` is automatic).
- On the web, query by role, label or text; use `getByTestId` only as a last
  resort; use `userEvent` over `fireEvent`; `await waitFor(...)` for async UI.

## CI

`.github/workflows/ci.yml` runs on pushes and pull requests to `main`:

| Job | Does |
|---|---|
| `build` (Build & Test) | `npm ci`, Prisma generate, typecheck for api/web/cli, CLI tests, CLI build |
| `api-test` | `npm test --workspace=api -- --shard=N/2`, two shards |
| `web-test` | `npm run test:run --workspace=web -- --shard=N/6`, six shards |
| `openapi` | Typecheck the dump script, `npm run openapi:dump`, Spectral lint |
| `smoke` | PostgreSQL 16 service; build the API; `prisma:migrate`; `test:db` (with `NODE_ENV=test`); seed twice (proves idempotency); boot `dist/main.js` and check health and `/api/openapi.json` |
| `greptime-test` | `docker run` a GreptimeDB standalone (not a `services:` container — see [above](#api-real-greptimedb-tests)), wait for `/health`, then `test:greptime` |
| `visual` | The visual suite in the pinned Playwright container |

`test:db` runs after migration and before seeding, so the suites see a
freshly migrated, unseeded database. The Playwright e2e suite is not in CI.

## Common issues

| Symptom | Fix |
|---|---|
| `npm run test:db` skips everything with a warning | Nothing listens at `POSTGRES_HOST:POSTGRES_PORT`. Start `infra/compose/test.compose.yml` (port 5433) or export `POSTGRES_*` |
| A `*.db.spec.ts` fails on a missing index or relation | Migrate that database: `npm run prisma:migrate --workspace=api` with the same `POSTGRES_*` |
| Backup/restore suites fail on a version check | `pg_dump` on `PATH` is older than the server; see [runbooks/postgres-client-version.md](runbooks/postgres-client-version.md) |
| "A dynamic import callback was invoked without --experimental-vm-modules" | A spec uses `await import(...)`; use a static import |
| A type error passes `npm test` | Expected; Jest only transpiles. Run `npm run typecheck --workspace=api` |
| An integration spec gets 401 for a user you created | `setupBaseMocks()` clears the mock user registry. Create users after `resetPrismaMock()` and `setupBaseMocks()` |
| A Prisma mock returns `undefined` | Unconfigured calls return `undefined`. Use `mockResolvedValue`; call `mockPrismaTransaction()` for `$transaction` |
| `window.matchMedia is not a function`, or breakpoints misbehave | The setup file did not load, or the viewport changed; use `setViewportWidth()` (reset after each test) |
| MSW does not intercept a request | Check the handler path; look for the `onUnhandledRequest` warning |
| Visual job red after a rename or deliberate UI change | [Regenerate the baselines](#regenerating-baselines), inspect the diff, commit |
| Visual job fails with "did not expect test() to be called here" | Something ran `npx playwright`; use `tests/visual/node_modules/.bin/playwright` |
