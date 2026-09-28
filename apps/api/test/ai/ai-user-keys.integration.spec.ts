// =============================================================================
// User AI keys (BYOK) + usable models Integration (issue #431, epic #419)
// =============================================================================
//
// HTTP-level coverage for the caller's own AI surface:
//
//   GET/PUT/DELETE /api/ai/keys[/:provider], POST /api/ai/keys/:provider/test,
//   GET /api/ai/models
//
//   * Every route requires `ai:use` and answers `403 AI_DISABLED` while AI is off.
//   * The stored `secret` is ciphertext under the `ai_user_key` purpose.
//   * ⚠ NO RESPONSE FROM ANY ROUTE CONTAINS A KEY — the user's own, another
//     user's, or the org key (serialise-and-search over every body).
//   * User A can never read, test or delete user B's key.
//   * Usable models = enabled ∩ reachable; `keySource: 'org'` under fallback.
//   * Deleting a user cascades their `user_ai_keys` rows.
//
// `FakeAiProvider` is registered as `openai` in the real registry, and the
// `user_ai_keys` / `ai_models` / `audit_events` delegates of the Prisma mock
// are backed by an in-memory table, so scoping bugs surface as wrong rows
// rather than as a stub that agrees with everything. The cipher is REAL.
// =============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import request from 'supertest';

// Must precede the first encrypt — secret-cipher caches its master key.
const ORIGINAL_KEY_ENV = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
  authHeader,
  TestUser,
} from '../helpers/auth-mock.helper';
import { PERMISSIONS_KEY } from '../../src/auth/decorators/permissions.decorator';
import { decryptSecret } from '../../src/common/crypto/secret-cipher';
import { CredentialsService } from '../../src/credentials/credentials.service';
import { AiProviderRegistry } from '../../src/ai/core';
import { AiConfigService } from '../../src/ai/config/ai-config.service';
import { AiEnabledGuard } from '../../src/ai/config/ai-enabled.guard';
import { UserAiKeysController } from '../../src/ai/keys/user-ai-keys.controller';
import { FakeAiProvider } from '../../src/ai/testing/fake-ai-provider';
import {
  createInMemoryAiKeysPrisma,
  type InMemoryAiKeysPrisma,
} from '../../src/ai/testing/in-memory-ai-keys-prisma';

const USER_KEY_A = 'sk-user-a-never-leak-Qa12';
const USER_KEY_B = 'sk-user-b-never-leak-Qb34';
const ORG_KEY = 'sk-org-key-never-leak-Or56';
const BAD_KEY = 'sk-bad-key-never-leak-Xx99';
const ALL_KEYS = [USER_KEY_A, USER_KEY_B, ORG_KEY, BAD_KEY];

type StoredAi = {
  enabled: boolean;
  keyPolicy: 'byok' | 'byok_with_org_fallback';
  providers: { openai: { enabled: boolean; baseUrl?: string } };
  defaults: { allowBackgroundRuns: boolean };
  logPromptContent: boolean;
};

function aiOn(overrides: Partial<StoredAi> = {}): StoredAi {
  return {
    enabled: true,
    keyPolicy: 'byok',
    providers: { openai: { enabled: true } },
    defaults: { allowBackgroundRuns: true },
    logPromptContent: false,
    ...overrides,
  };
}

