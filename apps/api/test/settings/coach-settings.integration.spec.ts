// =============================================================================
// `coach` user-settings namespace over PATCH /api/user-settings (E7.1, #241)
// =============================================================================

import request from 'supertest';

import { DEFAULT_USER_SETTINGS } from '../../src/common/types/settings.types';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

describe('User settings: coach namespace (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
  });

  /** Stores `stored` as the current row; `update` echoes what the service wrote. */
  function arrange(userId: string, stored: Record<string, unknown>) {
    const p = context.prismaMock;
    p.userSettings.findUnique.mockResolvedValue({
      id: `settings-${userId}`,
      userId,
      value: { ...DEFAULT_USER_SETTINGS, ...stored },
      version: 1,
      updatedAt: new Date(),
    });
    p.userSettings.update.mockImplementation(async ({ data }: any) => ({
      id: `settings-${userId}`,
      userId,
      value: data.value,
      version: 2,
      updatedAt: new Date(),
    }));
  }

  const patch = (token: string, body: unknown) =>
    request(context.app.getHttpServer()).patch('/api/user-settings').set(authHeader(token)).send(body as object);

  const storedValue = () => context.prismaMock.userSettings.update.mock.calls[0][0].data.value;

  it('is absent, not defaulted, for a user who never stored it', async () => {
    const user = await createMockTestUser(context);
    arrange(user.id, {});

    const { body } = await request(context.app.getHttpServer())
      .get('/api/user-settings')
      .set(authHeader(user.accessToken))
      .expect(200);

    expect(body.data).not.toHaveProperty('coach');
  });

  it('stores coach sparsely and returns it on the response', async () => {
    const user = await createMockTestUser(context);
    arrange(user.id, {});

    const { body } = await patch(user.accessToken, {
      coach: { enabled: true, personaId: 'coach', audio: { speed: 1.25 } },
    }).expect(200);

    expect(body.data.coach).toEqual({ enabled: true, personaId: 'coach', audio: { speed: 1.25 } });
    expect(storedValue().coach).toEqual({ enabled: true, personaId: 'coach', audio: { speed: 1.25 } });
  });

  it('merges audio field by field and null clears a field', async () => {
    const user = await createMockTestUser(context);
    arrange(user.id, { coach: { enabled: true, why: 'my kids', audio: { enabled: true, voice: 'alloy' } } });

    const { body } = await patch(user.accessToken, { coach: { why: null, audio: { speed: 0.9 } } }).expect(200);

    expect(body.data.coach).toEqual({ enabled: true, audio: { enabled: true, voice: 'alloy', speed: 0.9 } });
  });

  it('coach: null clears the whole namespace', async () => {
    const user = await createMockTestUser(context);
    arrange(user.id, { coach: { enabled: true } });

    const { body } = await patch(user.accessToken, { coach: null }).expect(200);

    expect(body.data).not.toHaveProperty('coach');
    expect(storedValue()).not.toHaveProperty('coach');
  });

  describe('validation', () => {
    it.each([
      ['intensity 4', { intensity: 4 }],
      ['maxNudgesPerDay 5', { maxNudgesPerDay: 5 }],
      ['audio speed 2', { audio: { speed: 2 } }],
      ['quiet hours not HH:mm', { quietHours: { start: '9pm' } }],
      ['why over 200 characters', { why: 'x'.repeat(201) }],
      ['an unknown key inside coach', { enabled: true, mood: 'grumpy' }],
      ['an unknown key inside audio', { audio: { volume: 11 } }],
    ])('rejects %s with 400 and writes nothing', async (_name, coach) => {
      const user = await createMockTestUser(context);
      arrange(user.id, {});

      await patch(user.accessToken, { coach }).expect(400);

      expect(context.prismaMock.userSettings.update).not.toHaveBeenCalled();
    });
  });
});
