import {
  TRAINING_MAX_RUN_TOKENS,
  TRAINING_MIN_RUN_TOKENS,
  userAiSettingsPatchSchema,
  userAiSettingsSchema,
  userAiSettingsWriteSchema,
  userSettingsPatchSchema,
} from './settings.schema';

// `ai.taskModels` and `ai.training`: every field optional (existing accounts
// stay valid), bounded limits rejected at the PATCH, null clears in the patch.

describe('user ai settings schemas', () => {
  const planner = { provider: 'openai', modelId: 'gpt-x', reasoningEffort: 'high' };

  it('a legacy stored value with only defaultModel still parses (ignored since #173)', () => {
    expect(userAiSettingsSchema.safeParse({ defaultModel: null }).success).toBe(true);
    expect(
      userAiSettingsSchema.safeParse({ defaultModel: { provider: 'openai', modelId: 'm' } }).success,
    ).toBe(true);
  });

  it('accepts taskModels and training in the stored shape', () => {
    const value = {
      defaultModel: null,
      taskModels: { planner, critic: { ...planner, reasoningEffort: null } },
      training: { maxRunTokens: 50_000, maxCriticRounds: 3 },
    };

    expect(userAiSettingsSchema.parse(value)).toEqual(value);
  });

  it('rejects an unknown reasoning effort', () => {
    expect(
      userAiSettingsSchema.safeParse({
        defaultModel: null,
        taskModels: { planner: { ...planner, reasoningEffort: 'extreme' } },
      }).success,
    ).toBe(false);
  });

  it('the patch refuses the legacy defaultModel and taskModels (#173: models are admin-assigned)', () => {
    expect(userAiSettingsPatchSchema.safeParse({ defaultModel: null }).success).toBe(false);
    expect(userAiSettingsPatchSchema.safeParse({ taskModels: { planner } }).success).toBe(false);
    expect(userSettingsPatchSchema.safeParse({ ai: { defaultModel: { provider: 'openai', modelId: 'm' } } }).success).toBe(false);
  });

  it('the PUT schema refuses them too and accepts training', () => {
    expect(userAiSettingsWriteSchema.safeParse({ defaultModel: null }).success).toBe(false);
    expect(userAiSettingsWriteSchema.safeParse({ training: { maxCriticRounds: 2 } }).success).toBe(true);
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
