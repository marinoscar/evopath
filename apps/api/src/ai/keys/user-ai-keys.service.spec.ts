import { decryptSecret, encryptSecret } from '../../common/crypto/secret-cipher';
import { AiConfigService, type AiPolicy } from '../config/ai-config.service';
import { AI_CREDENTIAL_PURPOSE } from '../config/ai-credential.constants';
import { AiError } from '../core/ai-error';
import { AiProviderRegistry } from '../core/provider-registry';
import { FakeAiProvider } from '../testing/fake-ai-provider';
import { createInMemoryAiKeysPrisma, type InMemoryAiKeysPrisma } from '../testing/in-memory-ai-keys-prisma';
import { AI_USER_KEY_PURPOSE } from './ai-user-key.constants';
import { UserAiKeysService } from './user-ai-keys.service';

// =============================================================================
// UserAiKeysService (issue #431) — against the REAL secret cipher and an
// in-memory table, so "stored as ciphertext", "never returned" and "scoped to
// the caller" are statements about what actually got written.
// =============================================================================

const ORIGINAL_KEY_ENV = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

afterAll(() => {
  if (ORIGINAL_KEY_ENV === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = ORIGINAL_KEY_ENV;
});

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const KEY_A = 'sk-user-a-secret-key-AAAA';
const KEY_B = 'sk-user-b-secret-key-BBBB';
const REVOKED = 'sk-revoked-key-RRRR';

function policy(overrides: Partial<AiPolicy> = {}): AiPolicy {
  return {
    enabled: true,
    keyPolicy: 'byok',
    providers: { openai: { enabled: true }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } },
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
    ...overrides,
  };
}

