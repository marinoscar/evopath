import {
  TRAINING_MAX_RUN_TOKENS,
  TRAINING_MIN_RUN_TOKENS,
  userAiSettingsPatchSchema,
  userAiSettingsSchema,
  userSettingsPatchSchema,
} from './settings.schema';

// `ai.training`: every field optional, bounded limits rejected at the PATCH,
// null clears in the patch. Both shapes are strict.

describe('user ai settings schemas', () => {
  it('accepts training in the stored/PUT shape', () => {
    const value = { training: { maxRunTokens: 50_000, maxCriticRounds: 3 } };

    expect(userAiSettingsSchema.parse(value)).toEqual(value);
    expect(userAiSettingsSchema.parse({})).toEqual({});
  });

  it('rejects an unknown key in the PUT and PATCH shapes', () => {
    expect(userAiSettingsSchema.safeParse({ unknownKey: null }).success).toBe(false);
    expect(userAiSettingsPatchSchema.safeParse({ unknownKey: null }).success).toBe(false);
    expect(userSettingsPatchSchema.safeParse({ ai: { unknownKey: null } }).success).toBe(false);
  });

  it('the patch accepts null for training and for each training field', () => {
    for (const body of [{ training: null }, { training: { maxRunTokens: null, maxCriticRounds: null } }]) {
      expect(userAiSettingsPatchSchema.safeParse(body).success).toBe(true);
    }
  });

  it.each([
    [TRAINING_MIN_RUN_TOKENS - 1, false],
    [TRAINING_MIN_RUN_TOKENS, true],
    [TRAINING_MAX_RUN_TOKENS, true],
    [TRAINING_MAX_RUN_TOKENS + 1, false],
    [5, false],
    [50_000.5, false],
  ])('maxRunTokens %p valid=%p', (maxRunTokens, valid) => {
    expect(userSettingsPatchSchema.safeParse({ ai: { training: { maxRunTokens } } }).success).toBe(valid);
  });

  it.each([
    [0, false],
    [1, true],
    [2, true],
    [3, true],
    [4, false],
  ])('maxCriticRounds %p valid=%p', (maxCriticRounds, valid) => {
    expect(userSettingsPatchSchema.safeParse({ ai: { training: { maxCriticRounds } } }).success).toBe(valid);
  });

  it('ai: null clears the namespace', () => {
    expect(userSettingsPatchSchema.parse({ ai: null })).toEqual({ ai: null });
  });
});
