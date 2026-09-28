# Device Authorization Flow (RFC 8628)

This guide shows how to sign a browserless client (a CLI, a script on a
server, a TV app) in to this application with the Device Authorization Grant.

> **Where the contract lives.** This is the integration guide: concepts, a
> walkthrough and copy-paste examples. The exact request and response schemas
> are in the generated API reference at `/api/docs` (tag **Device
> Authorization**). The implementation notes and the security rationale live
> next to the code in
> [`apps/api/src/device-auth/README.md`](../apps/api/src/device-auth/README.md).

## Table of Contents

- [Overview](#overview)
- [Use Cases](#use-cases)
- [How It Works](#how-it-works)
- [Credential Kinds: Session vs. PAT](#credential-kinds-session-vs-pat)
- [API Reference](#api-reference)
- [Integration Guides](#integration-guides)
- [Configuration](#configuration)
- [Device Session Management](#device-session-management)
- [Security Considerations](#security-considerations)
- [Error Handling](#error-handling)
- [Troubleshooting](#troubleshooting)

---

## Overview

The Device Authorization Grant ([RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628))
lets a device that cannot run a browser sign-in obtain a credential for a user.
The device shows a short code; the user opens the web app on another device,
signs in with Google as usual, and approves the code. Meanwhile the device
polls until the credential is ready.

- The user signs in on a device that has a browser.
- The device only ever polls. It never sees the user's Google session.
- Codes are short, human-readable, time-limited and single-use.
- The device chooses the credential it wants: a session (JWT plus refresh
  token) or a personal access token.

The first-party `appctl` CLI signs in this way. See
[`apps/cli/README.md`](../apps/cli/README.md).

---

## Use Cases

- **CLI tools.** A command-line client that must act as the user, for example
  `appctl login`:

  ```bash
  $ appctl login
  Visit http://localhost:3535/activate and enter code ABCD-1234
  Waiting for authorization...
  ```

- **Headless servers and CI setup.** Run the flow once from a terminal, approve
  on your laptop, and store the resulting personal access token as a secret.
- **TVs, kiosks and embedded devices.** Show the code on screen and let the user
  approve on a phone.
- **The API reference.** If you are signed in to the app in the same browser,
  `/api/docs` authorizes itself; otherwise the device flow is one way to get a
  token to paste into it (see [API Reference (Scalar)](#api-reference-scalar)).

---

## How It Works

### Flow Diagram

```
┌──────────────┐                                  ┌──────────────┐
│    Device    │                                  │     User     │
│ (CLI/App/IoT)│                                  │  (Browser)   │
└──────┬───────┘                                  └──────┬───────┘
       │  1. POST /api/auth/device/code                  │
       ├──────────────────────────────►                  │
       │  deviceCode, userCode "ABCD-1234",              │
       │  verificationUri ".../activate"                 │
       │◄──────────────────────────────                  │
       │                                                 │
       │  2. Show "Visit .../activate, enter ABCD-1234"  │
       │                                                 │
       │                               3. Open /activate, sign in
       │                               4. Enter or confirm the code
       │                               5. POST /api/auth/device/authorize
       │                                  { userCode, approve: true }
       │                                                 │
       │  6. POST /api/auth/device/token (every 5 s)     │
       ├──────────────────────────────►                  │
       │  400 authorization_pending                      │
       │◄──────────────────────────────                  │
       │  7. POST /api/auth/device/token                 │
       ├──────────────────────────────►                  │
       │  200 { accessToken, ... }                       │
       │◄──────────────────────────────                  │
       │                                                 │
       │  8. Authorization: Bearer <accessToken>         │
```

### Step-by-Step Process

#### 1. Device Requests Authorization

```http
POST /api/auth/device/code
Content-Type: application/json

{
  "clientInfo": {
    "deviceName": "My CLI Tool",
    "userAgent": "my-cli/1.0.0",
    "tokenType": "session"
  }
}
```

`clientInfo` and every field in it are optional. The schema accepts exactly
three fields: `deviceName`, `userAgent` and `tokenType` (`"session"`, the
default, or `"pat"`). Unknown keys are silently stripped, so check spelling. An
unrecognized `tokenType` value is a `400`.

#### 2. Server Returns Codes

```json
{
  "data": {
    "deviceCode": "a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4…",
    "userCode": "ABCD-1234",
    "verificationUri": "http://localhost:3535/activate",
    "verificationUriComplete": "http://localhost:3535/activate?code=ABCD-1234",
    "expiresIn": 900,
    "interval": 5
  },
  "meta": { "timestamp": "2026-09-26T12:00:00.000Z" }
}
```

`verificationUri` is built from the deployment's `APP_URL` and always points to
the `/activate` page. Show the value you receive; do not hard-code the path.
Keep `deviceCode` secret: whoever holds it collects the credential.

#### 3. User Opens the Activation Page

The user opens `verificationUri` (or `verificationUriComplete`, which fills in
the code) and signs in if needed.

#### 4. User Enters the Code

The page looks the code up with `GET /api/auth/device/activate?code=…` and
shows the requesting device's `deviceName` and `userAgent`.

#### 5. User Approves or Denies

The page sends:

```http
POST /api/auth/device/authorize
Authorization: Bearer <user_access_token>
Content-Type: application/json

{ "userCode": "ABCD-1234", "approve": true }
```

Approval only records the decision. No credential is created yet.

#### 6. Device Polls for the Credential

```http
POST /api/auth/device/token
Content-Type: application/json

{ "deviceCode": "a4f3b8c9d2e1f5a6b7c8d9e0f1a2b3c4…" }
```

While the user has not decided, the answer is `400` with the RFC 8628 body.
This route does not use the API's usual error envelope:

```json
{ "error": "authorization_pending", "error_description": "User has not yet authorized this device" }
```

After approval, the next poll mints the credential. For the default `session`
kind:

```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "a1b2c3d4e5f6...",
    "tokenType": "Bearer",
    "expiresIn": 604800
  },
  "meta": { "timestamp": "2026-09-26T12:00:00.000Z" }
}
```

`expiresIn` is in seconds; the default is `DEVICE_TOKEN_EXPIRY_DAYS` (7 days).
For `tokenType: "pat"` the shape differs; see
[Credential Kinds](#credential-kinds-session-vs-pat).

#### 7. Device Uses the Credential

Send `Authorization: Bearer <accessToken>` on every request. The device code is
now used up; polling it again returns `expired_token`.

---

## Credential Kinds: Session vs. PAT

The device picks the credential with `clientInfo.tokenType` in step 1:

| | `session` (default) | `pat` |
|---|---|---|
| What it is | Signed JWT access token plus refresh token | Opaque personal access token (`pat_…`) |
| Default lifetime | `DEVICE_TOKEN_EXPIRY_DAYS` (7 days), for both tokens | `DEVICE_PAT_EXPIRY_DAYS` (90 days) |
| Refresh token | Yes | No |
| Revocable before expiry | Yes: `DELETE /api/auth/device/sessions/{id}` revokes the refresh-token chain and kills the access token on its very next request | Yes: `DELETE /api/pat/{id}`, the Access Tokens page, or `DELETE /api/auth/device/sessions/{id}` |
| Typical client | Short-lived or interactive devices | CLIs and other headless clients (`appctl`) |

The `pat` poll response:

```json
{
  "data": {
    "accessToken": "pat_a1b2c3d4...",
    "tokenType": "Bearer",
    "expiresIn": 7775999,
    "credentialType": "pat",
    "expiresAt": "2026-12-25T12:00:00.000Z",
    "tokenId": "123e4567-e89b-12d3-a456-426614174000",
    "tokenName": "Device: My CLI Tool"
  },
  "meta": { "timestamp": "2026-09-26T12:00:00.000Z" }
}
```

- `tokenType` is always `"Bearer"`. It says how to send the credential, not
  what kind it is.
- `credentialType: "pat"` is the discriminator. It is absent for a session.
  Branch on it, not on whether `refreshToken` is missing.
- `refreshToken` appears only for a session. `expiresAt`, `tokenId` and
  `tokenName` appear only for a PAT.

Details of the PAT branch:

- **Minted on the poll, not at approval.** The raw token exists only in the API
  process's memory and the HTTPS response. It is never written anywhere in
  clear. The device code is claimed atomically first, so two racing polls
  cannot both collect a token. See the
  [rationale](../apps/api/src/device-auth/README.md#why-the-pat-is-minted-on-the-poll-not-at-approval).
- **Name.** The token is named `Device: <deviceName>`. Because `deviceName`
  comes from an unauthenticated caller, control, zero-width and bidi-override
  characters are removed and the name is truncated to 100 characters. An empty
  name becomes `Device: Unnamed device`.
- **Lifetime.** `DEVICE_PAT_EXPIRY_DAYS` must be a whole number from 1 to 999.
  Any other value logs a warning and falls back to 90 days.

A PAT can live longer than a session precisely because it can be revoked: a
lost laptop costs one click on the Access Tokens page. See
[Personal Access Tokens](personal-access-tokens.md).

---

## API Reference

The contract (schemas, examples, status codes) is in the generated reference at
`/api/docs`, tag **Device Authorization**. This is a summary.

| Route | Purpose | Auth |
|-------|---------|------|
| `POST /api/auth/device/code` | Start the flow; returns `deviceCode`, `userCode`, `verificationUri`, `verificationUriComplete`, `expiresIn`, `interval` | Public |
| `POST /api/auth/device/token` | Poll with `deviceCode`; returns the credential or an RFC 8628 error | Public |
| `GET /api/auth/device/activate?code=` | Activation page data: `verificationUri`, and for a code its `clientInfo` and `expiresAt` | Session JWT or PAT |
| `POST /api/auth/device/authorize` | Approve or deny: `{ userCode, approve }` | Session JWT or PAT |
| `GET /api/auth/device/sessions?page=&limit=` | Your live device sessions — codes approved but not yet collected, plus collected sessions whose credential has not expired: `{ sessions, total, page, limit }` (default `limit` 10), each with `collectedAt`, `credentialExpiresAt`, `credentialType` | Session JWT or PAT |
| `DELETE /api/auth/device/sessions/{id}` | Revoke one of your sessions: denies it if not yet collected, and revokes its PAT and refresh-token chain if it was | Session JWT or PAT |

Error statuses on the lookup and approval routes: `404` for an unknown user
code, `400` for an expired code or one that was already approved or denied.
`activate` and `authorize` stay reachable during a maintenance window.

For the implementation (module layout, `device_codes` table, services, tests),
read [`apps/api/src/device-auth/README.md`](../apps/api/src/device-auth/README.md).

---

## Integration Guides

The examples below use the `session` credential. For a long-lived CLI login,
add `tokenType: 'pat'` to `clientInfo` and store `accessToken` only (there is
no refresh token).

### CLI Application (Node.js)

```javascript
const API_BASE = 'http://localhost:3535/api';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, body: await res.json() };
}

async function loginWithDeviceFlow() {
  // Step 1: request a device code
  const start = await post('/auth/device/code', {
    clientInfo: {
      deviceName: 'My CLI Tool',
      userAgent: `my-cli/1.0.0 (${process.platform})`,
    },
  });
  const { deviceCode, userCode, verificationUriComplete, interval } = start.body.data;

  // Step 2: tell the user what to do
  console.log(`Visit ${verificationUriComplete} and confirm code ${userCode}`);

  // Step 3: poll
  let pollMs = interval * 1000;
  for (;;) {
    await sleep(pollMs);
    const res = await post('/auth/device/token', { deviceCode });

    if (res.ok) {
      const { accessToken, refreshToken } = res.body.data;
      saveTokens(accessToken, refreshToken);
      console.log('Authorized.');
      return;
    }

    switch (res.body.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        pollMs += 5000;
        continue;
      case 'expired_token':
        throw new Error('The code expired. Run login again.');
      case 'access_denied':
        throw new Error('Authorization was denied.');
      default:
        throw new Error(`Unexpected error: ${res.body.error_description ?? res.body.message}`);
    }
  }
}

function saveTokens(accessToken, refreshToken) {
  // Store in a file with owner-only permissions or an OS keychain.
}

loginWithDeviceFlow().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

### CLI Application (Python)

```python
import sys
import time
import requests

API_BASE = 'http://localhost:3535/api'


def login_with_device_flow():
    # Step 1: request a device code
    start = requests.post(f'{API_BASE}/auth/device/code', json={
        'clientInfo': {
            'deviceName': 'My Python CLI',
            'userAgent': f'my-python-cli/1.0.0 ({sys.platform})',
        }
    })
    start.raise_for_status()
    data = start.json()['data']

    # Step 2: tell the user what to do
    print(f"Visit {data['verificationUriComplete']} and confirm code {data['userCode']}")

    # Step 3: poll
    poll_interval = data['interval']
    while True:
        time.sleep(poll_interval)
        res = requests.post(f'{API_BASE}/auth/device/token',
                            json={'deviceCode': data['deviceCode']})

        if res.ok:
            tokens = res.json()['data']
            save_tokens(tokens['accessToken'], tokens.get('refreshToken'))
            print('Authorized.')
            return

        error = res.json().get('error')
        if error == 'authorization_pending':
            continue
        if error == 'slow_down':
            poll_interval += 5
            continue
        if error == 'expired_token':
            sys.exit('The code expired. Run login again.')
        if error == 'access_denied':
            sys.exit('Authorization was denied.')
        sys.exit(f'Unexpected error: {res.text}')


def save_tokens(access_token, refresh_token):
    # Store with owner-only permissions or in an OS keychain.
    pass


if __name__ == '__main__':
    login_with_device_flow()
```

### API Reference (Scalar)

`/api/docs` is a [Scalar](https://scalar.com) reference. If you are signed in
to the app in the same browser, it authorizes itself on load; see
[API conventions](API.md#one-click-session-auth). Otherwise:

1. Call `POST /api/auth/device/code` from the reference's request client or
   `curl`.
2. Open `verificationUriComplete`, sign in, and approve the code.
3. Call `POST /api/auth/device/token` with the `deviceCode`.
4. Paste `accessToken` into the `JWT-auth` scheme (or into `PAT-auth` if you
   requested `tokenType: "pat"`).

If you already have a browser session, creating a token on the Access Tokens
page is quicker than the device flow.

### Mobile and Embedded Applications

The pattern is the same as the CLI examples: request a code, show `userCode`
and a button or QR code for `verificationUriComplete`, and poll every
`interval` seconds in the background. Store the credential in the platform's
secure storage (Keychain, Android Keystore), never in plain preferences.

---

## Configuration

Set these in `infra/compose/.env`:

| Variable | Default | Meaning |
|----------|---------|---------|
| `DEVICE_CODE_EXPIRY_MINUTES` | 15 | How long a device code and user code stay valid |
| `DEVICE_CODE_POLL_INTERVAL` | 5 | Minimum seconds between polls (returned as `interval`) |
| `DEVICE_TOKEN_EXPIRY_DAYS` | 7 | Lifetime of the `session` credential (access and refresh token) |
| `DEVICE_PAT_EXPIRY_DAYS` | 90 | Lifetime of the `pat` credential; 1–999, otherwise falls back to 90 |

They are loaded in `apps/api/src/config/configuration.ts` under `deviceAuth`.
A device session's lifetime replaces `JWT_ACCESS_TTL_MINUTES` and
`JWT_REFRESH_TTL_DAYS` for credentials issued through this flow.

Guidance:

- **Code expiry**: under 5 minutes rushes users; over 30 minutes leaves a
  leaked code usable for longer. 10–15 minutes suits most cases.
- **Poll interval**: 5 seconds balances server load and responsiveness.

---

## Device Session Management

A device code moves through these states:

| Status | Meaning |
|--------|---------|
| `pending` | Created, waiting for the user |
| `approved` | The user approved; the device has not collected its credential yet |
| `denied` | The user denied it, or it was revoked before collection |
| `expired` | Used (credential collected) or timed out |

`GET /api/auth/device/sessions` lists two kinds of row: codes that are
`approved` and not yet collected, and collected sessions whose credential has
not passed `credentialExpiresAt`. Each row carries `collectedAt`,
`credentialExpiresAt` and `credentialType` (`'pat'`, `'session'`, or `null`
before collection), so a client can tell "waiting to be picked up" from
"picked up and still valid" without a second call. A revoked session is never
listed.

`DELETE /api/auth/device/sessions/{id}` revokes the session **and** whatever
credential it issued, in one step:

- an uncollected request is also marked `denied`, so the device's next poll
  gets `access_denied`;
- a collected PAT is revoked;
- every refresh token minted from this session is revoked, and the session's
  access token stops authenticating on its very next request — a
  device-issued access token carries a `did` claim identifying its session,
  which the API re-checks on every request and which fails closed the moment
  the session is revoked or its credential has expired.

Calling it more than once, or on a device already dealt with from the other
side, is harmless: revoking a PAT on **Settings → Access Tokens** first and
then revoking the session here is a no-op on the second step, and vice versa.
One asymmetry to know about: revoking the PAT directly from the Access Tokens
page does **not** remove the session from this list — the credential itself
stops working immediately, but the session row keeps appearing here until its
`credentialExpiresAt` passes (or you also call
`DELETE /api/auth/device/sessions/{id}` on it, which then does nothing
further).

There is no longer a gap to bridge for a session-kind credential: revoking
the device session here is enough on its own, for both credential kinds.
`POST /api/auth/logout-all` and deactivating the account remain available as
broader tools (every session, or every credential the user holds), not as a
substitute for revoking one device.

Expired and revoked device codes are cleaned up by the daily
`device-auth.code.cleanup` job; a collected row is kept until its credential's
`credentialExpiresAt` passes, revoked or not, since that row is what the
`did` claim is checked against on every request.

---

## Security Considerations

- **User codes** are 8 characters, shown as `XXXX-XXXX`, from
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O or 1/I/l).
- **Device codes** are 32 random bytes. Only a SHA-256 hash is stored.
- **Polling rate.** Polling a code faster than `interval` returns `slow_down`.
  The last-poll time is kept in the API process's memory, per code.
- **Expiry and single use.** Codes expire after `DEVICE_CODE_EXPIRY_MINUTES`
  and are marked `expired` once the credential is collected.
- **Explicit approval.** The signed-in user must approve each code and sees
  the device's self-reported name and user agent first. Both are
  attacker-controlled (the code route is public), so the activation page
  sanitizes them before display.
- **Allowlist.** Only a user who can sign in (an allowlisted email) can
  approve a code.
- **Validation.** `clientInfo` is validated by a Zod schema; `authorize`
  requires a `XXXX-XXXX` code. The activation lookup normalizes case and
  whitespace.

See [Security Architecture](SECURITY-ARCHITECTURE.md) for how these
credentials fit with the rest of the auth model.

---

## Error Handling

`POST /api/auth/device/token` returns RFC 8628 errors verbatim, as
`{ "error": "…", "error_description": "…" }`, with no `statusCode`, `code` or
`data` wrapper.

| `error` | Status | Meaning | What to do |
|---------|--------|---------|------------|
| `authorization_pending` | 400 | The user has not decided yet | Keep polling at `interval` |
| `slow_down` | 400 | You polled faster than `interval` | Add 5 seconds to your interval and keep polling |
| `expired_token` | 400 | The code timed out, or its credential was already collected | Start again with a new code |
| `access_denied` | 400 | The user denied the request | Stop and tell the user |
| `invalid_grant` | 401 | Unknown device code, the code was already used, or the approving user no longer exists | Start again |
| `invalid_request` | 400 | The code is in an unexpected state | Start again |

Show "Waiting for authorization…" during `authorization_pending`, handle
`slow_down` silently, and show a clear message for `expired_token` and
`access_denied`.

The other device routes (`activate`, `authorize`, `sessions`) use the standard
error body described in [API conventions](API.md#errors).

---

## Troubleshooting

### "Invalid user code" (404)

The code was mistyped or never existed. Check it character by character. On
the API, `authorize` expects the uppercase `XXXX-XXXX` form; the activation
page normalizes what the user types.

### "This code has expired" (400)

More than `DEVICE_CODE_EXPIRY_MINUTES` passed since the code was created.
Start the flow again, or raise the expiry if users regularly need longer.

### "This code has already been processed" (400)

The code was already approved or denied. If it was approved, the device should
collect its credential on its next poll. If denied, start again. Codes cannot
be reused.

### Polling returns `slow_down` repeatedly

The client is polling faster than `interval`. Honor the `interval` from step 2
and add 5 seconds each time you get `slow_down`. If several API replicas serve
the requests, each keeps its own last-poll time.

### No credential after approval

- The device stopped polling before the user approved.
- The code expired between approval and the next poll.
- The approving account was deactivated or deleted.

Check the API logs; each approval and each issued credential is logged.

---

## Additional Resources

- [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)
- API reference in a running deployment: `http://localhost:3535/api/docs`
- [API conventions](API.md)
- [Personal Access Tokens](personal-access-tokens.md)
- [Security Architecture](SECURITY-ARCHITECTURE.md)
- [Device auth module README](../apps/api/src/device-auth/README.md)
- [`appctl` CLI](../apps/cli/README.md), the reference client for the `pat`
  credential
