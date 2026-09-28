import { AiConfigService, type AiPolicy } from '../config/ai-config.service';
import { AiError } from '../core/ai-error';
import { AI_KEYLESS_API_KEY } from '../core/provider-adapter.interface';
import { AiProviderRegistry } from '../core/provider-registry';
import { FakeAiProvider } from '../testing/fake-ai-provider';
import { AiKeyResolver } from './ai-key-resolver.service';

// =============================================================================
// AiKeyResolver (issue #431) — the full resolution matrix
//
//   {user key yes/no} × {policy byok / byok_with_org_fallback} × {org key yes/no}
//
// plus the invariant the whole platform rests on (docs/specs/ai-platform.md §2.2):
// under `byok` the org key is never returned — and never even READ.
// =============================================================================

const USER_KEY = 'sk-user-own-key-1111';
const ORG_KEY = 'sk-org-admin-key-9999';

type Policy = AiPolicy['keyPolicy'];

interface Case {
  userKey: boolean;
  keyPolicy: Policy;
  orgKey: boolean;
  expected: 'user' | 'org' | 'AI_KEY_REQUIRED';
}

const MATRIX: Case[] = [
  { userKey: true, keyPolicy: 'byok', orgKey: true, expected: 'user' },
  { userKey: true, keyPolicy: 'byok', orgKey: false, expected: 'user' },
  { userKey: true, keyPolicy: 'byok_with_org_fallback', orgKey: true, expected: 'user' },
  { userKey: true, keyPolicy: 'byok_with_org_fallback', orgKey: false, expected: 'user' },
  { userKey: false, keyPolicy: 'byok', orgKey: true, expected: 'AI_KEY_REQUIRED' },
  { userKey: false, keyPolicy: 'byok', orgKey: false, expected: 'AI_KEY_REQUIRED' },
  { userKey: false, keyPolicy: 'byok_with_org_fallback', orgKey: true, expected: 'org' },
  { userKey: false, keyPolicy: 'byok_with_org_fallback', orgKey: false, expected: 'AI_KEY_REQUIRED' },
];

function build(c: Omit<Case, 'expected'>, compatible: { requiresKey?: boolean } = {}) {
  const getDecrypted = jest.fn(async () => (c.userKey ? USER_KEY : null));
  const getSecret = jest.fn(async () => (c.orgKey ? ORG_KEY : null));
  const describe_ = jest.fn(async () => (c.orgKey ? { hint: '••••9999' } : null));
  const registry = new AiProviderRegistry();
  registry.register(new FakeAiProvider({ id: 'openai' }));
  const policy: AiPolicy = {
    enabled: true,
    keyPolicy: c.keyPolicy,
    providers: {
      openai: { enabled: true },
      anthropic: { enabled: false },
      gemini: { enabled: false },
      'azure-openai': { enabled: false },
      'openai-compatible': { enabled: true, baseUrl: 'http://ollama.internal:11434/v1', ...compatible },
    },
    defaults: { allowBackgroundRuns: true, allowRealtime: false },
    logPromptContent: false,
    usageRetentionDays: 180,
    hostedTools: {
      web_search: false,
      file_search: false,
      code_interpreter: false,
      image_generation: false,
      mcp: false,
      mcpAllowedHosts: [],
    },
    limits: {},
  };
  const aiConfig = new AiConfigService(
    { getAiPolicy: jest.fn(async () => policy) } as never,
    { getSecret, describe: describe_ } as never,
    registry,
  );
  const resolver = new AiKeyResolver({ getDecrypted } as never, aiConfig);

  return { resolver, getDecrypted, getSecret, describe_ };
}

const label = (c: Case) =>
  `user key ${c.userKey ? 'yes' : 'no '} × ${c.keyPolicy.padEnd(22)} × org key ${c.orgKey ? 'yes' : 'no '} -> ${c.expected}`;

