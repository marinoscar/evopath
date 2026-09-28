# Per-User Encrypted Credentials

> **Status:** shipped (store only, no HTTP surface) · **Code:** `apps/api/src/user-credentials/`, `apps/api/src/credentials/credential-internals.ts`, `apps/api/src/common/crypto/secret-cipher.ts` · **API:** none · **Admin UI:** none · **Runbook:** [rotate-secrets-encryption-key.md](../runbooks/rotate-secrets-encryption-key.md)

`UserCredential` stores secrets that a **user** owns (bring-your-own-key),
encrypted at rest under a cipher domain bound to that user. It is the
per-user sibling of the deployment-owned `credentials` store. It ships as a
foundation: a table, a store (`UserCredentialsService`), a purpose registry
(`USER_CREDENTIAL_PURPOSES`) and a resolver (`UserCredentialResolver`). A
feature that needs a user key type adds one registry entry and its own
controller.

## 1. Purpose

`CredentialsService` (`apps/api/src/credentials/`) holds secrets the
**deployment** owns: SMTP, the Web Push VAPID private key, the object-storage
secret, the AI admin/org key. It is addressed by `(purpose, name)`, one row
per address. It has no notion of a secret a user brings: a webhook signing
secret, a personal token for an integration, or the user's own key for a
service the deployment also has a key for.

`user_credentials` fills that gap, addressed by `(userId, purpose, name)`.

What it is not:

- **Not an HTTP surface.** `UserCredentialsModule` ships no controller and no
  UI. The feature that exposes a key type owns its routes, permission and
  audit.
- **Not where AI keys live.** A user's AI provider key lives in `user_ai_keys`
  with its own resolver (`AiKeyResolver`); see
  [ai-platform.md](ai-platform.md). The production registry is empty.
- **Not a change to `credentials`.** That table is untouched.

The design and threat model of the deployment store are in
[SECURITY-ARCHITECTURE.md](../SECURITY-ARCHITECTURE.md) (Encrypted Credential
Storage).

## 2. How it works

### 2.1 Schema

```prisma
model UserCredential {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @map("user_id") @db.Uuid
  purpose   String
  name      String
  secret    String   @db.Text
  hint      String?
  label     String?
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz

  user User @relation("UserCredentials", fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, purpose, name])
  @@map("user_credentials")
}
```

- `secret` is ciphertext only (base64 AES-256-GCM), `@db.Text` so it is never
  truncated.
- `hint` and `label` are non-secret. `hint` is derived from the plaintext on
  write; `label` is user-entered.
- `onDelete: Cascade`: the row dies with its owner. There is no
  `updatedByUserId`; the owner is the only writer.
- `@@unique([userId, purpose, name])` is a normal Prisma index. Every column
  is `NOT NULL`, so no hand-written SQL is needed.

### 2.2 Owner-bound cipher domain

A `Credential` row is encrypted under a sub-key derived from its bare
`purpose`. A `UserCredential` row is encrypted under a domain that also binds
the owner:

```
user:<userId>:<purpose>
```

- Built by `userCredentialPurpose(userId, purpose)` in `secret-cipher.ts` and
  passed as the `purpose` argument to the unchanged
  `encryptSecret`/`decryptSecret`.
- `userId` must be a canonical UUID: lowercase hex, hyphenated, 8-4-4-4-12
  (`isCanonicalUuid`, `CANONICAL_UUID_PATTERN`). One spelling per id, no `:`.
  `assertCredentialOwner` enforces this at every service entry point, and
  `userCredentialPurpose` enforces it again as a backstop.
- `purpose` may not contain `:`, in **both** stores (`assertCredentialPurpose`).
  So no system purpose can spell a `user:` domain, and
  `(userId, purpose) → domain` is injective.
- Owner-bound domains (prefix `USER_CREDENTIAL_DOMAIN_PREFIX`) are **excluded
  from `deriveKey`'s cache.** They are one string per user × purpose, an
  unbounded set. The cost is one HMAC-SHA256 per call.

A ciphertext copied into another user's row, or into another purpose of the
same user, fails GCM authentication instead of decrypting (§6).

### 2.3 `UserCredentialsService`

`userId` is the first parameter of every method, and every query is scoped by
it. The address is always the full `(userId, purpose, name)` triple.

| Method | Returns | Behaviour |
|---|---|---|
| `getSecret(userId, purpose, name)` | `string \| null` | The only plaintext read. Server-side only, never from a controller. Throws `InternalServerErrorException` if a row exists but will not decrypt; never a silent `null`. |
| `describe(userId, purpose, name)` | `UserCredentialInfo \| null` | Presentation read. The `secret` column is not selected. |
| `list(userId, purpose?)` | `UserCredentialInfo[]` | The user's credentials, optionally for one purpose, ordered by `(purpose, name)`. |
| `setSecret(userId, purpose, name, secret, meta?)` | void | Create or update. `undefined`, `null` and `''` all mean "keep what is stored" and apply only `meta`. A blank secret with nothing stored is a `400`. `hint` is always derived, never accepted. |
| `deleteSecret(userId, purpose, name)` | void | The only way to erase. Idempotent. |

