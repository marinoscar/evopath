import {
  MEMORY_USER_DEFAULTS,
  memorySettingsPatchSchema,
  memorySettingsSchema,
  resolveMemoryUserSettings,
} from './user-settings-namespaces.schema';
import {
  systemMemoryPatchSchema,
  systemMemorySchema,
  userSettingsSchema,
} from './settings.schema';
import { DEFAULT_SYSTEM_SETTINGS } from '../types/settings.types';

// The `memory` user namespace and the `memory` system setting (#325).

describe('memory user settings namespace', () => {
  it('accepts an empty object and every field', () => {
    expect(memorySettingsSchema.parse({})).toEqual({});
    expect(() =>
      memorySettingsSchema.parse({
        enabled: false,
        autoExtract: false,
        allowHealth: false,
        disclosureSeenAt: '2026-10-01T00:00:00.000Z',
      }),
    ).not.toThrow();
    expect(() => memorySettingsSchema.parse({ disclosureSeenAt: null })).not.toThrow();
  });

  it.each([
    [{ lastExtractedAt: '2026-10-01T00:00:00.000Z' }],
    [{ extractionsToday: 1 }],
    [{ enabled: 'yes' }],
    [{ disclosureSeenAt: 'yesterday' }],
    [{ surprise: true }],
  ])('rejects %j (strict, server-managed state is not client-writable)', (value) => {
    expect(memorySettingsSchema.safeParse(value).success).toBe(false);
    expect(memorySettingsPatchSchema.safeParse(value).success).toBe(false);
  });

  it('the PATCH form accepts null per field', () => {
    expect(() =>
      memorySettingsPatchSchema.parse({ enabled: null, autoExtract: null, allowHealth: null, disclosureSeenAt: null }),
    ).not.toThrow();
  });

  it('resolves absent fields to the defaults and keeps stored values', () => {
    expect(resolveMemoryUserSettings(undefined)).toEqual(MEMORY_USER_DEFAULTS);
    expect(MEMORY_USER_DEFAULTS).toEqual({ enabled: true, autoExtract: true, allowHealth: true, disclosureSeenAt: null });
    expect(resolveMemoryUserSettings({ autoExtract: false })).toEqual({ ...MEMORY_USER_DEFAULTS, autoExtract: false });
  });

  it('is part of the stored user settings schema', () => {
    const base = { theme: 'system', profile: { imageSource: 'none', imageObjectId: null } };
    expect(userSettingsSchema.parse({ ...base, memory: { enabled: false } }).memory).toEqual({ enabled: false });
  });
});

describe('memory system setting', () => {
  it('the defaults satisfy the schema', () => {
    expect(systemMemorySchema.parse(DEFAULT_SYSTEM_SETTINGS.memory)).toEqual({
      enabled: true,
      autoExtract: true,
      maxPerUser: 200,
      extractDailyCapPerUser: 20,
      purgeAfterDays: 30,
    });
  });

  it.each([
    [{ maxPerUser: 49 }],
    [{ maxPerUser: 501 }],
    [{ extractDailyCapPerUser: 0 }],
    [{ purgeAfterDays: 0 }],
    [{ purgeAfterDays: 1.5 }],
  ])('rejects %j', (patch) => {
    expect(systemMemoryPatchSchema.safeParse(patch).success).toBe(false);
    expect(systemMemorySchema.safeParse({ ...DEFAULT_SYSTEM_SETTINGS.memory, ...patch }).success).toBe(false);
  });

  it('accepts the bounds', () => {
    expect(systemMemoryPatchSchema.safeParse({ maxPerUser: 50 }).success).toBe(true);
    expect(systemMemoryPatchSchema.safeParse({ maxPerUser: 500 }).success).toBe(true);
  });
});