describe('AiKeyResolver', () => {
  describe.each(MATRIX.map((c) => [label(c), c] as const))('%s', (_name, c) => {
    it('resolve()', async () => {
      const { resolver } = build(c);

      if (c.expected === 'AI_KEY_REQUIRED') {
        const error = await resolver.resolve('user-1', 'openai').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AiError);
        expect((error as AiError).code).toBe('AI_KEY_REQUIRED');
        expect((error as AiError).getStatus()).toBe(403);
        expect(JSON.stringify(error)).not.toContain(ORG_KEY);
      } else {
        await expect(resolver.resolve('user-1', 'openai')).resolves.toEqual({
          apiKey: c.expected === 'user' ? USER_KEY : ORG_KEY,
          keySource: c.expected,
        });
      }
    });

    it('sourceFor() agrees without decrypting anything', async () => {
      const { resolver, getDecrypted, getSecret } = build(c);

      await expect(resolver.sourceFor('openai', c.userKey)).resolves.toBe(
        c.expected === 'AI_KEY_REQUIRED' ? null : c.expected,
      );
      expect(getDecrypted).not.toHaveBeenCalled();
      expect(getSecret).not.toHaveBeenCalled();
    });
  });

  describe("⚠ under keyPolicy 'byok' the org key is never read", () => {
    it.each([true, false])('user key %s', async (userKey) => {
      const { resolver, getSecret, describe_ } = build({ userKey, keyPolicy: 'byok', orgKey: true });

      await resolver.resolve('user-1', 'openai').catch(() => undefined);
      await resolver.sourceFor('openai', userKey);

      expect(getSecret).not.toHaveBeenCalled();
      expect(describe_).not.toHaveBeenCalled();
    });
  });

  it("a user's own key wins without consulting the org key at all", async () => {
    const { resolver, getSecret } = build({
      userKey: true,
      keyPolicy: 'byok_with_org_fallback',
      orgKey: true,
    });

    await resolver.resolve('user-1', 'openai');

    expect(getSecret).not.toHaveBeenCalled();
  });

  it('looks up the key of the user it was asked about', async () => {
    const { resolver, getDecrypted } = build({ userKey: true, keyPolicy: 'byok', orgKey: false });

    await resolver.resolve('user-42', 'openai');

    expect(getDecrypted).toHaveBeenCalledWith('user-42', 'openai');
  });

  describe("a keyless provider (requiresKey: false, #448) resolves to keySource 'none'", () => {
    describe.each(MATRIX.map((c) => [label(c).replace(/ -> .*/, ''), c] as const))('%s', (_name, c) => {
      it('resolve() answers the placeholder without reading any key', async () => {
        const { resolver, getDecrypted, getSecret, describe_ } = build(c, { requiresKey: false });

        await expect(resolver.resolve('user-1', 'openai-compatible')).resolves.toEqual({
          apiKey: AI_KEYLESS_API_KEY,
          keySource: 'none',
        });
        await expect(resolver.sourceFor('openai-compatible', c.userKey)).resolves.toBe('none');
        expect(getDecrypted).not.toHaveBeenCalled();
        expect(getSecret).not.toHaveBeenCalled();
        expect(describe_).not.toHaveBeenCalled();
      });
    });

    it('is the admin opt-in only: requiresKey true or absent resolves keys as usual', async () => {
      for (const compatible of [{}, { requiresKey: true }]) {
        const { resolver } = build({ userKey: false, keyPolicy: 'byok', orgKey: false }, compatible);
        const error = await resolver.resolve('user-1', 'openai-compatible').catch((e: unknown) => e);

        expect((error as AiError).code).toBe('AI_KEY_REQUIRED');
        await expect(resolver.sourceFor('openai-compatible', false)).resolves.toBeNull();
      }
    });

    it('never makes another provider keyless', async () => {
      const { resolver } = build({ userKey: false, keyPolicy: 'byok', orgKey: false }, { requiresKey: false });

      await expect(resolver.resolve('user-1', 'openai')).rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
    });
  });
});