Invariants:

- **No plaintext egress.** `UserCredentialInfo` has no field able to hold a
  secret or ciphertext, and carries neither `id` nor `userId`. Compile-time
  `AssertTrue` proofs in `interfaces/user-credential-info.interface.ts`
  enforce this. `USER_CREDENTIAL_INFO_SELECT` is a
  `Record<keyof UserCredentialInfo, true>`, so selecting `secret` fails to
  compile.
- **No cross-user listing** and no lookup by `id` alone.
- **No audit events.** The feature that exposes a key type audits the act.
- **Log lines name the address** (`purpose`, `name`, `userId`), never a secret.

`UserCredentialsModule` is not `@Global()`. It exports only
`UserCredentialsService` and `UserCredentialResolver`, so every consumer is a
visible `imports: [UserCredentialsModule]` line.

### 2.4 Purpose registry

`USER_CREDENTIAL_PURPOSES` (`user-credential-purposes.ts`) is a flat array of
plain data, shaped like `notifications/notification-events.ts`:

```ts
interface UserCredentialPurposeDef {
  readonly purpose: string;                        // permanent once rows exist
  readonly label: string;                          // user-facing name
  readonly description: string;                    // user-facing copy
  readonly system: SystemCredentialAddress | null; // fallback address in `credentials`, or none
}
```

- `system` names the deployment's `(purpose, name)` counterpart, or `null`
  when a user's own key is the only possible answer.
- There is no per-entry "allow fallback" flag (§6).
- **It ships empty** (`[]`). `DEFAULT_USER_CREDENTIAL_NAME` is `'default'`.
- The resolver receives it through the `USER_CREDENTIAL_PURPOSE_REGISTRY`
  token, bound in `UserCredentialsModule`, so a test can supply a fixture.
- **Validated at boot.** The resolver's constructor calls
  `assertValidRegistry`, which checks each `purpose` and `system` address,
  requires non-empty `label` and `description`, and rejects duplicate
  purposes. A bad entry fails application start, not the first call.

### 2.5 `UserCredentialResolver`

```ts
async resolve(userId, purpose, name = DEFAULT_USER_CREDENTIAL_NAME): Promise<ResolvedCredential>
```

One fixed rule for every purpose:

1. The user's own credential, if stored.
2. Else the registry entry's `system` counterpart, read through
   `CredentialsService`, if declared and configured.
3. Else `{ source: 'none' }`.

`ResolvedCredential` is a discriminated union on `source`
(`'user' | 'system' | 'none'`), so a caller can attribute usage to the right
party. The `'user'` and `'system'` arms carry plaintext; the
`ResolvedCredentialSource` subset is safe to log or return. The system
address is fixed by the registry and ignores the caller's `name`.

Two failures are deliberate:

- **An unknown purpose throws** `InternalServerErrorException` before any
  store is read. It is a programming error, not "nothing configured".
- **A user credential that will not decrypt throws and never falls through to
  the system key.** Otherwise a user whose key broke would silently spend the
  organisation's key.

### 2.6 Shared internals

`apps/api/src/credentials/credential-internals.ts` holds the rules both
stores must agree on. Both services call it; `ai/keys/user-ai-keys.service.ts`
uses the same `deriveHint`.

| Function | Rule |
|---|---|
| `deriveHint(plaintext)` | Under 8 code points: `'••••'`. Otherwise the mask plus the last 4 code points. Iterates code points, so an astral character is never split. |
| `isBlankSecret(secret)` | `undefined`, `null` and `''` are blank. No `.trim()`: whitespace-only is a real value. |
| `assertCredentialIdentifier` / `assertCredentialPurpose` / `assertCredentialAddress` | Reject empty or whitespace-padded `purpose`/`name` (rejected, not trimmed, because `purpose` feeds the cipher). `assertCredentialPurpose` also rejects `:`. |
| `assertCredentialOwner(userId)` | User store only. Rejects anything that is not `isCanonicalUuid`. |

## 3. Configuration and permissions

- **`SECRETS_ENCRYPTION_KEY`**: base64 32-byte AES-256 master key, shared with
  the deployment store. Rotation:
  [rotate-secrets-encryption-key.md](../runbooks/rotate-secrets-encryption-key.md).
- **No settings namespace, no permissions, no routes.** The feature that adds
  a key type declares its own permission and routes. The permission matrix
  lives in [ARCHITECTURE.md](../ARCHITECTURE.md).

## 4. Extending it in a fork

Adding a user key type costs one registry entry and zero migrations.

