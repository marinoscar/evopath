import {
  ASSET_LINKS_RELATION,
  buildAssetLinks,
  trustedAndroidAppsSchema,
} from './android-app.schema';
import { updateAndroidAppSchema } from './dto/android-app.dto';

const SHA_A = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');
const SHA_B = Array.from({ length: 32 }, () => 'AB').join(':');

describe('trusted Android apps schema', () => {
  it('normalises a lowercase fingerprint to uppercase and trims both fields', () => {
    const parsed = trustedAndroidAppsSchema.parse([
      { packageName: '  com.example.app ', sha256: ` ${SHA_A.toLowerCase()} ` },
    ]);

    expect(parsed).toEqual([{ packageName: 'com.example.app', sha256: SHA_A }]);
  });

  it('drops repeated pairs, including ones that differ only in fingerprint case, keeping order', () => {
    const parsed = trustedAndroidAppsSchema.parse([
      { packageName: 'com.example.app', sha256: SHA_A },
      { packageName: 'com.example.app.debug', sha256: SHA_B },
      { packageName: 'com.example.app', sha256: SHA_A.toLowerCase() },
    ]);

    expect(parsed).toEqual([
      { packageName: 'com.example.app', sha256: SHA_A },
      { packageName: 'com.example.app.debug', sha256: SHA_B },
    ]);
  });

  it('accepts an empty list', () => {
    expect(trustedAndroidAppsSchema.parse([])).toEqual([]);
  });

  it.each([
    ['a single segment', 'app'],
    ['a segment starting with a digit', 'com.1example.app'],
    ['a hyphen', 'com.my-app'],
    ['a trailing dot', 'com.example.'],
    ['an empty string', ''],
  ])('rejects a package name with %s', (_label, packageName) => {
    expect(trustedAndroidAppsSchema.safeParse([{ packageName, sha256: SHA_A }]).success).toBe(false);
  });

  it.each([
    ['31 bytes', SHA_A.slice(3)],
    ['no colons', SHA_A.replace(/:/g, '')],
    ['a non-hex byte', SHA_A.replace(/^00/, 'ZZ')],
    ['a SHA-1 fingerprint', Array.from({ length: 20 }, () => 'AA').join(':')],
  ])('rejects a fingerprint with %s', (_label, sha256) => {
    expect(trustedAndroidAppsSchema.safeParse([{ packageName: 'com.example.app', sha256 }]).success).toBe(false);
  });

  it('rejects more than ten apps', () => {
    const apps = Array.from({ length: 11 }, (_, i) => ({ packageName: `com.example.app${i}`, sha256: SHA_A }));

    expect(trustedAndroidAppsSchema.safeParse(apps).success).toBe(false);
    expect(trustedAndroidAppsSchema.safeParse(apps.slice(0, 10)).success).toBe(true);
  });

  it('requires trustedApps in the PUT body', () => {
    expect(updateAndroidAppSchema.safeParse({}).success).toBe(false);
    expect(updateAndroidAppSchema.parse({ trustedApps: [] })).toEqual({ trustedApps: [] });
  });
});

describe('buildAssetLinks', () => {
  it('is an empty array when nothing is trusted', () => {
    expect(buildAssetLinks([])).toEqual([]);
  });

  it('emits one statement per package, grouping its fingerprints in listed order', () => {
    const statements = buildAssetLinks([
      { packageName: 'com.example.app', sha256: SHA_A },
      { packageName: 'com.example.app.debug', sha256: SHA_A },
      { packageName: 'com.example.app', sha256: SHA_B },
    ]);

    expect(statements).toEqual([
      {
        relation: [ASSET_LINKS_RELATION],
        target: {
          namespace: 'android_app',
          package_name: 'com.example.app',
          sha256_cert_fingerprints: [SHA_A, SHA_B],
        },
      },
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.example.app.debug',
          sha256_cert_fingerprints: [SHA_A],
        },
      },
    ]);
  });

  it('never repeats a fingerprint within a statement', () => {
    const [statement] = buildAssetLinks([
      { packageName: 'com.example.app', sha256: SHA_A },
      { packageName: 'com.example.app', sha256: SHA_A.toLowerCase() },
    ]);

    expect(statement.target.sha256_cert_fingerprints).toEqual([SHA_A]);
  });
});
