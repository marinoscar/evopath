# Development Guide

This guide covers the day-to-day development loop: running the app, the
Fastify, Passport and Prisma gotchas that trip up newcomers, debugging, and
the usual workflow for schema and endpoint changes.

## Table of Contents

1. [Technology Stack](#technology-stack)
2. [Development Setup](#development-setup)
3. [Working with NestJS + Fastify](#working-with-nestjs--fastify)
4. [Database Patterns](#database-patterns)
5. [Common Pitfalls and Solutions](#common-pitfalls-and-solutions)
6. [Testing Guidelines](#testing-guidelines)
7. [Debugging Tips](#debugging-tips)
8. [Development Workflow](#development-workflow)

---

## Technology Stack

### Backend
- **Framework**: NestJS with the **Fastify adapter** (not Express)
- **ORM**: Prisma with PostgreSQL 16
- **Authentication**: Passport (Google OAuth) plus JWT, personal access tokens
  and node credentials
- **Validation**: Zod schemas through `nestjs-zod` (a global `ZodValidationPipe`)
- **Documentation**: OpenAPI 3.1, served as a Scalar reference at `/api/docs`

### Key Difference: Fastify vs Express

This application uses **Fastify** as the HTTP adapter. Anything you copy from
an Express-based NestJS tutorial that touches the raw request or response
needs adapting. Fastify was chosen for its lower overhead and better
TypeScript types; NestJS hides the difference as long as you let it handle
responses.

---

## Development Setup

First-time setup (Google OAuth credentials, `npm run setup` to create
`infra/compose/.env`, the `devnet` network, the dev database overlay,
migrations, seeds and first login) is in the README:
[Start a new app from this template](../README.md#start-a-new-app-from-this-template).
Follow it once, then come back here.

### Dev-only extras

- **Hot reload in Docker.** `dev.compose.yml` runs the API in watch mode and
  the web app under Vite with HMR. This is the default loop.
- **Running outside Docker.** `npm run api:dev` (Nest watch mode, port 3000)
  and `npm run web:dev` (Vite, port 5173, proxying `/api` to
  `http://localhost:3000`) work from the repo root. Two things differ from the
  Docker loop:
  - The API reads configuration from the process environment (and from
    `apps/api/.env` if you create one), not from `infra/compose/.env`. Export
    the `POSTGRES_*`, `JWT_SECRET` and Google variables first. Only the
    `prisma:*` scripts load `infra/compose/.env` for you.
  - There is no Nginx, so the app is on `http://localhost:5173`. Point
    `APP_URL` and `GOOGLE_CALLBACK_URL` at that origin (and register the
    callback with Google), or sign in through the development-only test login
    at `/testing/login`.
- **Scratch test database.** `infra/compose/test.compose.yml` starts a
  disposable PostgreSQL 16 (`db-test`) on host port 5433 for real-database
  test runs:

  ```bash
  cd infra/compose && docker compose -f test.compose.yml up -d
  ```

- **Building images directly.** Both images build from the repository root,
  because the only `package-lock.json` is there:

  ```bash
  docker build -f apps/api/Dockerfile .
  docker build -f apps/web/Dockerfile .
  ```

---

## Working with NestJS + Fastify

### Critical Differences from Express

#### 1. Response Methods

**Wrong (Express-style):**
```typescript
@Get('example')
example(@Res() res: Response) {
  return res.status(200).json({ data: 'Hello' });
}
```

**Right (Fastify-style):**
```typescript
@Get('example')
example(@Res() res: FastifyReply) {
  return res.code(200).send({ data: 'Hello' });
}
```

- Use `code()` (Fastify also accepts `status()` as an alias) and `send()`.
  There is no `json()`.
- Import types from `fastify`, not `express`.
- `redirect()` takes the URL first: `res.redirect(url, 302)`.

**Best practice:** avoid `@Res()` unless you must. A handler that returns a
value gets the global `{ data, meta }` envelope and the exception filter for
free. With `@Res()` you own the response, so neither applies (use
`@Res({ passthrough: true })` if you only need to set a cookie or header).

```typescript
@Get('example')
example() {
  return { message: 'Hello' }; // sent as { data: { message: 'Hello' }, meta: { ... } }
}
```

#### 2. Request Objects

```typescript
import { FastifyRequest, FastifyReply } from 'fastify';

@Get('example')
example(@Req() req: FastifyRequest) {
  const ip = req.ip;             // client IP
  const protocol = req.protocol; // http/https
  const hostname = req.hostname; // Host header
  const raw = req.raw;           // the underlying Node.js IncomingMessage
}
```

`req.body`, `req.params`, `req.query` and `req.headers` work as in Express.

### Passport OAuth with Fastify

Passport strategies are written for Express and expect Node's raw
`IncomingMessage` and `ServerResponse`. Fastify wraps both, so the OAuth guard
must unwrap them.

#### The Solution

`apps/api/src/auth/guards/google-oauth.guard.ts`:

```typescript
import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class GoogleOAuthGuard extends AuthGuard('google') {
  getRequest(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    // Return the raw Node.js IncomingMessage for Passport compatibility
    return request.raw || request;
  }

  getResponse(context: ExecutionContext) {
    const response = context.switchToHttp().getResponse();
    // Return the raw Node.js ServerResponse for Passport compatibility
    return response.raw || response;
  }

  handleRequest<TUser = unknown>(
    err: Error | null,
    user: TUser | false,
    _info: unknown,
    context: ExecutionContext,
  ): TUser {
    if (err || !user) {
      throw err || new Error('Authentication failed');
    }

    // Copy the user from the raw request to the Fastify request
    // so controllers can read req.user normally
    const fastifyRequest = context.switchToHttp().getRequest();
    fastifyRequest.user = user;

    return user;
  }
}
```

1. `getRequest()` and `getResponse()` hand Passport the raw Node objects.
2. Passport runs the OAuth exchange on them.
3. `handleRequest()` copies the authenticated user back onto the Fastify
   request, so controllers can read `req.user`.

**In the controller** (simplified from `auth.controller.ts`):

```typescript
@Get('google/callback')
@Public()
@UseGuards(GoogleOAuthGuard)
async googleAuthCallback(
  @Req() req: FastifyRequest & { user?: GoogleProfile },
  @Res() res: FastifyReply,
) {
  const tokens = await this.authService.handleGoogleLogin(req.user!);
  res.setCookie('refresh_token', tokens.refreshToken!, COOKIE_OPTIONS);

  const redirectUrl = new URL('/auth/callback', appUrl);
  redirectUrl.searchParams.set('token', tokens.accessToken);
  return res.redirect(redirectUrl.toString(), 302);
}
```

The web app reads `?token=` on `/auth/callback`. On failure the API redirects
to `/auth/callback?error=…`.

### Cookies with Fastify

Cookies come from the `@fastify/cookie` plugin, registered in `main.ts`.

```typescript
// Set
res.setCookie('name', 'value', {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/api/auth',
});

// Read
const value = req.cookies['name'];

// Clear (the path must match the one it was set with)
res.clearCookie('name', { path: '/api/auth' });
```

The refresh cookie is scoped to `/api/auth`, so a browser only sends it to the
auth routes. A `fetch` to `POST /api/auth/refresh` still needs
`credentials: 'include'`.

---

## Database Patterns

### Prisma Transactions

When you create related records (for example a user with a role), do it in one
transaction so a failure cannot leave half the rows behind.

**Wrong (no transaction):**
```typescript
// If the second write fails, the user exists without a role
const user = await prisma.user.create({ data: { email, displayName } });

await prisma.userRole.create({
  data: { userId: user.id, roleId: defaultRole.id },
});
```

**Right (transaction with nested creates):**
```typescript
const user = await prisma.$transaction(async (tx) => {
  return tx.user.create({
    data: {
      email,
      displayName,
      userRoles: { create: { roleId: defaultRole.id } },
      userSettings: { create: { value: DEFAULT_USER_SETTINGS } },
    },
    include: { userRoles: { include: { role: true } } },
  });
});
```

A single `create` with nested `create` blocks (as above) is already atomic;
the explicit `$transaction` matters when you need several top-level writes.

### Seeding the Database

The seed script (`apps/api/prisma/seed.ts`) is idempotent. Always run it
through the `prisma:seed` script, never `ts-node`/`tsx` on the file: the
script builds `DATABASE_URL` from the `POSTGRES_*` variables
(`apps/api/scripts/prisma-env.js`), and the seed has no other way to get it.

```bash
# In Docker (the container's working directory is apps/api)
docker compose exec api npm run prisma:seed

# From the repository root
npm run prisma:seed --workspace=api
```

It creates the three roles, every permission, the role-permission grants and
the default system settings. Run it before the first login, after resetting
the database, and after pulling a change that adds permissions.

---

## Common Pitfalls and Solutions

### 1. "Database seed data missing" on First Login

**Symptom:** the first Google sign-in fails. The API log says
`CRITICAL: Default role "viewer" not found in database`.

**Cause:** migrations ran but seeds did not.

**Solution:** `docker compose exec api npm run prisma:seed`

### 2. Passport OAuth Not Working with Fastify

**Symptom:** the OAuth redirect fails, or `req.user` is undefined in the
callback.

**Cause:** Passport received Fastify objects instead of raw Node objects.

**Solution:** use the guard pattern above.

### 3. `res.json is not a function`

**Cause:** Express-style response code under the Fastify adapter.

**Solution:** `res.code(200).send(...)`, or return a value and let NestJS send
it.

### 4. Foreign Key Violation or Orphaned Rows on User Creation

**Cause:** related rows created in separate, non-transactional writes.

**Solution:** wrap them in `prisma.$transaction()` or use nested creates.

### 5. Error Messages in Redirect URLs

**Symptom:** a redirect fails, or the web app shows a garbled error.

**Cause:** an error message with newlines or reserved characters was put in a
URL.

**Solution:** sanitize and encode it, as the OAuth callback does:
```typescript
const errorMessage = error instanceof Error
  ? encodeURIComponent(error.message.replace(/[\r\n]/g, ' ').substring(0, 200))
  : 'authentication_failed';
return res.redirect(`${appUrl}/auth/callback?error=${errorMessage}`);
```

### 6. Calling `npx prisma` Directly

**Symptom:** `DATABASE_URL is not set` or a connection to the wrong database.

**Solution:** use the `npm run prisma:*` scripts in `apps/api`
(`prisma:generate`, `prisma:migrate`, `prisma:migrate:dev`, `prisma:seed`,
`prisma:studio`). See `apps/api/scripts/README.md`.

---

## Testing Guidelines

All testing guidance (the suites, how to run them, mocking, fixtures,
end-to-end and visual tests) is in [TESTING.md](TESTING.md). In short:

- `npm test --workspace=api` runs unit and integration suites. Integration
  suites (`*.integration.spec.ts`) boot the real Nest app with Prisma mocked,
  so they need no database. Google OAuth is mocked
  (`apps/api/test/mocks/google-oauth.mock.ts`).
- `*.db.spec.ts` suites run against a real, migrated PostgreSQL via
  `npm run test:db --workspace=api` (for example the `db-test` container from
  `test.compose.yml`, pointed at with the `POSTGRES_*` variables). They skip
  themselves if no database is reachable. Suites that need isolation create
  a scratch database with `apps/api/test/helpers/scratch-database.helper.ts`.
- Web tests: `npm run test:run --workspace=web`.

---

## Debugging Tips

### Debugging the OAuth Flow

1. **Check the configuration** in `infra/compose/.env`: `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `APP_URL`.
2. **Check the callback URL.** It must match the Google Cloud Console entry
   exactly, including scheme and port:
   `http://localhost:3535/api/auth/google/callback`.
3. **Check the allowlist.** Only `INITIAL_ADMIN_EMAIL` and allowlisted emails
   can sign in.
4. **Watch the API logs:**
   ```bash
   docker compose logs api -f
   ```
5. **Check the provider list:**
   ```bash
   curl http://localhost:3535/api/auth/providers
   ```

### Debugging Database Issues

1. **Check the connection.** The readiness probe includes a database check:
   ```bash
   curl http://localhost:3535/api/health/ready
   ```

2. **Inspect the database.** With the `devdb.compose.yml` overlay, from
   `infra/compose`:
   ```bash
   docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml \
     exec db psql -U postgres -d appdb
   ```
   ```sql
   \dt
   SELECT * FROM roles;
   SELECT * FROM permissions;
   ```
   Against your own PostgreSQL, use `psql` with the `POSTGRES_*` values from
   `.env`. For a GUI, run `npm run prisma:studio` in `apps/api`.

3. **See SQL queries.** With `NODE_ENV=development` (which `dev.compose.yml`
   sets), `PrismaService` logs every query and its duration at debug level.

### Debugging the API Process

- `npm run start:debug --workspace=api` starts Nest in watch mode with the
  Node inspector enabled.
- Every request gets an `X-Request-ID` from Nginx; search the logs for it to
  follow one request.
- `LOG_LEVEL` (default `info`) sets the Pino log level.

### Common Log Messages

| Message | Meaning |
|---------|---------|
| `Database connected` | Prisma connected at startup |
| `User logged out: user@example.com` | A logout succeeded |
| `Refresh token reuse detected for user: …` | A rotated refresh token was replayed; possible token theft |
| `CRITICAL: Default role "viewer" not found in database` | Seeds have not run |

---

## Development Workflow

### Making Database Changes

1. Edit `apps/api/prisma/schema.prisma`.
2. Create and apply a migration (from `apps/api`, or inside the container):
   ```bash
   npm run prisma:migrate:dev -- --name descriptive_name
   docker compose exec api npm run prisma:migrate:dev -- --name descriptive_name
   ```
3. Regenerate the Prisma client:
   ```bash
   npm run prisma:generate
   ```
4. If the change needs seed data, edit `prisma/seed.ts` (and
   `prisma/seed-data.ts` for roles and permissions), then run
   `npm run prisma:seed`.

The project configures the database with individual `POSTGRES_*` variables,
never a single `DATABASE_URL`. The `prisma:*` scripts build the URL for you.

### Adding New API Endpoints

1. Define request and response DTOs with Zod (`createZodDto`).
2. Add the controller method with `@Auth({ permissions: [...] })` (or
   `@Public()`).
3. Put the business logic in a service.
4. Add OpenAPI decorators (`@ApiOperation`, `@ApiResponse`); see
   [API.md § How the document is built](API.md#how-the-document-is-built).
5. Write unit and integration tests.
6. Check the result at `/api/docs`, then `npm run openapi:dump` and
   `npm run openapi:lint`.

Anything that outlives the request must be a queue job; see
[the job queue spec](specs/job-queue.md) and
[`apps/api/src/jobs/handlers/README.md`](../apps/api/src/jobs/handlers/README.md).

### Adding New Guards

1. Create the guard in `apps/api/src/auth/guards/`.
2. Implement `canActivate()`.
3. Register it in its module, or apply it with `@UseGuards()`.
4. Add tests for the guard logic.
5. Document the behaviour in
   [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md).

---

## Performance Considerations

- Avoid `@Res()` when you can; it bypasses the interceptors.
- Use Prisma `select` to fetch only the fields you need, and keep `include`
  shallow.
- Add `@@index` in `schema.prisma` for new filter patterns.

---

## Resources

- [NestJS Documentation](https://docs.nestjs.com/)
- [Fastify Documentation](https://fastify.dev/)
- [Prisma Documentation](https://www.prisma.io/docs/)
- [Passport.js Documentation](https://www.passportjs.org/)
- [Architecture](ARCHITECTURE.md)
- [Security Architecture](SECURITY-ARCHITECTURE.md)
- [Testing](TESTING.md)
- [API conventions](API.md)
