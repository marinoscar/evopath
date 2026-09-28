# Device Authorization Flow (RFC 8628)

This module implements the OAuth 2.0 Device Authorization Grant (RFC 8628), enabling secure authentication for devices with limited input capabilities such as CLI tools, Swagger UI, smart TVs, and IoT devices.

> **This flow has two documents.** This README is the authoritative reference —
> exact request/response schema, field names, and the security rationale for
> the code in this directory — and is kept in sync with it. For a narrative
> walkthrough, use-case framing, and integration examples (Node.js, Python,
> React Native, Scalar), see
> [`docs/DEVICE-AUTH.md`](../../../../docs/DEVICE-AUTH.md).

## Overview

The Device Authorization Flow allows users to authorize devices on a separate device with better input/display capabilities (like a phone or computer). The flow works as follows:

1. Device requests authorization and receives a device code and user code
2. Device displays the user code and verification URL to the user
3. User navigates to the verification URL on another device and enters the user code
4. User authenticates (if not already) and approves the device
5. Device polls the token endpoint and receives its credential once approved

The flow can mint **two different kinds of credential**, selected by the
device when it requests the code (`clientInfo.tokenType`). See
[Credential kinds](#credential-kinds) below — a CLI wants the `pat` kind, and
the browser-driven activation page uses the default `session` kind.

## Architecture

### Files

```
device-auth/
├── dto/
│   ├── device-code-request.dto.ts        # Request for generating device codes
│   ├── device-code-response.dto.ts       # Response with device/user codes
│   ├── device-token-request.dto.ts       # Request for polling authorization
│   ├── device-token-response.dto.ts      # Response with the issued credential
│   ├── device-token-error.dto.ts         # RFC 8628 error responses
│   ├── device-authorize-request.dto.ts   # Request to approve/deny device
│   ├── device-authorize-response.dto.ts  # Response for authorization action
│   ├── device-activate-response.dto.ts   # Response for activation page info
│   ├── device-session.dto.ts             # Device session management DTOs
│   └── index.ts
├── exceptions/
│   └── device-token-error.exception.ts   # Throws RFC 8628 error bodies verbatim
├── handlers/
│   └── device-code-cleanup.handler.ts    # `device-auth.code.cleanup` job: deletes expired codes
├── tasks/
│   └── device-code-cleanup.task.ts       # Daily cron that enqueues the cleanup job
├── __tests__/
│   └── device-auth.service.spec.ts       # Service unit tests
├── device-auth.controller.ts             # REST API endpoints
├── device-auth.service.ts                # Business logic
├── device-auth.module.ts                 # NestJS module definition
└── README.md                             # This file
```

### Database Schema

The `device_codes` table stores device authorization requests:

```prisma
model DeviceCode {
  id         String           @id @default(uuid())
  deviceCode String           @unique @map("device_code")  // Hashed
  userCode   String           @unique @map("user_code")     // XXXX-XXXX format
  userId     String?          @map("user_id")
  status     DeviceCodeStatus @default(pending)
  clientInfo Json?            @map("client_info")
  scopes     String[]
  expiresAt  DateTime         @map("expires_at")
  createdAt  DateTime         @default(now())
  updatedAt  DateTime         @updatedAt

  // Issued-credential link — see "Session Revocation" below
  patId               String?   @map("pat_id")
  collectedAt         DateTime? @map("collected_at")
  credentialExpiresAt DateTime? @map("credential_expires_at")
  revokedAt           DateTime? @map("revoked_at")
}

enum DeviceCodeStatus {
  pending
  approved
  denied
  expired
}
```

`patId`, `collectedAt` and `credentialExpiresAt` are set together, at
collection time, by whichever poll claims the code — see
[Session Revocation](#session-revocation). `revokedAt` is set by
`DELETE /api/auth/device/sessions/:id` and is what `getUserDeviceSessions()`
filters on; it is distinct from `PersonalAccessToken.revokedAt` and
`RefreshToken.revokedAt`, which the same call also sets on the linked rows.

`refresh_tokens` carries a matching `deviceCodeId` column (nullable, `SetNull`
on delete) so a refresh token minted from a device session can be reached the
same way. Both columns were added in migration
`20260927130000_add_device_session_credential_link`, additively — no backfill,
no data migration.

## API Endpoints

### 1. POST /api/auth/device/code (Public)

Generates a new device code pair to initiate the authorization flow.

**Request:**
```json
{
  "clientInfo": {
    "deviceName": "CLI Tool",
    "userAgent": "MyApp/1.0",
    "tokenType": "pat"
  }
}
```

`clientInfo.tokenType` is `"session"` or `"pat"` and defaults to `"session"`
when omitted, which is what the web activation page sends. An unrecognised
value is rejected with a `400` by the validation pipe rather than falling back
— a device that asked for something the server does not understand is not
handed a credential of the server's choosing.

**Response:**
```json
{
  "data": {
    "deviceCode": "a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4",
    "userCode": "ABCD-1234",
    "verificationUri": "http://localhost:3535/activate",
    "verificationUriComplete": "http://localhost:3535/activate?code=ABCD-1234",
    "expiresIn": 900,
    "interval": 5
  }
}
```

### 2. POST /api/auth/device/token (Public)

Device polls this endpoint to check authorization status.

**Request:**
```json
{
  "deviceCode": "a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4"
}
```

**Response (Success — `session` credential):**
```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "tokenType": "Bearer",
    "expiresIn": 900
  }
}
```

**Response (Success — `pat` credential):**
```json
{
  "data": {
    "accessToken": "pat_a1b2c3d4...",
    "tokenType": "Bearer",
    "expiresIn": 7776000,
    "credentialType": "pat",
    "expiresAt": "2026-11-28T12:00:00.000Z",
    "tokenId": "123e4567-e89b-12d3-a456-426614174000",
    "tokenName": "Device: CLI Tool"
  }
}
```

Both shapes come from the same `DeviceTokenResponseDto`; they differ only in
which optional fields are populated. Note in particular:

- `tokenType` is the literal `"Bearer"` for **both** kinds. It describes how to
  present the credential, not which kind it is — a PAT is sent as
  `Authorization: Bearer pat_...` and `JwtAuthGuard` accepts it on that header.
- `credentialType` is the discriminator: present and equal to `"pat"` on the
  PAT branch, **absent** on the session branch. This mirrors the request side,
  where an absent `clientInfo.tokenType` also means session. Do not
  discriminate on `refreshToken === undefined`.
- `refreshToken` is present for the session credential only. A PAT has no
  refresh token by design: re-running the device login is its renewal path, and
  the refresh flow relies on an HttpOnly cookie a CLI does not have.
- `expiresAt`, `tokenId` and `tokenName` are PAT-only. `expiresAt` is absolute
  because a CLI writes its token to a config file and re-reads it days later,
  where a relative `expiresIn` captured at issue time is useless on its own.
  `tokenId` is the id to pass to `DELETE /api/pat/{id}` to revoke the token,
  and `tokenName` is the row a user will see in the web UI's Access Tokens page.

The session response is byte-for-byte what it has always been — no field was
added, removed, renamed or re-typed on that branch.

**Response (Pending - 400):**
```json
{
  "error": "authorization_pending",
  "error_description": "User has not yet authorized this device"
}
```

**Response (Rate Limited - 400):**
```json
{
  "error": "slow_down",
  "error_description": "Polling too frequently. Please slow down."
}
```

**Other Error Codes:**
- `expired_token` - The device code has expired
- `access_denied` - User denied the authorization request

### 3. GET /api/auth/device/activate (Authenticated)

Returns information for the device activation page.

**Query Parameters:**
- `code` (optional): User verification code (e.g., "ABCD-1234")

**Response (no code):**
```json
{
  "data": {
    "verificationUri": "http://localhost:3535/activate"
  }
}
```

**Response (with valid code):**
```json
{
  "data": {
    "verificationUri": "http://localhost:3535/activate",
    "userCode": "ABCD-1234",
    "clientInfo": {
      "deviceName": "CLI Tool"
    },
    "expiresAt": "2026-01-22T12:00:00Z"
  }
}
```

### 4. POST /api/auth/device/authorize (Authenticated)

User approves or denies a device authorization request.

**Request:**
```json
{
  "userCode": "ABCD-1234",
  "approve": true
}
```

**Response:**
```json
{
  "data": {
    "success": true,
    "message": "Device authorized successfully"
  }
}
```

### 5. GET /api/auth/device/sessions (Authenticated)

Lists the user's live device sessions: codes that are `approved` and not yet
collected, plus collected sessions whose credential has not passed
`credentialExpiresAt`. A revoked session is never listed.

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Page size (default: 10)

**Response:**
```json
{
  "data": {
    "sessions": [
      {
        "id": "123e4567-e89b-12d3-a456-426614174000",
        "userCode": "ABCD-1234",
        "status": "approved",
        "clientInfo": {
          "deviceName": "CLI Tool"
        },
        "createdAt": "2026-01-22T10:30:00Z",
        "expiresAt": "2026-01-22T10:45:00Z",
        "collectedAt": null,
        "credentialExpiresAt": null,
        "credentialType": null
      }
    ],
    "total": 1,
    "page": 1,
    "limit": 10
  }
}
```

`collectedAt`, `credentialExpiresAt` and `credentialType` are all `null` for
an approved-but-uncollected row. Once the device collects its credential,
`status` becomes `expired` (see [Database Schema](#database-schema)) and the
three fields are populated — `credentialType` is `'pat'` or `'session'`,
read from the same `clientInfo.tokenType` the token endpoint used, so it
stays right even after the PAT row itself is gone.

### 6. DELETE /api/auth/device/sessions/:id (Authenticated)

Revokes a specific device session and whatever credential it issued. See
[Session Revocation](#session-revocation) for exactly what this reaches.

**Response:**
```json
{
  "data": {
    "success": true,
    "message": "Device session revoked successfully"
  }
}
```

## Credential kinds

A device chooses what it wants when it requests the code, via
`clientInfo.tokenType`:

| | `session` (default) | `pat` |
|---|---|---|
| What it is | Signed JWT access token + refresh token | Opaque personal access token (`pat_...`) |
| Default lifetime | `DEVICE_TOKEN_EXPIRY_DAYS` (7 days) | `DEVICE_PAT_EXPIRY_DAYS` (90 days) |
| Refresh token | Yes | No |
| Revocable before expiry | Yes — `DELETE /api/auth/device/sessions/{id}` revokes the refresh-token chain and kills the access token on its next request (see [Session Revocation](#session-revocation)) | Yes — `DELETE /api/pat/{id}`, the Access Tokens page, or `DELETE /api/auth/device/sessions/{id}` |
| Used by | The browser-driven activation page (sends no `tokenType`) | CLI and other headless clients |

The PAT lifetime can be much longer than the session lifetime precisely
*because* it is revocable server-side: a lost laptop is handled by deleting one
row, with nothing else to rotate. Raising `DEVICE_TOKEN_EXPIRY_DAYS` to
CLI-friendly lengths instead would weaken every device session in the app to
serve one client.

A device-issued PAT is named `Device: <deviceName>`, so it is identifiable in
the Access Tokens list as device-flow-issued rather than hand-created. The
`deviceName` reaching that list arrives from an **unauthenticated** caller
(`POST /auth/device/code` is public), so it is sanitised before use —
normalised, stripped of control, zero-width and bidi-override characters, and
truncated to the same 100-character ceiling the PAT UI enforces, with the
`Device: ` prefix applied afterwards so it can never be displaced. See
`DeviceAuthService.buildPatName()`.

`DEVICE_PAT_EXPIRY_DAYS` is clamped to 1–999 days (the same ceiling
`createPatSchema` enforces on a hand-created PAT); anything outside that range,
or non-numeric, logs a warning and falls back to 90 days. The device flow calls
`PatService` directly and therefore bypasses that zod schema, so the clamp is
applied in `DeviceAuthService.resolvePatExpiryDays()`.

### Why the PAT is minted on the poll, not at approval

Approval records **intent only** — `status = approved` plus `userId`. The PAT
itself is created in the poll request that returns it, in
`DeviceAuthService.issuePatCredential()`.

The alternative — mint at approval, stash the raw token on the `device_codes`
row until the device's next poll collects it — would be a real regression.
`PatService.createToken` returns the raw token exactly once and stores only a
SHA-256 hash, so that a database backup, a replica, a `SELECT *` in a support
tool, a query log or an SQL-injection read yields no usable credential. Writing
the raw token into another table, even briefly, reintroduces the
plaintext-credential-at-rest problem the PAT design already solved — in a table
that is publicly writable at one end (anyone can `POST /auth/device/code`) and
swept by a cleanup task rather than by careful deletion. And the window is not
short: RFC 8628 polling is best-effort, so the plaintext would sit there for the
full device-code lifetime if the CLI is slow, backgrounded or killed after the
user approves.

Minting on the poll means the raw token exists only in the API process's memory
and in the HTTPS response body. It also matches what the session path has always
done (tokens generated at poll time, not at approve time), so there is one rule
for both credential kinds. Two consequences are accepted deliberately:

- **Approve-then-never-poll creates no token.** No orphaned long-lived
  credential exists for a CLI that died, and nothing needs reaping.
- **The token cannot be re-fetched.** A device that loses the response must
  re-run the flow. That is correct for a write-once secret.

The PAT branch also **claims the device code atomically before minting**: a
single conditional `UPDATE` (`WHERE status = approved`) means exactly one
concurrent poll proceeds and the rest are refused with `invalid_grant`. Two
concurrent polls must never leave two independently valid months-long
credentials on the account, where revoking the visible one would not revoke the
other. The in-memory poll rate limiter cannot prevent that — it is per-process,
so it does nothing across replicas. Note the ordering: the code is consumed
*before* the token is minted, so if minting fails the device must re-authorize.
Failing closed is the right direction.

## Session Revocation

The credential a device session issues is not an opaque grant the server
forgets about once minted — it stays linked to the `DeviceCode` row that
issued it, in both directions, so revoking that row reaches everything it
handed out.

- **Minting the link.** `DeviceAuthService` passes `deviceCodeId` into
  `AuthService.generateFullTokens()` only from the session path, at collection
  time. That call stamps the access JWT with a `did` claim carrying the
  device session's id and stores `deviceCodeId` on the new `refresh_tokens`
  row (migration `20260927130000_add_device_session_credential_link`). An
  interactive login's tokens never carry `did`.
- **Checked on every request.** `AuthService.validateJwtPayload()` re-checks
  `did` on every authenticated request: it looks up the `DeviceCode` row and
  rejects (`401`) unless it exists, belongs to the token's `sub`, is not
  revoked, and has not passed `credentialExpiresAt`
  (`isDeviceSessionLive()`). This is what makes revocation immediate instead
  of waiting out a 7-day access token's own expiry.
- **Carried through rotation.** `AuthService.refreshAccessToken()` keeps the
  chain a device chain: the rotated refresh token keeps `deviceCodeId`, the
  new access token keeps `did`, and the pair's expiry is capped at the device
  session's `credentialExpiresAt` — rotation can never outlive the session or
  launder a device credential into an ordinary 14-day login. A refresh
  attempted on a revoked device session is refused as a plain
  already-revoked error, not routed through reuse detection
  (`revokeAllUserTokens`): the device will still present its last refresh
  token once after the user revokes it, and that is expected, not evidence of
  theft.
- **One entry point.** `DeviceAuthService.revokeDeviceSession()`
  (`DELETE /api/auth/device/sessions/:id`) does all of the above in a single
  transaction: it sets `device_codes.revokedAt`, denies the code if it was
  never collected, conditionally revokes the linked PAT
  (`personalAccessToken.updateMany` with `revokedAt: null` in the `WHERE`, so
  a PAT already revoked from the Access Tokens page is not an error), and
  revokes every `refresh_tokens` row carrying that `deviceCodeId`. Calling it
  again, or approaching revocation from either credential's own endpoint
  first, is harmless.
- **One asymmetry.** Revoking the linked PAT directly (`DELETE /api/pat/{id}`
  or the Access Tokens page) does not set `device_codes.revokedAt`: the
  credential stops authenticating immediately, but the session keeps
  appearing in `GET /api/auth/device/sessions` until its own
  `credentialExpiresAt` passes, or something also calls
  `DELETE /api/auth/device/sessions/:id` on it.
- **Cleanup respects the link.** `cleanupExpiredCodes()` keeps a collected row
  — revoked or not — until `credentialExpiresAt` passes, because that row is
  exactly what `did` validation looks up. Deleting it earlier would fail a
  still-valid-looking token for the wrong reason. Only a never-collected
  row's own age (`updatedAt`) governs its reaping.

A `pat`-kind session is linked the same way (`DeviceCode.patId`,
`credentialExpiresAt` copied from the PAT's own expiry at mint time in
`issuePatCredential()`), so `revokeDeviceSession()` revokes a `pat`-kind
session identically to a `session`-kind one.

## Configuration

Environment variables (see `infra/compose/.env.example`):

```bash
# Device Authorization Flow (RFC 8628)
DEVICE_CODE_EXPIRY_MINUTES=15    # How long device codes are valid
DEVICE_CODE_POLL_INTERVAL=5      # Minimum seconds between polls
DEVICE_TOKEN_EXPIRY_DAYS=7       # Lifetime of the `session` credential
DEVICE_PAT_EXPIRY_DAYS=90        # Lifetime of the `pat` credential (clamped to 1-999)
```

## Security Features

1. **Device Code Hashing**: Device codes are hashed before storage (SHA-256)
2. **User Code Format**: Human-friendly codes use unambiguous characters (no 0/O, 1/I/l)
3. **Rate Limiting**: Built-in polling rate limiting to prevent abuse
4. **Expiration**: Codes automatically expire after configured time
5. **One-time Use**: Approved codes are marked as expired once redeemed. Both
   the PAT and session paths claim the code atomically *before* minting
   anything (a single conditional `UPDATE` on `status = approved`), so two
   concurrent polls can never both collect a credential — the loser gets
   `invalid_grant`
6. **User Verification**: Only authenticated users can approve devices
7. **No Plaintext Credential at Rest**: PATs are stored as SHA-256 hashes and
   returned exactly once, on the poll that mints them — the raw token is never
   written to the database

## User Code Generation

User codes are generated using a safe character set to avoid confusion:
- Characters: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
- Format: `XXXX-XXXX` (e.g., `ABCD-1234`)
- Excludes: 0, O, 1, I, l (to prevent user confusion)

## Scheduled Tasks

### Device Code Cleanup

Expired codes are removed by the `device-auth.code.cleanup` queue job
(`handlers/device-code-cleanup.handler.ts`). The `@Cron` in
`tasks/device-code-cleanup.task.ts` runs daily at 2 AM and only enqueues that
job (through `jobs/housekeeping.enqueue.ts`); it deletes nothing itself. The job
removes:
- Device codes whose `expiresAt` has passed
- Codes marked `expired` (already used) more than 24 hours ago

Each run appears in the admin Jobs page like any other job.

## Integration Examples

### CLI Tool Example

The repository's own CLI (`apps/cli`, documented in
[`apps/cli/README.md`](../../../cli/README.md)) is the reference consumer of
this flow. A minimal client looks like this:

```typescript
// 1. Request device code, asking for a PAT rather than a session credential.
//    Every response below is wrapped in the API's `{ data, meta }` envelope.
const { data: { deviceCode, userCode, verificationUri, interval } } =
  await fetch('/api/auth/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientInfo: { deviceName: 'my-laptop', tokenType: 'pat' },
    }),
  }).then(r => r.json());

console.log(`Please visit ${verificationUri}`);
console.log(`Enter code: ${userCode}`);

// 2. Poll for authorization
while (true) {
  await sleep(interval * 1000);

  try {
    const { data: tokens } = await fetch('/api/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode })
    }).then(r => r.json());

    // Success! `tokens.accessToken` is a `pat_...` string here, because we
    // asked for `tokenType: 'pat'`. Persist it (and `expiresAt`) and send it
    // as `Authorization: Bearer <token>` on every later request.
    console.log('Authorized!');
    break;
  } catch (error) {
    if (error.error === 'authorization_pending') {
      continue; // Keep polling
    }
    throw error;
  }
}
```

### Frontend Integration (Activation Page)

```typescript
// Device activation page at /activate
const searchParams = new URLSearchParams(window.location.search);
const code = searchParams.get('code');

// Fetch device info
const { data: deviceInfo } = await fetch(
  `/api/auth/device/activate?code=${code}`,
  { headers: { Authorization: `Bearer ${accessToken}` } }
).then(r => r.json());

// Display device info and approval UI
// On approve:
await fetch('/api/auth/device/authorize', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    userCode: code,
    approve: true
  })
});
```

## Error Handling

The module follows RFC 8628 error codes for consistency:

| Error Code | Status | Description |
|------------|--------|-------------|
| `authorization_pending` | 400 | User hasn't authorized yet |
| `slow_down` | 400 | Polling too fast |
| `expired_token` | 400 | Device code expired |
| `access_denied` | 400 | User denied authorization |
| `invalid_grant` | 401 | Invalid device code |

## Testing

### Manual Testing

1. Generate a device code:
```bash
curl -X POST http://localhost:3535/api/auth/device/code \
  -H "Content-Type: application/json" \
  -d '{"clientInfo": {"deviceName": "Test CLI"}}'
```

2. Visit the verification URL and enter the user code

3. Poll for tokens:
```bash
curl -X POST http://localhost:3535/api/auth/device/token \
  -H "Content-Type: application/json" \
  -d '{"deviceCode": "YOUR_DEVICE_CODE"}'
```

## Future Enhancements

- [ ] Add scope-based permissions for device authorization
- [ ] Support for device-specific refresh token policies
- [ ] Device fingerprinting for enhanced security
- [ ] Geolocation tracking for device sessions
- [ ] Email notifications on new device authorizations
- [ ] Support for device names/descriptions in sessions UI