describe('User AI keys and usable models Integration', () => {
  let context: TestContext;
  let fake: FakeAiProvider;
  let db: InMemoryAiKeysPrisma;
  let storedAi: StoredAi;
  let orgKey: string | null;
  let bodies: string[];

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        {
          provide: CredentialsService,
          useValue: {
            describe: jest.fn(async (purpose: string, name: string) =>
              orgKey && purpose === 'ai' && name === 'openai' ? { purpose, name, hint: '••••Or56' } : null,
            ),
            getSecret: jest.fn(async () => orgKey),
            setSecret: jest.fn(),
            deleteSecret: jest.fn(),
          },
        },
      ],
    });

    fake = new FakeAiProvider({
      id: 'openai',
      validKeys: [USER_KEY_A, USER_KEY_B, ORG_KEY],
      models: ['gpt-mini', 'gpt-big', 'gpt-old', 'private-ft'],
    });
    context.app.get(AiProviderRegistry).register(fake);
  });

  afterAll(async () => {
    await closeTestApp(context);
    if (ORIGINAL_KEY_ENV === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = ORIGINAL_KEY_ENV;
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    fake.reset();
    context.app.get(AiConfigService).invalidateCache();

    storedAi = aiOn();
    orgKey = null;
    bodies = [];

    db = createInMemoryAiKeysPrisma();
    db.addModel({ modelId: 'gpt-mini', displayName: 'GPT mini' });
    db.addModel({ modelId: 'gpt-big' });
    db.addModel({ modelId: 'gpt-off', enabled: false });
    db.addModel({ modelId: 'gpt-old', deprecatedAt: new Date('2026-02-01T00:00:00.000Z') });

    const pm = context.prismaMock as any;
    for (const method of ['findMany', 'findUnique', 'count', 'upsert', 'updateMany', 'deleteMany'] as const) {
      pm.userAiKey[method].mockImplementation((db.prisma.userAiKey as any)[method]);
    }
    for (const method of ['findMany', 'findUnique', 'findFirst'] as const) {
      pm.aiModel[method].mockImplementation((db.prisma.aiModel as any)[method]);
    }
    pm.auditEvent.create.mockImplementation(db.prisma.auditEvent.create);
    pm.systemSettings.findUnique.mockImplementation(async () => ({
      id: 'settings-global',
      key: 'global',
      value: { ai: storedAi },
      version: 1,
      updatedAt: new Date(),
      updatedByUserId: null,
    }));
  });

  function server() {
    return context.app.getHttpServer();
  }

  function record(res: request.Response): request.Response {
    bodies.push(res.text);
    return res;
  }

  function setPolicy(next: StoredAi) {
    storedAi = next;
    context.app.get(AiConfigService).invalidateCache();
  }

  afterEach(() => {
    // ⚠ Acceptance criterion: no route response contains any key.
    for (const body of bodies) {
      for (const key of ALL_KEYS) {
        expect(body).not.toContain(key);
      }
    }
  });

  const ROUTES: Array<['get' | 'put' | 'delete' | 'post', string, Record<string, unknown> | undefined]> = [
    ['get', '/api/ai/keys', undefined],
    ['put', '/api/ai/keys/openai', { apiKey: USER_KEY_A }],
    ['delete', '/api/ai/keys/openai', undefined],
    ['post', '/api/ai/keys/openai/test', {}],
    ['get', '/api/ai/models', undefined],
  ];

  // ==========================================================================
  // Guards
  // ==========================================================================

  describe('guards', () => {
    it.each([
      ['list'],
      ['set'],
      ['remove'],
      ['test'],
      ['listModels'],
    ] as Array<[keyof UserAiKeysController]>)('%s requires exactly ai:use', (handler) => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, UserAiKeysController.prototype[handler])).toEqual([
        'ai:use',
      ]);
    });

    it('carries AiEnabledGuard on the controller', () => {
      expect(Reflect.getMetadata('__guards__', UserAiKeysController)).toContain(AiEnabledGuard);
    });

    it.each(ROUTES)('%s %s: 401 without a token', async (method, path, payload) => {
      const req = request(server())[method](path);
      await (payload ? req.send(payload) : req).expect(401);
    });

    it.each(ROUTES)('%s %s: 403 AI_DISABLED while AI is off', async (method, path, payload) => {
      setPolicy(aiOn({ enabled: false }));
      const viewer = await createMockViewerUser(context);
      const req = request(server())[method](path).set(authHeader(viewer.accessToken));
      const res = record(await (payload ? req.send(payload) : req).expect(403));

      expect(res.body.details.reason).toBe('AI_DISABLED');
      expect(fake.calls).toHaveLength(0);
    });

    it('GET /api/ai/config stays reachable while AI is off', async () => {
      setPolicy(aiOn({ enabled: false }));
      const viewer = await createMockViewerUser(context);

      const res = record(
        await request(server()).get('/api/ai/config').set(authHeader(viewer.accessToken)).expect(200),
      );
      expect(res.body.data).toEqual({
        enabled: false,
        keyPolicy: 'byok',
        allowBackgroundRuns: false,
        allowRealtime: false,
        hostedTools: { web_search: false, file_search: false, code_interpreter: false, image_generation: false, mcp: false },
        providers: [],
      });
    });

    it.each([
      ['contributor', createMockContributorUser],
      ['admin', createMockAdminUser],
    ] as const)('every role granted ai:use (%s) may use AI', async (_role, make) => {
      const user = await make(context);
      await request(server()).get('/api/ai/keys').set(authHeader(user.accessToken)).expect(200);
    });

    it('a viewer, who no longer holds ai:use, is refused (#499)', async () => {
      const viewer = await createMockViewerUser(context);
      const res = await request(server())
        .get('/api/ai/keys')
        .set(authHeader(viewer.accessToken))
        .expect(403);

      expect(res.body.code).toBe('FORBIDDEN');
    });
  });

  // ==========================================================================
  // Keys
  // ==========================================================================

  describe('keys', () => {
    let alice: TestUser;
    let bob: TestUser;

    beforeEach(async () => {
      alice = await createMockContributorUser(context);
      bob = await createMockContributorUser(context);
    });

    it('lists one unconfigured view per enabled provider on a fresh account', async () => {
      const res = record(
        await request(server()).get('/api/ai/keys').set(authHeader(alice.accessToken)).expect(200),
      );

      expect(res.body.data).toEqual([
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

    it('PUT verifies, stores ciphertext, and answers the masked view', async () => {
      const res = record(
        await request(server())
          .put('/api/ai/keys/openai')
          .set(authHeader(alice.accessToken))
          .send({ apiKey: USER_KEY_A })
          .expect(200),
      );

      expect(res.body.data).toMatchObject({
        provider: 'openai',
        configured: true,
        hint: '••••Qa12',
        lastErrorCode: null,
        reachableModelCount: 3, // gpt-mini, gpt-big, gpt-old — not the uncatalogued private-ft
      });

      const [row] = db.keys;
      expect(row.userId).toBe(alice.id);
      expect(row.secret).not.toContain(USER_KEY_A);
      expect(decryptSecret(row.secret, 'ai_user_key')).toBe(USER_KEY_A);
      expect(fake.callsTo('verifyKey').map((call) => call.apiKey)).toEqual([USER_KEY_A]);
      expect(db.audits).toEqual([
        expect.objectContaining({
          actorUserId: alice.id,
          action: 'ai_key:set',
          targetType: 'user_ai_key',
          targetId: 'openai',
        }),
      ]);
    });

    it('PUT with a rejected key answers 400 AI_KEY_INVALID and stores nothing', async () => {
      const res = record(
        await request(server())
          .put('/api/ai/keys/openai')
          .set(authHeader(alice.accessToken))
          .send({ apiKey: BAD_KEY })
          .expect(400),
      );

      expect(res.body.details.reason).toBe('AI_KEY_INVALID');
      expect(db.keys).toHaveLength(0);
    });

    it('PUT validates the body (min 8, max 512)', async () => {
      for (const apiKey of ['short', 'x'.repeat(513)]) {
        record(
          await request(server())
            .put('/api/ai/keys/openai')
            .set(authHeader(alice.accessToken))
            .send({ apiKey })
            .expect(400),
        );
      }
      expect(fake.calls).toHaveLength(0);
    });

    it('PUT refuses a disabled provider with AI_PROVIDER_DISABLED', async () => {
      const res = record(
        await request(server())
          .put('/api/ai/keys/nope')
          .set(authHeader(alice.accessToken))
          .send({ apiKey: USER_KEY_A })
          .expect(403),
      );

      expect(res.body.details.reason).toBe('AI_PROVIDER_DISABLED');
    });

    it('DELETE answers 204 and is idempotent', async () => {
      await request(server()).put('/api/ai/keys/openai').set(authHeader(alice.accessToken)).send({ apiKey: USER_KEY_A });

      await request(server()).delete('/api/ai/keys/openai').set(authHeader(alice.accessToken)).expect(204);
      await request(server()).delete('/api/ai/keys/openai').set(authHeader(alice.accessToken)).expect(204);

      expect(db.keys).toHaveLength(0);
    });

    it('POST test answers 200 even for a rejected key', async () => {
      const res = record(
        await request(server())
          .post('/api/ai/keys/openai/test')
          .set(authHeader(alice.accessToken))
          .send({ apiKey: BAD_KEY })
          .expect(200),
      );

      expect(res.body.data).toMatchObject({ success: false, usedStoredKey: false });
      expect(res.body.data.checks[0]).toMatchObject({ id: 'credentials', code: 'AI_KEY_INVALID' });
    });

    it('POST test with a blank body probes the stored key', async () => {
      await request(server()).put('/api/ai/keys/openai').set(authHeader(alice.accessToken)).send({ apiKey: USER_KEY_A });
      fake.reset();

      const res = record(
        await request(server()).post('/api/ai/keys/openai/test').set(authHeader(alice.accessToken)).send({}).expect(200),
      );

      expect(res.body.data).toMatchObject({ success: true, usedStoredKey: true, reachableModelCount: 3 });
      expect(fake.apiKeys).toEqual([USER_KEY_A]);
    });

    describe("⚠ isolation: user A can never reach user B's key", () => {
      beforeEach(async () => {
        await request(server()).put('/api/ai/keys/openai').set(authHeader(bob.accessToken)).send({ apiKey: USER_KEY_B });
        fake.reset();
      });

      it('A does not see it', async () => {
        const res = record(
          await request(server()).get('/api/ai/keys').set(authHeader(alice.accessToken)).expect(200),
        );
        expect(res.body.data[0].configured).toBe(false);
      });

      it('A cannot test it', async () => {
        const res = record(
          await request(server()).post('/api/ai/keys/openai/test').set(authHeader(alice.accessToken)).send({}).expect(200),
        );
        expect(res.body.data.checks[0].code).toBe('not_configured');
        expect(fake.apiKeys).not.toContain(USER_KEY_B);
      });

      it('A cannot delete it', async () => {
        await request(server()).delete('/api/ai/keys/openai').set(authHeader(alice.accessToken)).expect(204);
        expect(db.keys.map((row) => row.userId)).toEqual([bob.id]);
      });

      it("A's models do not come from B's key", async () => {
        const res = record(
          await request(server()).get('/api/ai/models').set(authHeader(alice.accessToken)).expect(200),
        );
        expect(res.body.data).toEqual([]);
      });
    });
  });

  // ==========================================================================
  // Usable models
  // ==========================================================================

  describe('GET /api/ai/models', () => {
    let alice: TestUser;

    beforeEach(async () => {
      alice = await createMockContributorUser(context);
    });

    it('is enabled ∩ reachable with the user key; deprecated and disabled excluded', async () => {
      await request(server()).put('/api/ai/keys/openai').set(authHeader(alice.accessToken)).send({ apiKey: USER_KEY_A });

      const res = record(
        await request(server()).get('/api/ai/models').set(authHeader(alice.accessToken)).expect(200),
      );

      expect(res.body.data.map((m: { modelId: string }) => m.modelId)).toEqual(['gpt-big', 'gpt-mini']);
      expect(res.body.data[1]).toEqual({
        provider: 'openai',
        modelId: 'gpt-mini',
        displayName: 'GPT mini',
        capabilities: expect.objectContaining({ capabilities: expect.any(Array) }),
        keySource: 'user',
      });
    });

    it('under the org fallback, a keyless user sees every enabled model as keySource org', async () => {
      setPolicy(aiOn({ keyPolicy: 'byok_with_org_fallback' }));
      orgKey = ORG_KEY;

      const res = record(
        await request(server()).get('/api/ai/models').set(authHeader(alice.accessToken)).expect(200),
      );

      expect(res.body.data.map((m: { modelId: string; keySource: string }) => [m.modelId, m.keySource])).toEqual([
        ['gpt-big', 'org'],
        ['gpt-mini', 'org'],
      ]);
    });

    it('under strict byok, a keyless user sees nothing even with an org key stored', async () => {
      orgKey = ORG_KEY;

      const res = record(
        await request(server()).get('/api/ai/models').set(authHeader(alice.accessToken)).expect(200),
      );

      expect(res.body.data).toEqual([]);
      expect(fake.apiKeys).not.toContain(ORG_KEY);
    });
  });

  // ==========================================================================
  // Schema: a user's keys are deleted with the user
  // ==========================================================================

  describe('cascade', () => {
    const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');

    it('the schema relation deletes a user’s keys with the user', () => {
      const schema = readFileSync(join(PRISMA_DIR, 'schema.prisma'), 'utf8');
      const model = schema.slice(schema.indexOf('model UserAiKey {'));
      const body = model.slice(0, model.indexOf('\n}'));

      expect(body).toMatch(
        /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/,
      );
    });

    it('the migration that shipped the table says ON DELETE CASCADE', () => {
      const migrations = join(PRISMA_DIR, 'migrations');
      const sql = readdirSync(migrations)
        .filter((dir) => !dir.endsWith('.toml'))
        .map((dir) => {
          try {
            return readFileSync(join(migrations, dir, 'migration.sql'), 'utf8');
          } catch {
            return '';
          }
        })
        .join('\n');

      expect(sql).toMatch(
        /ALTER TABLE "user_ai_keys" ADD CONSTRAINT "user_ai_keys_user_id_fkey" FOREIGN KEY \("user_id"\) REFERENCES "users"\("id"\) ON DELETE CASCADE/,
      );
    });
  });
});
