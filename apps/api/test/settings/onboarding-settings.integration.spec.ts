// =============================================================================
// `onboarding` user-settings namespace over PATCH /api/user-settings (#203)
// =============================================================================

import request from 'supertest';

import { DEFAULT_USER_SETTINGS } from '../../src/common/types/settings.types';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

const SEEN = '2026-01-01T00:00:00.000Z';
const DISMISSED = '2026-01-02T00:00:00.000Z';

describe('User settings: onboarding namespace (Integration)', () => {
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

  it('stores onboarding and returns it on the response', async () => {
    const user = await createMockTestUser(context);
    arrange(user.id, {});

    const { body } = await patch(user.accessToken, {
      onboarding: { welcomeSeenAt: SEEN, goal: 'strength' },
    }).expect(200);

    expect(body.data.onboarding).toEqual({ welcomeSeenAt: SEEN, goal: 'strength' });
    expect(storedValue().onboarding).toEqual({ welcomeSeenAt: SEEN, goal: 'strength' });
  });

  it('merges shallowly: provided keys change, omitted keys survive', async () => {
    const user = await createMockTestUser(context);
    arrange(user.id, { onboarding: { welcomeSeenAt: SEEN, goal: 'strength' } });

    const { body } = await patch(user.accessToken, {
      onboarding: { checklistDismissedAt: DISMISSED, goal: 'endurance' },
    }).expect(200);

    expect(body.data.onboarding).toEqual({
      welcomeSeenAt: SEEN,
      checklistDismissedAt: DISMISSED,
      goal: 'endurance',
    });
  });

  it('an explicit null clears just that key', async () => {
    const user = await createMockTestUser(context);
    arrange(user.id, { onboarding: { welcomeSeenAt: SEEN, checklistDismissedAt: DISMISSED, goal: 'general' } });

    const { body } = await patch(user.accessToken, { onboarding: { goal: null } }).expect(200);

    expect(body.data.onboarding).toEqual({ welcomeSeenAt: SEEN, checklistDismissedAt: DISMISSED });
    expect(storedValue().onboarding).not.toHaveProperty('goal');
  });

  it('clearing both timestamps (the "Getting started" reset) keeps the goal', async () => {
    const user = await createMockTestUser(context);
    arrange(user.id, { onboarding: { welcomeSeenAt: SEEN, checklistDismissedAt: DISMISSED, goal: 'general' } });

    const { body } = await patch(user.accessToken, {
      onboarding: { welcomeSeenAt: null, checklistDismissedAt: null },
    }).expect(200);

    expect(body.data.onboarding).toEqual({ goal: 'general' });
  });

  it('nulling every key collapses the namespace to absent', async () => {
    const user = await createMockTestUser(context);
    arrange(user.id, { onboarding: { welcomeSeenAt: SEEN } });

    const { body } = await patch(user.accessToken, { onboarding: { welcomeSeenAt: null } }).expect(200);

    expect(body.data).not.toHaveProperty('onboarding');
    expect(storedValue()).not.toHaveProperty('onboarding');
  });

  it('onboarding: null clears the whole namespace', async () => {
    const user = await createMockTestUser(context);
    arrange(user.id, { onboarding: { welcomeSeenAt: SEEN, goal: 'strength' } });

    const { body } = await patch(user.accessToken, { onboarding: null }).expect(200);

    expect(body.data).not.toHaveProperty('onboarding');
    expect(storedValue()).not.toHaveProperty('onboarding');
  });

  it('leaves onboarding untouched when the patch omits it', async () => {
    const user = await createMockTestUser(context);
    arrange(user.id, { onboarding: { goal: 'strength' } });

    const { body } = await patch(user.accessToken, { theme: 'dark' }).expect(200);

    expect(body.data.onboarding).toEqual({ goal: 'strength' });
  });

  describe('validation', () => {
    it.each([
      ['an unknown goal', { goal: 'bulk' }],
      ['custom (not offered by the welcome dialog)', { goal: 'custom' }],
      ['a non-ISO welcomeSeenAt', { welcomeSeenAt: 'yesterday' }],
      ['a date-only checklistDismissedAt', { checklistDismissedAt: '2026-01-01' }],
      ['an unknown key inside onboarding', { goal: 'strength', nickname: 'x' }],
    ])('rejects %s with 400 and writes nothing', async (_name, onboarding) => {
      const user = await createMockTestUser(context);
      arrange(user.id, {});

      await patch(user.accessToken, { onboarding }).expect(400);

      expect(context.prismaMock.userSettings.update).not.toHaveBeenCalled();
    });
  });
});
