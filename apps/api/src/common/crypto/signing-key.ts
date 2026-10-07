// eject: seam request to file in marinoscar/EnterpriseAppBase ("export deriveSigningKey from
// @marinoscar/platform-api/core"); recorded under Local exceptions in docs/platform-adoption/README.md.
// =============================================================================
// Signing sub-keys from SECRETS_ENCRYPTION_KEY (issue #285)
// =============================================================================
//
// A LOCAL SHIM. The secret cipher moved to `@marinoscar/platform-api/core`
// (marinoscar/EnterpriseAppBase#698), but the package does not export
// `deriveSigningKey`, which this app added to its copy for the Android APK
// download links. Until the package has the seam, this file keeps exactly the
// derivation the copy had, and is deleted (with its ledger row) in the PR that
// adopts it.
//
// THE LABEL NEVER CHANGES. `enterpriseappbase:signing-key:v1:` is part of every
// derived key: a different label invalidates every outstanding download token.
// It is distinct from the cipher's encryption label
// (`enterpriseappbase:secret-cipher:v1:`) at a fixed position, so no signing
// purpose can ever produce an encryption sub-key or the reverse.
//
// THE MASTER KEY is validated by the package (`assertEncryptionKeyConfigured`,
// the same checks and message as before: set, base64, 32 bytes), then decoded
// here and cached for the process, as the copy cached it.
// =============================================================================

import { createHmac } from 'node:crypto';

import { assertEncryptionKeyConfigured } from '@marinoscar/platform-api/core';

const KEY_ENV_VAR = 'SECRETS_ENCRYPTION_KEY';

/** Fixed label prefix for MAC (signing) sub-keys. Never change it. */
const SIGNING_SUBKEY_LABEL_PREFIX = 'enterpriseappbase:signing-key:v1:';

let cachedMasterKey: Buffer | null = null;
const signingKeyCache = new Map<string, Buffer>();

function masterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;
  // Throws the package's configuration error (naming the variable, never the value).
  assertEncryptionKeyConfigured();
  cachedMasterKey = Buffer.from((process.env[KEY_ENV_VAR] ?? '').trim(), 'base64');
  return cachedMasterKey;
}

/**
 * A 32-byte HMAC key for `purpose`, derived from `SECRETS_ENCRYPTION_KEY`
 * (issue #285: the Android APK download links). For server-signed, short-lived
 * tokens that need a deployment secret without a new environment variable:
 * the master key is already mandatory and verified at startup, and the label
 * keeps every signing domain independent of every encryption domain.
 *
 * `purpose` is a code constant (`android-app-download`), never user input, so
 * the cache cannot grow unboundedly. Rotating the master key invalidates every
 * outstanding token, which for minutes-long tokens is the desired behaviour.
 *
 * @throws if the key is missing/malformed, or `purpose` is empty.
 */
export function deriveSigningKey(purpose: string): Buffer {
  if (typeof purpose !== 'string' || purpose.length === 0) {
    throw new Error('deriveSigningKey requires a non-empty purpose string.');
  }

  const cached = signingKeyCache.get(purpose);
  if (cached) return cached;

  const derived = createHmac('sha256', masterKey())
    .update(`${SIGNING_SUBKEY_LABEL_PREFIX}${purpose}`)
    .digest();
  signingKeyCache.set(purpose, derived);
  return derived;
}
