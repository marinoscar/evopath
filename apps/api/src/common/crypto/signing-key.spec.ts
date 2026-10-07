import { randomBytes } from 'node:crypto';

// =============================================================================
// deriveSigningKey (issue #285), the local shim over @marinoscar/platform-api/core
// =============================================================================
//
// Moved from the deleted `secret-cipher.spec.ts`. Like the cipher, the shim
// caches the master key for the process, so every case loads a fresh module
// instance (`jest.resetModules()` + `require`) after setting the variable.
// The golden value pins the derivation, label included: a change to it would
// invalidate every outstanding Android download token.
// =============================================================================

type SigningKeyModule = typeof import('./signing-key');

const ENV_VAR = 'SECRETS_ENCRYPTION_KEY';

/** A deterministic, valid 32-byte key (base64-encoded). */
const VALID_KEY = Buffer.alloc(32, 7).toString('base64');

/**
 * HMAC-SHA256(VALID_KEY, 'enterpriseappbase:signing-key:v1:android-app-download'),
 * as the pre-package `common/crypto/secret-cipher.ts` derived it.
 */
const GOLDEN_ANDROID_DOWNLOAD_KEY = 'cd0471fc5d3af6a61ad34239138ada62d63d0825e8e7f0618be56d4fb60e8950';

function load(key: string | undefined): SigningKeyModule {
  if (key === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = key;
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./signing-key') as SigningKeyModule;
}

describe('deriveSigningKey (#285)', () => {
  const original = process.env[ENV_VAR];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = original;
    jest.resetModules();
  });

  it('derives exactly the key the pre-package cipher derived (same label)', () => {
    expect(load(VALID_KEY).deriveSigningKey('android-app-download').toString('hex')).toBe(GOLDEN_ANDROID_DOWNLOAD_KEY);
    // Whitespace around the variable is absorbed, as the cipher absorbs it.
    expect(load(` ${VALID_KEY}\n`).deriveSigningKey('android-app-download').toString('hex')).toBe(
      GOLDEN_ANDROID_DOWNLOAD_KEY,
    );
  });

  it('is a stable 32-byte key per purpose, distinct across purposes and keys', () => {
    const first = load(VALID_KEY);
    const a = first.deriveSigningKey('android-app-download');

    expect(a).toHaveLength(32);
    expect(first.deriveSigningKey('android-app-download').equals(a)).toBe(true);
    expect(first.deriveSigningKey('other-purpose').equals(a)).toBe(false);

    const second = load(randomBytes(32).toString('base64'));
    expect(second.deriveSigningKey('android-app-download').equals(a)).toBe(false);
  });

  it('refuses an empty purpose and a missing or malformed master key', () => {
    expect(() => load(VALID_KEY).deriveSigningKey('')).toThrow();
    expect(() => load(undefined).deriveSigningKey('android-app-download')).toThrow(/SECRETS_ENCRYPTION_KEY/);
    expect(() => load('not base64 !').deriveSigningKey('android-app-download')).toThrow(/SECRETS_ENCRYPTION_KEY/);
    expect(() => load(Buffer.alloc(16, 1).toString('base64')).deriveSigningKey('android-app-download')).toThrow(
      /SECRETS_ENCRYPTION_KEY/,
    );
  });
});