1. **Declare the purpose** in `USER_CREDENTIAL_PURPOSES`:

   ```ts
   export const USER_CREDENTIAL_PURPOSES: readonly UserCredentialPurposeDef[] = [
     {
       purpose: 'webhook_signing_key', // permanent once rows exist; no ':'
       label: 'Webhook signing key',
       description: 'Used to verify webhooks this integration sends you.',
       system: null, // no deployment-wide counterpart
     },
   ];
   ```

   `assertValidRegistry` checks it at boot.

2. **Write it** from the feature's service, with
   `imports: [UserCredentialsModule]` in the feature's module:

   ```ts
   await this.userCredentials.setSecret(
     userId,
     'webhook_signing_key',
     DEFAULT_USER_CREDENTIAL_NAME,
     submittedSecret, // blank preserves what is stored
     { label: submittedLabel },
   );
   ```

3. **Read it** with `UserCredentialResolver.resolve(userId, purpose)` when the
   type has (or may later have) a system fallback, or
   `UserCredentialsService.getSecret(...)` when `system: null`. Both are
   server-side plaintext reads; never call them from a controller.

4. **Add the feature's own controller and DTOs**: its auth guard, its
   permission, and an `AuditService` call if the write should be audited.

5. **Present it** with `describe`/`list`, never from a raw row.
   `UserCredentialInfo` keeps the secret out of the response by construction.

Nothing in the table, the cipher, the service or the resolver changes.

## 5. Guardrails

| Invariant | Test |
|---|---|
| Two users at the same `(purpose, name)` stay apart; a row moved to another purpose fails to decrypt; no plaintext egress; blank preserves; address validation | `apps/api/src/user-credentials/user-credentials.service.spec.ts` |
| `'none'` without touching the system store when there is no counterpart; unknown purpose throws first; registry validated at construction; production registry is empty and does not declare `'ai'` | `apps/api/src/user-credentials/user-credential.resolver.spec.ts` |
| `userCredentialPurpose` requires a canonical UUID and a colon-free purpose | `apps/api/src/common/crypto/secret-cipher.spec.ts` |
| A system purpose containing `:` (including a `user:` spelling) is rejected | `apps/api/src/credentials/credential-internals.spec.ts` |
| `UserCredentialInfo` cannot hold a secret | compile-time proofs in `apps/api/src/user-credentials/interfaces/user-credential-info.interface.ts` |

## 6. Design decisions

- **Owner-bound cipher domain.** Without it, a bug or SQL write that copies
  user A's ciphertext into user B's row decrypts cleanly, and B silently gets
  A's key. With `user:<userId>:<purpose>` as the domain, the same ciphertext
  fails GCM authentication. The unique index and the cipher binding are two
  independent layers catching the same mistake. The canonical-UUID rule
  exists because a second spelling of the same id would derive a different
  key and strand every row.
- **Colons banned in every purpose.** A system purpose containing `:` is the
  only way to spell one that starts with `user:` and so shares a user's
  domain. One rule in both stores makes the two key spaces disjoint. No
  existing system purpose (`smtp`, `storage`, `push_vapid`, `ai`) had one.
- **A sibling table, not `ownerId` on `Credential`.** `Credential` has a
  table-wide `@@unique([purpose, name])`. Postgres treats `NULL`s as distinct,
  so `@@unique([ownerId, purpose, name])` would stop enforcing one system row
  per address. The two tables also need opposite delete behaviour
  (`SetNull` provenance vs `Cascade` ownership), which one column cannot carry.
- **Not the owner encoded in `name`.** The system store derives its key from
  `purpose` alone, so every user's row of a purpose would share one key. It
  also gives Prisma no relation to cascade on.
- **Not a JSONB blob in `user_settings`.** Settings endpoints return that
  document whole; a secret inside it is one careless response from exposure.
- **No `fallbackToSystem` flag.** A flag that decides whose key pays is a knob
  that gets flipped under pressure, invisibly to callers. A purpose that must
  never fall back declares `system: null`.
- **Decrypt failures throw.** "Cannot read" must never look like "not
  configured", or the resolver would hide the fault by falling back.
- **Registry ships empty.** Declaring `'ai'` would create a second store for
  the AI key, with two resolvers that could disagree. Migrating
  `user_ai_keys` here would have to carry its reachability bookkeeping.
- **No controller.** Store first; the controller belongs to the feature,
  which knows its actor, permission and audit semantics.

## 7. Verification

```bash
cd apps/api
npm test -- user-credential credential-internals secret-cipher
```

Expect the suites in §5 to pass. There is nothing to exercise over HTTP
until a feature declares a purpose and adds its own routes.

## History

- #115 (epic #108) added `CredentialsService`, the deployment-owned store.
- #387 added `user_credentials`, the owner-bound cipher domain,
  `UserCredentialsService`, the purpose registry and the resolver, and
  extended the colon ban to system purposes.
- #431 (epic #419) kept AI provider keys in their own `user_ai_keys` table.
