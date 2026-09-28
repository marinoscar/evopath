import type { SystemStorageValue } from '../../common/schemas/settings.schema';
import {
  R2_DEFAULT_REGION,
  R2_ENDPOINT_HOST_SUFFIX,
  S3_COMPATIBLE_DEFAULT_REGION,
  deriveR2Endpoint,
  describeStorageConfig,
  fingerprintStorageConfig,
  resolveStorageConfig,
  type ResolvedStorageConfig,
} from './storage-config';

// =============================================================================
// storage-config.ts — tests (issue #373, epic #372)
// =============================================================================
//
// Pure functions, no mocking. `resolveStorageConfig` is the single definition
// of "configured" — the provider that builds an `S3Client`, the 503 an
// unconfigured deployment returns, and the connection test all ask this
// same function, so the per-provider requirement list and the "every missing
// field, not just the first" contract are pinned exactly, field order and all.
// =============================================================================

function policy(overrides: Partial<SystemStorageValue> = {}): SystemStorageValue {
  return {
    provider: 's3',
    bucket: 'my-bucket',
    region: 'us-west-2',
    endpoint: '',
    accountId: '',
    accessKeyId: 'AKIAEXAMPLE',
    // The shipped default: "use this vendor's convention", not `false`. The
    // factory mirrors `DEFAULT_SYSTEM_SETTINGS` so a test that says nothing
    // about path style is testing the configuration an operator actually gets.
    forcePathStyle: null,
    ...overrides,
  };
}

const SECRET = 'super-secret-access-key-value';

function resolvedConfig(
  overrides: Partial<ResolvedStorageConfig> = {},
): ResolvedStorageConfig {
  return {
    provider: 's3',
    bucket: 'my-bucket',
    region: 'us-west-2',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: SECRET,
    forcePathStyle: null,
    ...overrides,
  };
}

