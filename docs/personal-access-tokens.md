# Personal Access Tokens

A personal access token (PAT) is a long-lived bearer token that calls the API
as a specific user, with no browser involved. Use one for scripts, CI jobs, the
`appctl` CLI and server-side integrations.

- A PAT looks like `pat_` followed by 64 hex characters.
- It is accepted on every authenticated route, sent as
  `Authorization: Bearer pat_…`.
- It resolves to its owner's **current** roles and permissions on every
  request. If an admin changes the owner's roles, the token follows. If the
  owner is deactivated, the token stops working.
- There is no narrower scope. A token minted by an Admin can do anything an
  Admin can. Treat it like the owner's password.

For how PATs fit next to session JWTs and node credentials, see
[API conventions](API.md#authentication) and
[Security Architecture](SECURITY-ARCHITECTURE.md).

## Creating a Token in the UI

1. Open **Settings → Access Tokens** (`/settings/tokens`).
2. Click **Create Token**.
3. Enter a **Token Name** (1–100 characters) that says where the token will be
   used, for example `CI pipeline`.
4. Choose a **Duration** (a whole number from 1 to 999) and a **Unit**
   (minutes, days or months).
5. Click **Create Token**, then copy the token from the dialog.

The full token is shown once. The server stores only its SHA-256 hash, so it
cannot be shown again. If you lose it, revoke it and create a new one.

The Access Tokens page lists every token you own with its name, status
(Active, Expired or Revoked), token prefix, created date, expiry and last-used
time. **Revoke** stops a token immediately and cannot be undone.

## Using a Token

```bash
curl -H "Authorization: Bearer $PAT" http://localhost:3535/api/auth/me
```

```ts
const res = await fetch(`${baseUrl}/api/users`, {
  headers: { Authorization: `Bearer ${process.env.PAT}` },
});
```

Responses use the standard `{ data, meta }` envelope and error body described
in [API conventions](API.md).

## API

The three routes below need authentication only (a session JWT or a PAT). Each
acts on the caller's own tokens. Full schemas are in `/api/docs` under
**Personal Access Tokens**.

| Method | Route | Result |
|--------|-------|--------|
| `POST` | `/api/pat` | `201` with the new token (the only time `token` is returned) |
| `GET` | `/api/pat` | `200` with every token the caller owns, newest first |
| `DELETE` | `/api/pat/{id}` | `204 No Content`; `404` if the token is not the caller's or is already revoked |

### Create request

```json
{ "name": "CI pipeline", "durationValue": 90, "durationUnit": "days" }
```

| Field | Type | Rules |
|-------|------|-------|
| `name` | string | Required, trimmed, 1–100 characters |
| `durationValue` | integer | Required, 1–999 (a JSON number, not a string) |
| `durationUnit` | string | Required: `minutes`, `days` or `months` |

So the shortest token lives 1 minute and the longest 999 months. Anything
outside these rules is a `400`.

### Create response

```json
{
  "data": {
    "token": "pat_3f9c…",
    "id": "5b0f…",
    "name": "CI pipeline",
    "tokenPrefix": "pat_3f9c",
    "expiresAt": "2026-12-25T12:00:00.000Z",
    "createdAt": "2026-09-26T12:00:00.000Z"
  },
  "meta": { "timestamp": "2026-09-26T12:00:00.000Z" }
}
```

`tokenPrefix` is `pat_` plus the first four hex characters. It is stored in
clear so you can recognize a token in the list.

### List response items

| Field | Notes |
|-------|-------|
| `id`, `name`, `tokenPrefix` | As above |
| `durationValue`, `durationUnit` | What the token was created with |
| `expiresAt`, `createdAt` | ISO 8601 |
| `lastUsedAt` | ISO 8601, or `null` if never used |
| `revokedAt` | ISO 8601, or `null` if not revoked |

The list includes expired and revoked tokens until the cleanup job removes
them (see below). The raw token is never returned.

## Tokens Minted by the Device Flow

A browserless client can get a PAT without anyone copying it by hand. It starts
the [device authorization flow](DEVICE-AUTH.md) with `tokenType: "pat"` in
`clientInfo`:

```json
{ "clientInfo": { "deviceName": "build-agent-7", "tokenType": "pat" } }
```

When the user approves the code at `/activate`, the next poll of
`POST /api/auth/device/token` mints a PAT for that user and returns it:

```json
{
  "accessToken": "pat_…",
  "tokenType": "Bearer",
  "expiresIn": 7775999,
  "credentialType": "pat",
  "expiresAt": "…",
  "tokenId": "…",
  "tokenName": "Device: build-agent-7"
}
```

- The token is named `Device: <deviceName>`. The name is sanitized (control and
  invisible characters removed, truncated to 100 characters). Without a
  `deviceName` it is `Device: Unnamed device`.
- Its lifetime is `DEVICE_PAT_EXPIRY_DAYS` days (default 90). A value outside
  1–999, or a non-number, logs a warning and falls back to 90.
- It appears on the Access Tokens page like any other token and is revoked the
  same way. It is also linked to the device session that minted it, so
  revoking that session from `DELETE /api/auth/device/sessions/{id}` (see
  [Device Session Management](DEVICE-AUTH.md#device-session-management))
  revokes this token too; revoking from either side first makes the other a
  no-op.
- Without `tokenType` (or with `"session"`), the flow returns a session JWT and
  refresh token instead.

## Using a Token with appctl

`appctl login` runs the device flow with `tokenType: "pat"` and stores the
resulting token. You can also pass an existing token with
`appctl login --server <url> --token pat_…`, or set `APPCTL_SERVER_URL` and
`APPCTL_TOKEN` in CI. See the [CLI README](../apps/cli/README.md).

## Expiry and Cleanup

- An expired or revoked token is rejected with `401` on the next request.
- `lastUsedAt` is updated on each successful request.
- A daily `auth.token.cleanup` job deletes expired tokens and tokens revoked
  more than 30 days ago.

## Handling Tokens Safely

- Store tokens in a secrets manager or CI secret, never in source control or
  logs.
- Use the shortest duration that works, and rotate long-lived tokens.
- For automation, mint the token from an account that holds only the
  permissions the job needs, not an Admin account.
- Revoke a token as soon as it is no longer needed or may have leaked.
