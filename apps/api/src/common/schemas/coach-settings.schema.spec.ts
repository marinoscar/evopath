import {
  COACH_USER_DEFAULTS,
  coachSettingsPatchSchema,
  coachSettingsSchema,
  resolveCoachUserSettings,
} from './user-settings-namespaces.schema';
import {
  systemCoachPatchSchema,
  systemCoachSchema,
  userSettingsSchema,
} from './settings.schema';
import { DEFAULT_SYSTEM_SETTINGS } from '../types/settings.types';

// The `coach` user namespace and the `coach` system setting (E7.1, #241;
// docs/specs/ai-coach.md §3.1 and §3.2): bounds, strictness, and the sparse
// absent-means-default contract.

describe('coach user settings namespace', () => {
  it('accepts an empty object and every field at its bounds', () => {
    expect(coachSettingsSchema.parse({})).toEqual({});
    expect(() =>
      coachSettingsSchema.parse({
        enabled: true,
        personaId: 'drill_sergeant',
        intensity: 3,
        profanity: false,
        adultConfirmedAt: '2026-10-01T00:00:00.000Z',
        audio: { enabled: true, voice: 'alloy', speed: 1.5 },
        quietHours: { start: '21:30', end: '07:30' },
        maxNudgesPerDay: 4,
        lockScreenSafe: true,
        photoCadence: 'monthly',
        why: 'x'.repeat(200),
        preferredTime: '06:45',
      }),
    ).not.toThrow();
    expect(() => coachSettingsSchema.parse({ intensity: 1, maxNudgesPerDay: 1, audio: { speed: 0.75 } })).not.toThrow();
  });

  it.each([
    ['intensity 4', { intensity: 4 }],
    ['intensity 0', { intensity: 0 }],
    ['fractional intensity', { intensity: 2.5 }],
    ['maxNudgesPerDay 5', { maxNudgesPerDay: 5 }],
    ['maxNudgesPerDay 0', { maxNudgesPerDay: 0 }],
    ['audio speed below 0.75', { audio: { speed: 0.5 } }],
    ['audio speed above 1.5', { audio: { speed: 2 } }],
    ['quiet hours not HH:mm', { quietHours: { start: '9:30' } }],
    ['quiet hours 24:00', { quietHours: { end: '24:00' } }],
    ['preferredTime not HH:mm', { preferredTime: '7am' }],
    ['unknown photo cadence', { photoCadence: 'daily' }],
    ['why over 200 characters', { why: 'x'.repeat(201) }],
    ['adultConfirmedAt not a datetime', { adultConfirmedAt: 'yesterday' }],
    ['persona id not a slug', { personaId: 'Drill Sergeant' }],
    ['unknown key', { mood: 'grumpy' }],
    ['unknown key inside audio', { audio: { volume: 11 } }],
    ['unknown key inside quietHours', { quietHours: { timezone: 'UTC' } }],
  ])('rejects %s', (_label, value) => {
    expect(coachSettingsSchema.safeParse(value).success).toBe(false);
    expect(coachSettingsPatchSchema.safeParse(value).success).toBe(false);
  });

  it('PATCH accepts null to clear a field, nested field or nested object', () => {
    expect(
      coachSettingsPatchSchema.parse({ why: null, audio: { voice: null }, quietHours: null, intensity: null }),
    ).toEqual({ why: null, audio: { voice: null }, quietHours: null, intensity: null });
  });

  it('is optional in user settings and never defaulted when absent', () => {
    const parsed = userSettingsSchema.parse({ theme: 'system', profile: { imageSource: 'none' } });

    expect('coach' in parsed).toBe(false);
  });

  it('rejects an out-of-range value through the full user settings schema', () => {
    expect(
      userSettingsSchema.safeParse({ theme: 'system', profile: { imageSource: 'none' }, coach: { intensity: 4 } }).success,
    ).toBe(false);
  });

  it('resolves an absent namespace to the spec defaults', () => {
    expect(resolveCoachUserSettings(undefined)).toEqual({
      enabled: false,
      personaId: 'coach',
      intensity: 2,
      profanity: false,
      adultConfirmedAt: null,
      audio: { enabled: false, voice: null, speed: 1.0 },
      quietHours: { start: '21:30', end: '07:30' },
      maxNudgesPerDay: 2,
      lockScreenSafe: true,
      photoCadence: 'biweekly',
      why: null,
      preferredTime: null,
    });
  });

  it('resolves stored fields over defaults, field by field and inside audio/quietHours', () => {
    const resolved = resolveCoachUserSettings({ intensity: 3, audio: { speed: 1.25 }, quietHours: { end: '06:00' } });

    expect(resolved.intensity).toBe(3);
    expect(resolved.audio).toEqual({ enabled: false, voice: null, speed: 1.25 });
    expect(resolved.quietHours).toEqual({ start: '21:30', end: '06:00' });
    expect(resolved.personaId).toBe(COACH_USER_DEFAULTS.personaId);
  });
});

describe('coach system setting', () => {
  it('has the spec defaults, and they validate', () => {
    expect(DEFAULT_SYSTEM_SETTINGS.coach).toEqual({
      enabled: true,
      allowProfanePersonas: false,
      allowAudio: true,
      maxNudgesPerDayCeiling: 4,
      audioRetentionDays: 30,
      autoSilenceAfterIgnored: 3,
      inactiveStopDays: 7,
    });
    expect(() => systemCoachSchema.parse(DEFAULT_SYSTEM_SETTINGS.coach)).not.toThrow();
  });

  it.each([
    ['ceiling above the user maximum', { maxNudgesPerDayCeiling: 5 }],
    ['ceiling 0', { maxNudgesPerDayCeiling: 0 }],
    ['retention 0 days', { audioRetentionDays: 0 }],
    ['auto-silence 0', { autoSilenceAfterIgnored: 0 }],
    ['inactive stop 0 days', { inactiveStopDays: 0 }],
  ])('rejects %s', (_label, patch) => {
    expect(systemCoachSchema.safeParse({ ...DEFAULT_SYSTEM_SETTINGS.coach, ...patch }).success).toBe(false);
    expect(systemCoachPatchSchema.safeParse(patch).success).toBe(false);
  });

  it('PATCH accepts a single field', () => {
    expect(systemCoachPatchSchema.parse({ allowAudio: false })).toEqual({ allowAudio: false });
  });
});
