import { releaseUploadFieldsSchema, signingSha256Schema, versionRuleRefusal } from './android-release.schema';

const SHA = Array.from({ length: 32 }, () => 'AB').join(':');

const VALID = {
  packageName: 'com.evopath.android',
  versionName: '0.2.0',
  versionCode: '7',
  signingSha256: SHA,
};

describe('release upload fields', () => {
  it('coerces the multipart strings and applies the defaults', () => {
    expect(releaseUploadFieldsSchema.parse(VALID)).toEqual({
      packageName: 'com.evopath.android',
      versionName: '0.2.0',
      versionCode: 7,
      signingSha256: SHA,
      notes: null,
      makeCurrent: true,
      force: false,
    });
  });

  it('reads makeCurrent and force from "true"/"false"/"1"/"0"', () => {
    expect(releaseUploadFieldsSchema.parse({ ...VALID, makeCurrent: 'false', force: '1' })).toMatchObject({
      makeCurrent: false,
      force: true,
    });
    expect(releaseUploadFieldsSchema.safeParse({ ...VALID, makeCurrent: 'yes' }).success).toBe(false);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['a fraction', '1.5'],
    ['above Android\'s ceiling', '2100000001'],
    ['not a number', 'seven'],
  ])('rejects a versionCode that is %s', (_label, versionCode) => {
    expect(releaseUploadFieldsSchema.safeParse({ ...VALID, versionCode }).success).toBe(false);
  });

  it('accepts versionCode at both bounds', () => {
    expect(releaseUploadFieldsSchema.safeParse({ ...VALID, versionCode: '1' }).success).toBe(true);
    expect(releaseUploadFieldsSchema.safeParse({ ...VALID, versionCode: '2100000000' }).success).toBe(true);
  });

  it.each([
    ['a slash', '1.0/../x'],
    ['a quote', '1.0"'],
    ['a space', '1 0'],
    ['51 characters', 'a'.repeat(51)],
    ['an empty string', ''],
  ])('rejects a versionName with %s (it becomes a file name)', (_label, versionName) => {
    expect(releaseUploadFieldsSchema.safeParse({ ...VALID, versionName }).success).toBe(false);
  });

  it('rejects notes over 2000 characters and unknown fields', () => {
    expect(releaseUploadFieldsSchema.safeParse({ ...VALID, notes: 'x'.repeat(2001) }).success).toBe(false);
    expect(releaseUploadFieldsSchema.safeParse({ ...VALID, extra: '1' }).success).toBe(false);
  });

  it('normalises a 64-hex or lowercase fingerprint to the uppercase colon form', () => {
    expect(signingSha256Schema.parse('ab'.repeat(32))).toBe(SHA);
    expect(signingSha256Schema.parse(SHA.toLowerCase())).toBe(SHA);
    expect(signingSha256Schema.safeParse('ab'.repeat(20)).success).toBe(false);
  });
});

describe('versionRuleRefusal', () => {
  const current = { packageName: 'com.evopath.android', versionCode: 5 };

  it('allows anything when nothing is current', () => {
    expect(versionRuleRefusal(null, { packageName: 'com.evopath.android', versionCode: 1 }, false)).toBeNull();
  });

  it('allows a strictly higher versionCode of the same package', () => {
    expect(versionRuleRefusal(current, { packageName: 'com.evopath.android', versionCode: 6 }, false)).toBeNull();
  });

  it('refuses an equal or lower versionCode of the same package', () => {
    expect(versionRuleRefusal(current, { packageName: 'com.evopath.android', versionCode: 5 }, false)).toBe(
      'RELEASE_VERSION_NOT_NEWER',
    );
    expect(versionRuleRefusal(current, { packageName: 'com.evopath.android', versionCode: 4 }, false)).toBe(
      'RELEASE_VERSION_NOT_NEWER',
    );
  });

  it('lets force override the refusal', () => {
    expect(versionRuleRefusal(current, { packageName: 'com.evopath.android', versionCode: 4 }, true)).toBeNull();
  });

  it('does not compare across packages', () => {
    expect(versionRuleRefusal(current, { packageName: 'com.evopath.android.debug', versionCode: 1 }, false)).toBeNull();
  });
});