describe('resolveStorageConfig', () => {
  // ===========================================================================
  // Requirements shared by every provider
  // ===========================================================================

  it('requires a bucket for every provider', () => {
    const result = resolveStorageConfig(policy({ bucket: '' }), SECRET);

    expect(result).toEqual({
      configured: false,
      provider: 's3',
      missing: ['bucket'],
    });
  });

  it('requires an access key id for every provider', () => {
    const result = resolveStorageConfig(policy({ accessKeyId: '' }), SECRET);

    expect(result).toEqual({
      configured: false,
      provider: 's3',
      missing: ['accessKeyId'],
    });
  });

  it('requires a secret access key for every provider (null: no row saved)', () => {
    const result = resolveStorageConfig(policy(), null);

    expect(result).toEqual({
      configured: false,
      provider: 's3',
      missing: ['secretAccessKey'],
    });
  });

  it('treats an empty-string secret exactly like a null one', () => {
    const result = resolveStorageConfig(policy(), '');

    expect(result).toEqual({
      configured: false,
      provider: 's3',
      missing: ['secretAccessKey'],
    });
  });

  it('treats a whitespace-only bucket as not configured (the schema already trims)', () => {
    // The schema stores '' for whitespace input; a caller handing this
    // function a raw '' (rather than a space) is what "never filled in" and
    // "cleared" both look like from here.
    const result = resolveStorageConfig(policy({ bucket: '' }), SECRET);

    expect(result.configured).toBe(false);
  });

  // ===========================================================================
  // Every missing field is reported, not just the first
  // ===========================================================================

  it('reports every missing field for s3, in form order', () => {
    const result = resolveStorageConfig(
      policy({ provider: 's3', bucket: '', region: '', accessKeyId: '' }),
      null,
    );

    expect(result).toEqual({
      configured: false,
      provider: 's3',
      missing: ['bucket', 'region', 'accessKeyId', 'secretAccessKey'],
    });
  });

  it('reports every missing field for r2, in form order', () => {
    const result = resolveStorageConfig(
      policy({
        provider: 'r2',
        bucket: '',
        accountId: '',
        endpoint: '',
        accessKeyId: '',
      }),
      null,
    );

    expect(result).toEqual({
      configured: false,
      provider: 'r2',
      missing: ['bucket', 'accountId', 'accessKeyId', 'secretAccessKey'],
    });
  });

  it('reports every missing field for s3compatible, in form order', () => {
    const result = resolveStorageConfig(
      policy({
        provider: 's3compatible',
        bucket: '',
        endpoint: '',
        accessKeyId: '',
      }),
      null,
    );

    expect(result).toEqual({
      configured: false,
      provider: 's3compatible',
      missing: ['bucket', 'endpoint', 'accessKeyId', 'secretAccessKey'],
    });
  });

  // ===========================================================================
  // Per-provider requirement
  // ===========================================================================

  describe('s3', () => {
    it('requires region', () => {
      const result = resolveStorageConfig(
        policy({ provider: 's3', region: '' }),
        SECRET,
      );

      expect(result).toEqual({
        configured: false,
        provider: 's3',
        missing: ['region'],
      });
    });

    it('does not require endpoint or accountId', () => {
      const result = resolveStorageConfig(
        policy({ provider: 's3', endpoint: '', accountId: '' }),
        SECRET,
      );

      expect(result.configured).toBe(true);
    });

    it('is configured with just bucket, region, accessKeyId and secret', () => {
      const result = resolveStorageConfig(
        policy({ provider: 's3', bucket: 'b', region: 'eu-west-1', accessKeyId: 'AK' }),
        SECRET,
      );

      expect(result).toEqual({
        configured: true,
        config: {
          provider: 's3',
          bucket: 'b',
          region: 'eu-west-1',
          accessKeyId: 'AK',
          secretAccessKey: SECRET,
          forcePathStyle: null,
        },
      });
    });
  });

  describe('r2', () => {
    it('requires accountId when no explicit endpoint was typed', () => {
      const result = resolveStorageConfig(
        policy({ provider: 'r2', accountId: '', endpoint: '' }),
        SECRET,
      );

      expect(result).toEqual({
        configured: false,
        provider: 'r2',
        missing: ['accountId'],
      });
    });

    it('does NOT require accountId when an explicit endpoint was typed', () => {
      const result = resolveStorageConfig(
        policy({
          provider: 'r2',
          accountId: '',
          endpoint: 'https://custom.example.com',
        }),
        SECRET,
      );

      expect(result.configured).toBe(true);
    });

    it('does not require region (falls back to auto)', () => {
      const result = resolveStorageConfig(
        policy({ provider: 'r2', accountId: 'acct-1', region: '' }),
        SECRET,
      );

      expect(result.configured).toBe(true);
      if (result.configured) {
        expect(result.config.region).toBe(R2_DEFAULT_REGION);
      }
    });
  });

  describe('s3compatible', () => {
    it('requires endpoint', () => {
      const result = resolveStorageConfig(
        policy({ provider: 's3compatible', endpoint: '' }),
        SECRET,
      );

      expect(result).toEqual({
        configured: false,
        provider: 's3compatible',
        missing: ['endpoint'],
      });
    });

    it('does not require accountId', () => {
      const result = resolveStorageConfig(
        policy({
          provider: 's3compatible',
          endpoint: 'https://minio.internal:9000',
          accountId: '',
        }),
        SECRET,
      );

      expect(result.configured).toBe(true);
    });
  });

  // ===========================================================================
  // Region fallbacks
  // ===========================================================================

  it('falls back region to "auto" for r2 when the operator left it empty', () => {
    const result = resolveStorageConfig(
      policy({ provider: 'r2', accountId: 'acct-1', region: '' }),
      SECRET,
    );

    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(result.config.region).toBe('auto');
      expect(result.config.region).toBe(R2_DEFAULT_REGION);
    }
  });

  it('falls back region to "us-east-1" for s3compatible when the operator left it empty', () => {
    const result = resolveStorageConfig(
      policy({
        provider: 's3compatible',
        endpoint: 'https://minio.internal:9000',
        region: '',
      }),
      SECRET,
    );

    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(result.config.region).toBe('us-east-1');
      expect(result.config.region).toBe(S3_COMPATIBLE_DEFAULT_REGION);
    }
  });

  it('does NOT fall back region for s3 (an empty region is a missing field instead)', () => {
    const result = resolveStorageConfig(
      policy({ provider: 's3', region: '' }),
      SECRET,
    );

    expect(result).toEqual({
      configured: false,
      provider: 's3',
      missing: ['region'],
    });
  });

  it('a region an operator typed always wins over the fallback (r2)', () => {
    const result = resolveStorageConfig(
      policy({ provider: 'r2', accountId: 'acct-1', region: 'eu' }),
      SECRET,
    );

    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(result.config.region).toBe('eu');
    }
  });

  // ===========================================================================
  // Endpoint precedence: explicit always wins
  // ===========================================================================

  it('derives the R2 endpoint from accountId when none was typed', () => {
    const result = resolveStorageConfig(
      policy({ provider: 'r2', accountId: 'my-account', endpoint: '' }),
      SECRET,
    );

    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(result.config.endpoint).toBe(
        `https://my-account.${R2_ENDPOINT_HOST_SUFFIX}`,
      );
    }
  });

  it('an explicitly typed endpoint always wins over the derived R2 one', () => {
    const result = resolveStorageConfig(
      policy({
        provider: 'r2',
        accountId: 'my-account',
        endpoint: 'https://typed-over-derived.example.com',
      }),
      SECRET,
    );

    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(result.config.endpoint).toBe(
        'https://typed-over-derived.example.com',
      );
    }
  });

  it('leaves endpoint absent (not empty-string) for plain s3 with none typed', () => {
    const result = resolveStorageConfig(
      policy({ provider: 's3', endpoint: '' }),
      SECRET,
    );

    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(result.config.endpoint).toBeUndefined();
      expect('endpoint' in result.config).toBe(false);
    }
  });

  it('passes an explicit s3 endpoint through untouched (pointing s3 at local MinIO)', () => {
    const result = resolveStorageConfig(
      policy({ provider: 's3', endpoint: 'http://localhost:9000' }),
      SECRET,
    );

    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(result.config.endpoint).toBe('http://localhost:9000');
    }
  });

  // ===========================================================================
  // forcePathStyle is TRI-STATE, and this function decides none of it (#374)
  // ===========================================================================
  //
  // `null` means "use this vendor's convention" and MUST survive to the driver,
  // because `buildS3ClientConfig` (storage/providers/s3) holds the one copy of
  // the convention table: path style for `s3compatible`, virtual-host style for
  // `s3` and `r2`. Collapsing `null` to a boolean here — or storing `false` as
  // the default, which is the same thing one layer up — is exactly what made
  // the driver's `?? provider === 's3compatible'` unreachable in production and
  // broke MinIO. The EFFECTIVE value each of these resolves to is asserted end
  // to end, through this same function, in
  // `storage/providers/s3/s3-storage.provider.spec.ts`; what is pinned here is
  // that this function adds nothing and removes nothing.

  describe('forcePathStyle', () => {
    function resolvedForcePathStyle(
      overrides: Partial<SystemStorageValue>,
    ): boolean | null {
      const result = resolveStorageConfig(policy(overrides), SECRET);

      expect(result.configured).toBe(true);
      if (!result.configured) {
        throw new Error('fixture is not a usable configuration');
      }

      return result.config.forcePathStyle;
    }

    it('carries the unset default through for s3compatible (→ path style)', () => {
      expect(
        resolvedForcePathStyle({
          provider: 's3compatible',
          endpoint: 'https://minio.internal:9000',
          forcePathStyle: null,
        }),
      ).toBeNull();
    });

    it('carries the unset default through for s3 (→ virtual-host style)', () => {
      expect(
        resolvedForcePathStyle({ provider: 's3', forcePathStyle: null }),
      ).toBeNull();
    });

    it('carries the unset default through for r2 (→ virtual-host style)', () => {
      expect(
        resolvedForcePathStyle({
          provider: 'r2',
          region: 'auto',
          accountId: 'abc123def456',
          forcePathStyle: null,
        }),
      ).toBeNull();
    });

    it('passes an explicit false through, even for s3compatible', () => {
      // An operator turning path style OFF for an appliance that serves
      // virtual-host style. A `||` anywhere on this path would lose it.
      expect(
        resolvedForcePathStyle({
          provider: 's3compatible',
          endpoint: 'https://minio.internal:9000',
          forcePathStyle: false,
        }),
      ).toBe(false);
    });

    it('passes an explicit true through, even for s3', () => {
      expect(
        resolvedForcePathStyle({ provider: 's3', forcePathStyle: true }),
      ).toBe(true);
    });
  });
});

