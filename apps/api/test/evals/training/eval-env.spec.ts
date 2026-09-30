import { EVAL_SAMPLES_MAX, LIVE_CONFIRM_TOKENS, estimateLiveRun, liveKeyFor, liveReadiness, parseEvalEnv, parseModels } from './eval-env';

describe('parseEvalEnv', () => {
  it('defaults to a fake-mode, single-sample, stored-brief run', () => {
    expect(parseEvalEnv({})).toEqual({ live: false, personas: null, samples: 1, judge: false, research: 'stored', models: {}, confirm: false, updateBaseline: false, label: null });
  });

  it('reads every switch', () => {
    const parsed = parseEvalEnv({
      EVAL_LIVE: '1',
      EVAL_PERSONAS: 'knee-pain-intermediate, time-crunched-two-days',
      EVAL_SAMPLES: '3',
      EVAL_JUDGE: '1',
      EVAL_RESEARCH: 'live',
      EVAL_MODELS: 'planner=openai:gpt-x:high,critic=anthropic:claude-y',
      EVAL_CONFIRM: '1',
      EVAL_UPDATE_BASELINE: '1',
      EVAL_LABEL: 'frontier-a',
    });
    expect(parsed).toMatchObject({ live: true, personas: ['knee-pain-intermediate', 'time-crunched-two-days'], samples: 3, judge: true, research: 'live', confirm: true, updateBaseline: true, label: 'frontier-a' });
    expect(parsed.models.planner).toEqual({ provider: 'openai', modelId: 'gpt-x', effort: 'high' });
    expect(parsed.models.critic).toEqual({ provider: 'anthropic', modelId: 'claude-y', effort: null });
  });

  it.each([
    [{ EVAL_SAMPLES: '0' }, 'EVAL_SAMPLES'],
    [{ EVAL_SAMPLES: String(EVAL_SAMPLES_MAX + 1) }, 'EVAL_SAMPLES'],
    [{ EVAL_SAMPLES: 'abc' }, 'EVAL_SAMPLES'],
    [{ EVAL_RESEARCH: 'maybe' }, 'EVAL_RESEARCH'],
    [{ EVAL_LABEL: '../etc' }, 'EVAL_LABEL'],
  ])('rejects %j', (env, message) => {
    expect(() => parseEvalEnv(env)).toThrow(message);
  });

  it('only EVAL_UPDATE_BASELINE=1 updates a baseline', () => {
    expect(parseEvalEnv({ EVAL_UPDATE_BASELINE: 'true' }).updateBaseline).toBe(false);
    expect(parseEvalEnv({ EVAL_UPDATE_BASELINE: '1' }).updateBaseline).toBe(true);
  });
});

describe('parseModels', () => {
  it('parses role=provider:model[:effort] entries', () => {
    expect(parseModels('planner=openai:gpt-x:high, critic=gemini:g-y')).toEqual({
      planner: { provider: 'openai', modelId: 'gpt-x', effort: 'high' },
      critic: { provider: 'gemini', modelId: 'g-y', effort: null },
    });
    expect(parseModels(undefined)).toEqual({});
  });

  it.each([
    ['planner', 'role=provider:model'],
    ['wizard=openai:x', 'unknown role'],
    ['planner=nowhere:x', 'unsupported provider'],
    ['planner=openai', 'has no model'],
  ])('rejects "%s"', (raw, message) => {
    expect(() => parseModels(raw)).toThrow(message);
  });
});

describe('liveReadiness', () => {
  const models = 'planner=openai:gpt-x:high,critic=openai:gpt-y';

  it('is not ready without EVAL_LIVE, models or a key, and says why', () => {
    expect(liveReadiness(parseEvalEnv({}), {}).reason).toContain('EVAL_LIVE=1');
    expect(liveReadiness(parseEvalEnv({ EVAL_LIVE: '1' }), {}).reason).toContain('EVAL_MODELS');
    expect(liveReadiness(parseEvalEnv({ EVAL_LIVE: '1', EVAL_MODELS: 'planner=openai:x' }), {}).reason).toContain('planner and the critic');
    expect(liveReadiness(parseEvalEnv({ EVAL_LIVE: '1', EVAL_MODELS: models }), {}).reason).toContain('OPENAI_API_KEY_FOR_TESTS');
  });

  it('is ready with the flag, both models and a key for the provider', () => {
    const env = { EVAL_LIVE: '1', EVAL_MODELS: models, OPENAI_API_KEY_FOR_TESTS: 'sk-test-key-value' };
    expect(liveReadiness(parseEvalEnv(env), env)).toEqual({ ready: true, reason: '' });
    expect(liveKeyFor('openai', env)).toBe('sk-test-key-value');
    expect(liveKeyFor('anthropic', env)).toBeUndefined();
  });
});

describe('estimateLiveRun', () => {
  it('needs EVAL_CONFIRM above the threshold', () => {
    expect(estimateLiveRun(2, { samples: 1, judge: false, research: 'stored' }).needsConfirm).toBe(false);
    const big = estimateLiveRun(17, { samples: 3, judge: true, research: 'live' });
    expect(big.tokens).toBeGreaterThan(LIVE_CONFIRM_TOKENS);
    expect(big.needsConfirm).toBe(true);
  });
});
