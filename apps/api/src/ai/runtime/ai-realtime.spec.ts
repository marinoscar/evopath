// =============================================================================
// AiService — realtime sessions (issue #449)
// =============================================================================
//
// The facade's gate pipeline for `createRealtimeSession`, over the #432
// harness: the real AiService and its collaborators, `FakeAiProvider`'s
// realtime port recording every call and the key it was called with.
// Every refusal must fail CLOSED — no provider call, no usage row.
// =============================================================================

import { AiError } from '../core/ai-error';
import { FAKE_REALTIME_MODEL_CAPABILITIES, FAKE_REALTIME_SECRET_PREFIX } from '../testing/fake-ai-provider';
import {
  createAiRuntimeHarness,
  HARNESS_MODEL,
  HARNESS_ORG_KEY,
  HARNESS_REALTIME_MODEL,
  HARNESS_USER,
  HARNESS_USER_KEY,
  type AiRuntimeHarnessOptions,
} from '../testing/ai-runtime-harness';

function setup(opts: AiRuntimeHarnessOptions = {}) {
  const h = createAiRuntimeHarness({
    ...opts,
    policy: { ...opts.policy, defaults: { allowRealtime: true, ...opts.policy?.defaults } },
  });
  const client = h.ai.forUser(HARNESS_USER);

  return { h, client };
}

async function caught(run: () => Promise<unknown>): Promise<AiError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(AiError);

    return err as AiError;
  }

  throw new Error('expected an AiError');
}