describe('deriveR2Endpoint', () => {
  it('builds the account-scoped R2 origin', () => {
    expect(deriveR2Endpoint('abc123')).toBe(
      'https://abc123.r2.cloudflarestorage.com',
    );
  });

  it('never includes a bucket path segment after the account host', () => {
    // The bucket is addressed in the path/subdomain by the S3 client, not
    // baked into this host string.
    expect(deriveR2Endpoint('abc123')).toBe(
      `https://abc123.${R2_ENDPOINT_HOST_SUFFIX}`,
    );
    expect(deriveR2Endpoint('abc123').endsWith('/')).toBe(false);
  });
});

describe('fingerprintStorageConfig', () => {
  it('produces the same fingerprint for the same configuration', () => {
    const a = fingerprintStorageConfig(resolvedConfig());
    const b = fingerprintStorageConfig(resolvedConfig());

    expect(a).toBe(b);
  });

  it('produces a different fingerprint when the secret changes', () => {
    const original = fingerprintStorageConfig(
      resolvedConfig({ secretAccessKey: 'first-secret' }),
    );
    const rotated = fingerprintStorageConfig(
      resolvedConfig({ secretAccessKey: 'second-secret' }),
    );

    expect(rotated).not.toBe(original);
  });

  it('produces a different fingerprint when a non-secret field changes', () => {
    const a = fingerprintStorageConfig(resolvedConfig({ bucket: 'bucket-a' }));
    const b = fingerprintStorageConfig(resolvedConfig({ bucket: 'bucket-b' }));

    expect(a).not.toBe(b);
  });

  it('is not the plaintext secret, and is a sha256 hex digest', () => {
    const fingerprint = fingerprintStorageConfig(resolvedConfig());

    expect(fingerprint).not.toBe(SECRET);
    expect(fingerprint).not.toContain(SECRET);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('describeStorageConfig', () => {
  it('never includes the secret access key', () => {
    const description = describeStorageConfig(
      resolvedConfig({ secretAccessKey: 'TOTALLY-SECRET-VALUE' }),
    );

    expect(description).not.toContain('TOTALLY-SECRET-VALUE');
  });

  it('describes an AWS-hosted s3 config by region, not endpoint', () => {
    const description = describeStorageConfig(
      resolvedConfig({
        provider: 's3',
        bucket: 'my-bucket',
        region: 'us-west-2',
        accessKeyId: 'AKIAEXAMPLE',
      }),
    );

    expect(description).toBe(
      's3 bucket=my-bucket at=us-west-2 (AWS) keyId=AKIAEXAMPLE',
    );
  });

  it('describes an endpoint-addressed config by its endpoint', () => {
    const description = describeStorageConfig(
      resolvedConfig({
        provider: 'r2',
        bucket: 'my-bucket',
        region: 'auto',
        endpoint: 'https://abc123.r2.cloudflarestorage.com',
        accessKeyId: 'AKIAEXAMPLE',
      }),
    );

    expect(description).toBe(
      'r2 bucket=my-bucket at=https://abc123.r2.cloudflarestorage.com keyId=AKIAEXAMPLE',
    );
  });

  it('includes the access key id (an identifier, not a secret)', () => {
    const description = describeStorageConfig(
      resolvedConfig({ accessKeyId: 'AKIA-IDENTIFIABLE' }),
    );

    expect(description).toContain('keyId=AKIA-IDENTIFIABLE');
  });
});