describe('UserAiKeysService', () => {
  let db: InMemoryAiKeysPrisma;
  let fake: FakeAiProvider;
  let current: AiPolicy;
  let service: UserAiKeysService;
  let aiConfig: AiConfigService;

  /** Change the stored policy and drop the 5 s cache, as an admin write would. */
  const setPolicy = (next: AiPolicy) => {
    current = next;
    aiConfig.invalidateCache();
  };

  beforeEach(() => {
    db = createInMemoryAiKeysPrisma();
    db.addModel({ modelId: 'gpt-mini' });
    db.addModel({ modelId: 'gpt-big', enabled: false });
    fake = new FakeAiProvider({
      id: 'openai',
      validKeys: [KEY_A, KEY_B],
      models: ['gpt-mini', 'gpt-big', 'not-in-catalog'],
    });
    const registry = new AiProviderRegistry();
    registry.register(fake);
    current = policy();
    aiConfig = new AiConfigService(
      { getAiPolicy: jest.fn(async () => current) } as never,
      { getSecret: jest.fn(), describe: jest.fn() } as never,
      registry,
    );
    service = new UserAiKeysService(db.prisma as never, aiConfig, registry);
  });

  describe('set', () => {
    it('stores ciphertext under the ai_user_key purpose, never the key', async () => {
      await service.set(USER_A, 'openai', KEY_A);

      const [row] = db.keys;
      expect(row.secret).not.toBe(KEY_A);
      expect(row.secret).not.toContain(KEY_A);
      expect(decryptSecret(row.secret, AI_USER_KEY_PURPOSE)).toBe(KEY_A);
    });

    it("cannot be decrypted under the admin key's purpose", async () => {
      await service.set(USER_A, 'openai', KEY_A);

      expect(() => decryptSecret(db.keys[0].secret, AI_CREDENTIAL_PURPOSE)).toThrow();
    });

    it('verifies first, then stores reachable = listed ∩ catalog (enabled or not)', async () => {
      const view = await service.set(USER_A, 'openai', KEY_A);

      expect(fake.callsTo('verifyKey')).toHaveLength(1);
      expect(db.keys[0].reachableModelIds).toEqual(['gpt-big', 'gpt-mini']);
      expect(view).toEqual({
        provider: 'openai',
        configured: true,
        hint: '••••AAAA',
        verifiedAt: expect.any(String),
        lastErrorCode: null,
        reachableModelCount: 2,
        reachableCheckedAt: expect.any(String),
      });
      expect(JSON.stringify(view)).not.toContain(KEY_A);
    });

    it('rejects an invalid key with 400 AI_KEY_INVALID and stores nothing', async () => {
      const error = await service.set(USER_A, 'openai', REVOKED).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AiError);
      expect((error as AiError).code).toBe('AI_KEY_INVALID');
      expect((error as AiError).getStatus()).toBe(400);
      expect(JSON.stringify(error)).not.toContain(REVOKED);
      expect(db.keys).toHaveLength(0);
      expect(db.audits).toHaveLength(0);
    });

    it('replaces an earlier key rather than adding a second row', async () => {
      await service.set(USER_A, 'openai', KEY_A);
      await service.set(USER_A, 'openai', KEY_B);

      expect(db.keys).toHaveLength(1);
      expect(decryptSecret(db.keys[0].secret, AI_USER_KEY_PURPOSE)).toBe(KEY_B);
    });

    it('audits ai_key:set with a count and never the key', async () => {
      await service.set(USER_A, 'openai', KEY_A);

      expect(db.audits).toEqual([
        {
          actorUserId: USER_A,
          action: 'ai_key:set',
          targetType: 'user_ai_key',
          targetId: 'openai',
          meta: { provider: 'openai', reachableCount: 2 },
        },
      ]);
      expect(JSON.stringify(db.audits)).not.toContain(KEY_A);
    });

    it('refuses a disabled provider, and everything while AI is off', async () => {
      setPolicy(policy({ providers: { openai: { enabled: false }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } } }));
      await expect(service.set(USER_A, 'openai', KEY_A)).rejects.toMatchObject({
        code: 'AI_PROVIDER_DISABLED',
      });

      setPolicy(policy({ enabled: false }));
      await expect(service.set(USER_A, 'openai', KEY_A)).rejects.toMatchObject({ code: 'AI_DISABLED' });
      expect(fake.calls).toHaveLength(0);
    });

    it('passes the admin-configured base URL to the provider', async () => {
      current = policy({ providers: { openai: { enabled: true, baseUrl: 'https://proxy.example/v1' }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } } });
      await service.set(USER_A, 'openai', KEY_A);

      expect(fake.calls.every((call) => call.baseUrl === 'https://proxy.example/v1')).toBe(true);
    });
  });

  describe('list', () => {
    it('answers one view per enabled provider, configured or not', async () => {
      expect(await service.list(USER_A)).toEqual([
        {
          provider: 'openai',
          configured: false,
          hint: null,
          verifiedAt: null,
          lastErrorCode: null,
          reachableModelCount: 0,
          reachableCheckedAt: null,
        },
      ]);
    });

    it("never shows another user's key", async () => {
      await service.set(USER_B, 'openai', KEY_B);

      const [view] = await service.list(USER_A);
      expect(view.configured).toBe(false);
    });

    it('never reads the secret column for a view', async () => {
      await service.set(USER_A, 'openai', KEY_A);
      await service.list(USER_A);

      for (const [args] of db.prisma.userAiKey.findMany.mock.calls) {
        expect((args as { select?: Record<string, unknown> }).select?.secret).toBeUndefined();
      }
    });

    it('is empty while AI is off', async () => {
      current = policy({ enabled: false });
      expect(await service.list(USER_A)).toEqual([]);
    });
  });

  describe('remove', () => {
    it("deletes only the caller's key, and is idempotent", async () => {
      await service.set(USER_A, 'openai', KEY_A);
      await service.set(USER_B, 'openai', KEY_B);

      await service.remove(USER_A, 'openai');
      await service.remove(USER_A, 'openai');

      expect(db.keys.map((row) => row.userId)).toEqual([USER_B]);
      expect(db.audits.filter((audit) => audit.action === 'ai_key:delete')).toHaveLength(1);
    });
  });

  describe('test', () => {
    it('answers not_configured when nothing is submitted or stored', async () => {
      const result = await service.test(USER_A, 'openai');

      expect(result.success).toBe(false);
      expect(result.usedStoredKey).toBe(true);
      expect(result.checks.map((c) => c.code)).toEqual(['not_configured', 'not_configured']);
      expect(fake.calls).toHaveLength(0);
    });

    it("tests the caller's own stored key — never another user's", async () => {
      await service.set(USER_B, 'openai', KEY_B);
      fake.reset();

      const result = await service.test(USER_A, 'openai');

      expect(result.checks[0].code).toBe('not_configured');
      expect(fake.apiKeys).toEqual([]);
    });

    it('a stored-key test refreshes reachable models and verification', async () => {
      await service.set(USER_A, 'openai', KEY_A);
      db.addModel({ modelId: 'not-in-catalog' });
      db.keys[0].lastErrorCode = 'AI_KEY_INVALID';

      const result = await service.test(USER_A, 'openai', '');

      expect(result).toMatchObject({ success: true, usedStoredKey: true, reachableModelCount: 3 });
      expect(db.keys[0].reachableModelIds).toHaveLength(3);
      expect(db.keys[0].lastErrorCode).toBeNull();
    });

    it('a submitted key is probed but never stored, and changes no row', async () => {
      await service.set(USER_A, 'openai', KEY_A);
      const before = { ...db.keys[0] };

      const result = await service.test(USER_A, 'openai', KEY_B);

      expect(result.usedStoredKey).toBe(false);
      expect(result.success).toBe(true);
      expect(db.keys[0]).toEqual(before);
    });

    it('answers a rejected key as a diagnosis (no throw), without echoing it', async () => {
      const result = await service.test(USER_A, 'openai', REVOKED);

      expect(result.success).toBe(false);
      expect(result.checks[0]).toMatchObject({ id: 'credentials', status: 'failed', code: 'AI_KEY_INVALID' });
      expect(result.checks[1]).toMatchObject({ id: 'list_models', status: 'skipped' });
      expect(JSON.stringify(result)).not.toContain(REVOKED);
    });
  });

  describe('getDecrypted', () => {
    it("returns the caller's plaintext, or null", async () => {
      await service.set(USER_A, 'openai', KEY_A);

      expect(await service.getDecrypted(USER_A, 'openai')).toBe(KEY_A);
      expect(await service.getDecrypted(USER_B, 'openai')).toBeNull();
    });
  });

  describe('recheckReachable', () => {
    it('records a revoked key without deleting it', async () => {
      await service.set(USER_A, 'openai', KEY_A);
      // The provider has since revoked it: store a key the fake rejects.
      db.keys[0].secret = encryptSecret(REVOKED, AI_USER_KEY_PURPOSE);

      expect(await service.recheckReachable(USER_A, 'openai')).toBe('invalid');
      expect(db.keys).toHaveLength(1);
      expect(db.keys[0]).toMatchObject({ lastErrorCode: 'AI_KEY_INVALID', verifiedAt: null });
    });

    it('rethrows a rate limit so the job can defer', async () => {
      await service.set(USER_A, 'openai', KEY_A);
      jest
        .spyOn(fake, 'verifyKey')
        .mockResolvedValueOnce({ ok: false, code: 'AI_RATE_LIMITED' });

      await expect(service.recheckReachable(USER_A, 'openai')).rejects.toMatchObject({
        code: 'AI_RATE_LIMITED',
      });
    });

    it('leaves the row alone on an outage', async () => {
      await service.set(USER_A, 'openai', KEY_A);
      const before = { ...db.keys[0] };
      jest.spyOn(fake, 'listModels').mockRejectedValueOnce(new Error('ECONNRESET'));

      expect(await service.recheckReachable(USER_A, 'openai')).toBe('failed');
      expect(db.keys[0].reachableModelIds).toEqual(before.reachableModelIds);
      expect(db.keys[0].lastErrorCode).toBeNull();
    });

    it("answers 'missing' when the user has no key", async () => {
      expect(await service.recheckReachable(USER_A, 'openai')).toBe('missing');
    });
  });

  describe('staleCutoff', () => {
    const NOW = new Date('2026-09-26T00:00:00.000Z');
    const WEEK_AGO = new Date('2026-09-19T00:00:00.000Z');

    it('is a week ago when no model was discovered since', async () => {
      expect(await service.staleCutoff('openai', NOW)).toEqual(WEEK_AGO);
    });

    it('moves up to the newest discovery, so keys checked before it are stale', async () => {
      const discovered = new Date('2026-09-25T12:00:00.000Z');
      db.addModel({ modelId: 'gpt-new', discoveredAt: discovered });

      expect(await service.staleCutoff('openai', NOW)).toEqual(discovered);
    });

    it("ignores another provider's discoveries", async () => {
      db.addModel({ provider: 'other', modelId: 'x', discoveredAt: new Date('2026-09-25T00:00:00.000Z') });

      expect(await service.staleCutoff('openai', NOW)).toEqual(WEEK_AGO);
    });
  });

  describe('recheckStale', () => {
    const OLD = new Date('2026-01-01T00:00:00.000Z');
    const CUTOFF = new Date('2026-06-01T00:00:00.000Z');

    function seed(count: number, checkedAt: Date | null, key = KEY_A) {
      for (let i = 0; i < count; i += 1) {
        db.keys.push({
          id: `00000000-0000-4000-8000-${String(db.keys.length).padStart(12, '0')}`,
          userId: `user-${db.keys.length}`,
          provider: 'openai',
          secret: encryptSecret(key, AI_USER_KEY_PURPOSE),
          hint: '••••AAAA',
          verifiedAt: OLD,
          lastErrorCode: null,
          reachableModelIds: [],
          reachableCheckedAt: checkedAt,
          createdAt: OLD,
          updatedAt: OLD,
        });
      }
    }

    it('rechecks only stale keys, across batches of 50', async () => {
      seed(120, OLD);
      seed(2, null);
      seed(5, new Date()); // fresh

      const counts = await service.recheckStale('openai', CUTOFF);

      expect(counts).toEqual({ ok: 122, invalid: 0, missing: 0, failed: 0 });
      expect(db.prisma.userAiKey.findMany.mock.calls.every(([args]) => (args as { take: number }).take === 50)).toBe(true);
      expect(db.keys.filter((row) => row.reachableModelIds.length === 2)).toHaveLength(122);
    });

    it('records a revoked key without deleting it, and carries on', async () => {
      seed(1, OLD, REVOKED);
      seed(1, OLD);

      const counts = await service.recheckStale('openai', CUTOFF);

      expect(counts).toEqual({ ok: 1, invalid: 1, missing: 0, failed: 0 });
      expect(db.keys).toHaveLength(2);
      expect(db.keys[0].lastErrorCode).toBe('AI_KEY_INVALID');
    });

    it('stops (propagates) when AI is switched off', async () => {
      seed(1, OLD);
      setPolicy(policy({ enabled: false }));

      await expect(service.recheckStale('openai', CUTOFF)).rejects.toMatchObject({ code: 'AI_DISABLED' });
    });
  });
});