describe('AiService — realtime sessions', () => {
  it('mints with the user key, returns the ephemeral secret, and records one sessions usage row', async () => {
    const { h, client } = setup();

    const session = await client.createRealtimeSession({
      model: HARNESS_REALTIME_MODEL,
      voice: 'alloy',
      instructions: 'Answer briefly.',
    });

    expect(session).toEqual({
      provider: 'openai',
      model: HARNESS_REALTIME_MODEL,
      voice: 'alloy',
      clientSecret: `${FAKE_REALTIME_SECRET_PREFIX}1`,
      expiresAt: expect.any(Date),
      connectUrl: 'https://realtime.fake.invalid/v1/realtime/calls',
    });
    expect(JSON.stringify(session)).not.toContain(HARNESS_USER_KEY);

    const calls = h.fake.callsTo('realtime.createSession');

    expect(calls).toHaveLength(1);
    expect(calls[0].apiKey).toBe(HARNESS_USER_KEY);
    expect(calls[0].realtimeRequest).toEqual({
      model: HARNESS_REALTIME_MODEL,
      voice: 'alloy',
      instructions: 'Answer briefly.',
    });

    expect(h.usageEvents).toEqual([
      expect.objectContaining({
        userId: HARNESS_USER,
        provider: 'openai',
        modelId: HARNESS_REALTIME_MODEL,
        operation: 'realtime',
        keySource: 'user',
        status: 'succeeded',
        units: { sessions: 1 },
        inputTokens: null,
        outputTokens: null,
      }),
    ]);
    expect(JSON.stringify(h.usageEvents)).not.toContain(session.clientSecret);
    expect(JSON.stringify(h.usageEvents)).not.toContain(HARNESS_USER_KEY);
  });

  it('defaults to the first usable realtime model and its first voice', async () => {
    const { h, client } = setup();

    const session = await client.createRealtimeSession({});

    expect(session.model).toBe(HARNESS_REALTIME_MODEL);
    expect(session.voice).toBe(FAKE_REALTIME_MODEL_CAPABILITIES.voices![0]);
    expect(h.fake.callsTo('realtime.createSession')[0].realtimeRequest?.voice).toBe('marin');
  });

  it('passes the deployment output cap as the session default', async () => {
    const { h, client } = setup({ policy: { defaults: { allowRealtime: true, maxOutputTokensCap: 900 } } });

    await client.createRealtimeSession({});

    expect(h.fake.callsTo('realtime.createSession')[0].realtimeRequest?.maxOutputTokens).toBe(900);
  });

  it('pays with the org key only under byok_with_org_fallback, for a user with no key', async () => {
    const { h, client } = setup({ userKey: false, orgKey: true, policy: { keyPolicy: 'byok_with_org_fallback' } });

    await client.createRealtimeSession({});

    expect(h.fake.callsTo('realtime.createSession')[0].apiKey).toBe(HARNESS_ORG_KEY);
    expect(h.usageEvents[0]).toMatchObject({ operation: 'realtime', keySource: 'org' });
  });

  describe('fails closed', () => {
    async function refused(opts: AiRuntimeHarnessOptions, req: Parameters<ReturnType<typeof setup>['client']['createRealtimeSession']>[0] = {}) {
      const { h, client } = setup(opts);
      const err = await caught(() => client.createRealtimeSession(req));

      expect(h.fake.callsTo('realtime.createSession')).toHaveLength(0);
      expect(h.usageEvents).toHaveLength(0);

      return err;
    }

    it('while AI is off: AI_DISABLED', async () => {
      expect((await refused({ policy: { enabled: false } })).code).toBe('AI_DISABLED');
    });

    it('while realtime is off (the default): AI_REALTIME_DISABLED, 403', async () => {
      const err = await refused({ policy: { defaults: { allowRealtime: false } } });

      expect(err.code).toBe('AI_REALTIME_DISABLED');
      expect(err.getStatus()).toBe(403);
    });

    it('checks the realtime switch before anything else about the request', async () => {
      const err = await refused({ policy: { defaults: { allowRealtime: false } } }, { model: HARNESS_MODEL, voice: 'nope' });

      expect(err.code).toBe('AI_REALTIME_DISABLED');
    });

    it('for a model without realtime: AI_CAPABILITY_UNSUPPORTED', async () => {
      expect((await refused({}, { model: HARNESS_MODEL })).code).toBe('AI_CAPABILITY_UNSUPPORTED');
    });

    it('with no key under byok: AI_KEY_REQUIRED, and the org key is never used', async () => {
      const err = await refused({ userKey: false, orgKey: true }, { model: HARNESS_REALTIME_MODEL });

      expect(err.code).toBe('AI_KEY_REQUIRED');
    });

    it('for a voice the model does not list: AI_INVALID_REQUEST', async () => {
      expect((await refused({}, { model: HARNESS_REALTIME_MODEL, voice: 'cedar' })).code).toBe('AI_INVALID_REQUEST');
    });

    it('when no realtime model is usable: AI_INVALID_REQUEST', async () => {
      expect((await refused({ models: [{ modelId: HARNESS_MODEL }] })).code).toBe('AI_INVALID_REQUEST');
    });

    it('for over-long instructions: AI_INVALID_REQUEST', async () => {
      expect((await refused({}, { instructions: 'x'.repeat(16_001) })).code).toBe('AI_INVALID_REQUEST');
    });

    it('over a rate limit: AI_RATE_LIMITED — a mint counts as a request', async () => {
      const { h, client } = setup({ policy: { limits: { perUser: { requestsPerMinute: 1 } } } });

      await client.createRealtimeSession({});
      const err = await caught(() => client.createRealtimeSession({}));

      expect(err.code).toBe('AI_RATE_LIMITED');
      expect(h.fake.callsTo('realtime.createSession')).toHaveLength(1);
      expect(h.usageEvents).toHaveLength(1);
    });
  });

  it('a provider failure records a failed usage row with no units and rethrows the AiError', async () => {
    const { h, client } = setup();
    const port = h.fake.realtime!;
    const original = port.createSession;

    port.createSession = async () => {
      throw new AiError('AI_PROVIDER_UNAVAILABLE', 'down');
    };

    try {
      expect((await caught(() => client.createRealtimeSession({}))).code).toBe('AI_PROVIDER_UNAVAILABLE');
    } finally {
      port.createSession = original;
    }

    expect(h.usageEvents).toEqual([
      expect.objectContaining({ operation: 'realtime', status: 'failed', errorCode: 'AI_PROVIDER_UNAVAILABLE' }),
    ]);
    expect(h.usageEvents[0]).not.toHaveProperty('units');
  });
});
