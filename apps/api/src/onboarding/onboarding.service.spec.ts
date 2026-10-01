import { PERMISSIONS } from '../common/constants/roles.constants';
import { DoctorCheckReport } from '../doctor/dto/doctor-report.dto';
import { OnboardingService } from './onboarding.service';

// =============================================================================
// OnboardingService (#203): derived checklist, read-only
// =============================================================================

const P = PERMISSIONS;

const VIEWER = [P.USER_SETTINGS_READ, P.HEALTH_DATA_READ, P.GYMS_READ, P.WORKOUTS_READ];
const CONTRIBUTOR = [...VIEWER, P.AI_USE, P.PROGRAMS_READ];
const ADMIN = [...CONTRIBUTOR, P.SYSTEM_SETTINGS_READ];

function check(id: string, status: DoctorCheckReport['status'], extra: Partial<DoctorCheckReport> = {}): DoctorCheckReport {
  return {
    id,
    category: id.split('.')[0],
    label: id,
    settingsPath: null,
    status,
    detail: `${id} detail`,
    remedy: null,
    error: null,
    data: null,
    durationMs: 1,
    ...extra,
  };
}

const ALL_CHECK_IDS = [
  'storage.config',
  'storage.bucket',
  'email.config',
  'ai.enabled',
  'ai.providers',
  'push.vapid',
  'backup.schedule',
];

describe('OnboardingService', () => {
  let prisma: any;
  let doctor: { run: jest.Mock };
  let aiConfig: { isEnabled: jest.Mock };
  let config: { get: jest.Mock };
  let service: OnboardingService;
  let doctorChecks: Record<string, DoctorCheckReport>;

  beforeEach(() => {
    prisma = {
      userSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      healthProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      gym: { findFirst: jest.fn().mockResolvedValue(null) },
      workout: { findFirst: jest.fn().mockResolvedValue(null) },
      program: { findFirst: jest.fn().mockResolvedValue(null) },
      allowedEmail: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    doctorChecks = Object.fromEntries(ALL_CHECK_IDS.map((id) => [id, check(id, 'pass')]));
    doctor = {
      run: jest.fn(async ({ category }: { category: string }) => ({
        verdict: 'pass',
        generatedAt: new Date().toISOString(),
        durationMs: 1,
        checks: Object.values(doctorChecks).filter((c) => c.category === category),
      })),
    };
    aiConfig = { isEnabled: jest.fn().mockResolvedValue(true) };
    config = { get: jest.fn().mockReturnValue(undefined) };
    service = new OnboardingService(prisma, doctor as any, aiConfig as any, config as any);
  });

  const ids = (block: { steps: { id: string }[] }) => block.steps.map((s) => s.id);
  const adminStep = async (id: string) => {
    const res = await service.get({ id: 'u1', permissions: ADMIN });
    return res.admin!.steps.find((s) => s.id === id)!;
  };

  describe('user steps by permission', () => {
    it('a viewer has no ai_plan', async () => {
      const res = await service.get({ id: 'u1', permissions: VIEWER });

      expect(ids(res.user)).toEqual(['health_profile', 'gym', 'first_workout']);
    });

    it('a contributor with AI on gets ai_plan', async () => {
      const res = await service.get({ id: 'u1', permissions: CONTRIBUTOR });

      expect(ids(res.user)).toEqual(['health_profile', 'gym', 'first_workout', 'ai_plan']);
    });

    it('with AI off there is no ai_plan', async () => {
      aiConfig.isEnabled.mockResolvedValue(false);

      const res = await service.get({ id: 'u1', permissions: CONTRIBUTOR });

      expect(ids(res.user)).not.toContain('ai_plan');
    });

    it('ai_plan needs both ai:use and programs:read', async () => {
      const noPrograms = await service.get({ id: 'u1', permissions: [...VIEWER, P.AI_USE] });
      const noAiUse = await service.get({ id: 'u1', permissions: [...VIEWER, P.PROGRAMS_READ] });

      expect(ids(noPrograms.user)).not.toContain('ai_plan');
      expect(ids(noAiUse.user)).not.toContain('ai_plan');
    });

    it('omits a step whose permission is missing rather than showing it as todo', async () => {
      const res = await service.get({ id: 'u1', permissions: [P.USER_SETTINGS_READ, P.GYMS_READ] });

      expect(ids(res.user)).toEqual(['gym']);
      expect(prisma.healthProfile.findUnique).not.toHaveBeenCalled();
      expect(prisma.workout.findFirst).not.toHaveBeenCalled();
    });

    it('carries label, href, null group and null detail', async () => {
      const res = await service.get({ id: 'u1', permissions: CONTRIBUTOR });

      expect(res.user.steps).toEqual([
        { id: 'health_profile', group: null, status: 'todo', label: 'Complete your health profile', detail: null, href: '/settings/health-profile' },
        { id: 'gym', group: null, status: 'todo', label: 'Add your gym', detail: null, href: '/gyms/new' },
        { id: 'first_workout', group: null, status: 'todo', label: 'Log your first workout', detail: null, href: '/train' },
        { id: 'ai_plan', group: null, status: 'todo', label: 'Create an AI training plan', detail: null, href: '/train/plans/new' },
      ]);
    });
  });

  describe('goal ordering', () => {
    const withGoal = (goal: string | undefined) =>
      prisma.userSettings.findUnique.mockResolvedValue({ value: goal ? { onboarding: { goal } } : {} });

    it.each(['strength', 'hypertrophy'])('%s puts gym and first_workout before health_profile', async (goal) => {
      withGoal(goal);

      const res = await service.get({ id: 'u1', permissions: CONTRIBUTOR });

      expect(res.goal).toBe(goal);
      expect(ids(res.user)).toEqual(['gym', 'first_workout', 'health_profile', 'ai_plan']);
    });

    it.each(['fat_loss', 'endurance', 'general'])('%s keeps the default order', async (goal) => {
      withGoal(goal);

      const res = await service.get({ id: 'u1', permissions: CONTRIBUTOR });

      expect(ids(res.user)).toEqual(['health_profile', 'gym', 'first_workout', 'ai_plan']);
    });

    it('a null goal keeps the default order', async () => {
      withGoal(undefined);

      const res = await service.get({ id: 'u1', permissions: CONTRIBUTOR });

      expect(res.goal).toBeNull();
      expect(ids(res.user)).toEqual(['health_profile', 'gym', 'first_workout', 'ai_plan']);
    });
  });

  describe('done / todo derivation', () => {
    it('marks each step done from its own data and counts them', async () => {
      prisma.healthProfile.findUnique.mockResolvedValue({ id: 'hp' });
      prisma.gym.findFirst.mockResolvedValue({ id: 'g' });

      const res = await service.get({ id: 'u1', permissions: CONTRIBUTOR });

      expect(res.user.steps.map((s) => [s.id, s.status])).toEqual([
        ['health_profile', 'done'],
        ['gym', 'done'],
        ['first_workout', 'todo'],
        ['ai_plan', 'todo'],
      ]);
      expect(res.user.completed).toBe(2);
      expect(res.user.total).toBe(4);
    });

    it('queries only completed workouts, scoped to the caller', async () => {
      await service.get({ id: 'u1', permissions: VIEWER });

      expect(prisma.workout.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u1', status: 'completed' } }),
      );
      expect(prisma.gym.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1' } }));
    });

    it('ai_plan is done once the user has a program and the coach is switched off system-wide', async () => {
      const systemSettings = { getCoachPolicy: jest.fn().mockResolvedValue({ enabled: false }) };
      service = new OnboardingService(prisma, doctor as any, aiConfig as any, config as any, systemSettings as any);
      prisma.program.findFirst.mockResolvedValue({ id: 'p' });

      const res = await service.get({ id: 'u1', permissions: CONTRIBUTOR });

      expect(res.user.steps.find((s) => s.id === 'ai_plan')).toMatchObject({
        status: 'done',
        label: 'Create an AI training plan',
        href: '/train/plans/new',
      });
    });
  });

  // E7.12: the `ai_plan` step becomes "Meet your coach" once a plan exists
  // (no fifth step), and is done once the coach settings were saved.
  describe('ai_plan -> Meet your coach (E7.12)', () => {
    let systemSettings: { getCoachPolicy: jest.Mock };
    const aiPlan = (res: { user: { steps: Array<{ id: string }> } }) =>
      res.user.steps.find((s) => s.id === 'ai_plan') as Record<string, unknown> | undefined;

    beforeEach(() => {
      systemSettings = { getCoachPolicy: jest.fn().mockResolvedValue({ enabled: true }) };
      service = new OnboardingService(prisma, doctor as any, aiConfig as any, config as any, systemSettings as any);
    });

    it('without a program: "Create an AI training plan", todo, linking to /train/plans/new as before', async () => {
      prisma.userSettings.findUnique.mockResolvedValue({ value: { coach: { personaId: 'coach' } } });

      const res = await service.get({ id: 'u1', permissions: CONTRIBUTOR });

      expect(aiPlan(res)).toEqual({
        id: 'ai_plan',
        group: null,
        status: 'todo',
        label: 'Create an AI training plan',
        detail: null,
        href: '/train/plans/new',
      });
    });

    it('with a program and no saved coach settings: "Meet your coach", todo, linking to /settings/coach', async () => {
      prisma.program.findFirst.mockResolvedValue({ id: 'p' });
      prisma.userSettings.findUnique.mockResolvedValue({ value: { onboarding: { goal: 'general' } } });

      const res = await service.get({ id: 'u1', permissions: CONTRIBUTOR });

      expect(aiPlan(res)).toEqual({
        id: 'ai_plan',
        group: null,
        status: 'todo',
        label: 'Meet your coach',
        detail: null,
        href: '/settings/coach',
      });
      expect(res.user.total).toBeLessThanOrEqual(4);
      expect(res.user.completed).toBe(0);
    });

    it('with a program and saved coach settings: "Meet your coach", done', async () => {
      prisma.program.findFirst.mockResolvedValue({ id: 'p' });
      prisma.userSettings.findUnique.mockResolvedValue({ value: { coach: { personaId: 'stoic', enabled: true } } });

      const res = await service.get({ id: 'u1', permissions: CONTRIBUTOR });

      expect(aiPlan(res)).toMatchObject({ status: 'done', label: 'Meet your coach', href: '/settings/coach' });
      expect(res.user.completed).toBe(1);
    });

    it('a malformed coach namespace (not an object) is not a save', async () => {
      prisma.program.findFirst.mockResolvedValue({ id: 'p' });
      prisma.userSettings.findUnique.mockResolvedValue({ value: { coach: 'yes' } });

      const res = await service.get({ id: 'u1', permissions: CONTRIBUTOR });

      expect(aiPlan(res)).toMatchObject({ status: 'todo', label: 'Meet your coach' });
    });

    it('is omitted with AI off, without ai:use, or without programs:read, whatever is stored', async () => {
      prisma.program.findFirst.mockResolvedValue({ id: 'p' });
      prisma.userSettings.findUnique.mockResolvedValue({ value: { coach: { personaId: 'coach' } } });

      const noAiUse = await service.get({ id: 'u1', permissions: [...VIEWER, P.PROGRAMS_READ] });
      const noPrograms = await service.get({ id: 'u1', permissions: [...VIEWER, P.AI_USE] });
      aiConfig.isEnabled.mockResolvedValue(false);
      const aiOff = await service.get({ id: 'u1', permissions: CONTRIBUTOR });

      for (const res of [noAiUse, noPrograms, aiOff]) {
        expect(aiPlan(res)).toBeUndefined();
        expect(res.user.steps.map((s) => s.label)).not.toContain('Meet your coach');
      }
      expect(systemSettings.getCoachPolicy).not.toHaveBeenCalled();
    });

    it('a failed coach policy read keeps the plain step (done on a program)', async () => {
      systemSettings.getCoachPolicy.mockRejectedValue(new Error('db down'));
      prisma.program.findFirst.mockResolvedValue({ id: 'p' });

      const res = await service.get({ id: 'u1', permissions: CONTRIBUTOR });

      expect(aiPlan(res)).toMatchObject({ status: 'done', label: 'Create an AI training plan' });
    });

    it.each(['strength', 'general'])('never exceeds four user steps (goal %s), with every step done', async (goal) => {
      prisma.program.findFirst.mockResolvedValue({ id: 'p' });
      prisma.healthProfile.findUnique.mockResolvedValue({ id: 'h' });
      prisma.gym.findFirst.mockResolvedValue({ id: 'g' });
      prisma.workout.findFirst.mockResolvedValue({ id: 'w' });
      prisma.userSettings.findUnique.mockResolvedValue({ value: { onboarding: { goal }, coach: { personaId: 'coach' } } });

      const res = await service.get({ id: 'u1', permissions: ADMIN });

      expect(res.user.steps).toHaveLength(4);
      expect(new Set(ids(res.user)).size).toBe(4);
      expect(res.user).toMatchObject({ completed: 4, total: 4 });
    });

    it('stays read-only: the coach namespace is read from the same user_settings select', async () => {
      prisma.program.findFirst.mockResolvedValue({ id: 'p' });

      await service.get({ id: 'u1', permissions: CONTRIBUTOR });

      expect(prisma.userSettings.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.userSettings.findUnique).toHaveBeenCalledWith({ where: { userId: 'u1' }, select: { value: true } });
      const writes = ['create', 'update', 'upsert', 'delete'];
      for (const model of Object.values(prisma) as Array<Record<string, unknown>>) {
        for (const w of writes) expect(model[w]).toBeUndefined();
      }
    });
  });

  describe('stored UI state', () => {
    it('returns the stored timestamps and goal', async () => {
      prisma.userSettings.findUnique.mockResolvedValue({
        value: {
          onboarding: {
            welcomeSeenAt: '2026-01-01T00:00:00.000Z',
            checklistDismissedAt: '2026-01-02T00:00:00.000Z',
            goal: 'strength',
          },
        },
      });

      const res = await service.get({ id: 'u1', permissions: VIEWER });

      expect(res).toMatchObject({
        welcomeSeenAt: '2026-01-01T00:00:00.000Z',
        checklistDismissedAt: '2026-01-02T00:00:00.000Z',
        goal: 'strength',
      });
    });

    it('returns nulls when there is no settings row', async () => {
      const res = await service.get({ id: 'u1', permissions: VIEWER });

      expect(res).toMatchObject({ welcomeSeenAt: null, checklistDismissedAt: null, goal: null });
    });

    it.each([
      ['an unknown goal', { goal: 'bulk' }],
      ['a non-ISO datetime', { welcomeSeenAt: 'yesterday' }],
      ['an unknown key', { goal: 'strength', extra: 1 }],
      ['a non-object', 'nope'],
    ])('invalid stored onboarding (%s) yields nulls, not an error', async (_name, onboarding) => {
      prisma.userSettings.findUnique.mockResolvedValue({ value: { onboarding } });

      const res = await service.get({ id: 'u1', permissions: CONTRIBUTOR });

      expect(res).toMatchObject({ welcomeSeenAt: null, checklistDismissedAt: null, goal: null });
      expect(ids(res.user)).toEqual(['health_profile', 'gym', 'first_workout', 'ai_plan']);
    });
  });

  describe('AI policy failure', () => {
    it('omits ai_plan and still answers when isEnabled throws', async () => {
      aiConfig.isEnabled.mockRejectedValue(new Error('policy read failed'));

      const res = await service.get({ id: 'u1', permissions: CONTRIBUTOR });

      expect(ids(res.user)).toEqual(['health_profile', 'gym', 'first_workout']);
    });
  });

  describe('admin block', () => {
    it('is null without system_settings:read and never calls the Doctor', async () => {
      const res = await service.get({ id: 'u1', permissions: CONTRIBUTOR });

      expect(res.admin).toBeNull();
      expect(doctor.run).not.toHaveBeenCalled();
      expect(prisma.allowedEmail.findFirst).not.toHaveBeenCalled();
    });

    it('is non-null for system_settings:read, with required steps first then features', async () => {
      prisma.allowedEmail.findFirst.mockResolvedValue({ id: 'a' });

      const res = await service.get({ id: 'u1', permissions: ADMIN });

      expect(res.admin!.steps.map((s) => [s.id, s.group, s.href])).toEqual([
        ['storage', 'required', '/admin/settings/storage'],
        ['email', 'required', '/admin/settings/email'],
        ['allowlist', 'required', '/admin/settings/users'],
        ['ai', 'features', '/admin/settings/ai'],
        ['push', 'features', '/admin/settings/push'],
        ['backup', 'features', '/admin/settings/db-backup'],
      ]);
      expect(res.admin!.completed).toBe(6);
      expect(res.admin!.total).toBe(6);
    });

    it('is done only when every mapped check passes', async () => {
      doctorChecks['storage.bucket'] = check('storage.bucket', 'warn');

      expect((await adminStep('storage')).status).toBe('todo');

      doctorChecks['storage.bucket'] = check('storage.bucket', 'pass');
      expect((await adminStep('storage')).status).toBe('done');
    });

    it.each(['warn', 'fail', 'skip'] as const)('a %s check is not done', async (status) => {
      doctorChecks['email.config'] = check('email.config', status);

      expect((await adminStep('email')).status).toBe('todo');
    });

    it('detail is the remedy of the first non-pass check', async () => {
      doctorChecks['ai.enabled'] = check('ai.enabled', 'fail', { remedy: 'Switch AI on', detail: 'AI is off' });
      doctorChecks['ai.providers'] = check('ai.providers', 'fail', { remedy: 'Add a provider' });

      expect((await adminStep('ai')).detail).toBe('Switch AI on');
    });

    it('detail falls back to the check detail when there is no remedy', async () => {
      doctorChecks['storage.config'] = check('storage.config', 'skip', { remedy: null, detail: 'Storage is not configured' });

      expect((await adminStep('storage')).detail).toBe('Storage is not configured');
    });

    it('detail skips passing checks to find the first non-pass one', async () => {
      doctorChecks['ai.enabled'] = check('ai.enabled', 'pass', { detail: 'fine' });
      doctorChecks['ai.providers'] = check('ai.providers', 'warn', { remedy: 'Add a provider' });

      expect((await adminStep('ai')).detail).toBe('Add a provider');
    });

    it('detail is null on a done step', async () => {
      expect((await adminStep('push')).detail).toBeNull();
    });

    it('a mapped check missing from the report makes the step todo', async () => {
      delete doctorChecks['storage.bucket'];

      const step = await adminStep('storage');

      expect(step.status).toBe('todo');
      // Only the present (passing) check is available, so there is nothing to explain.
      expect(step.detail).toBeNull();
    });

    it('a step with no report at all is todo', async () => {
      delete doctorChecks['backup.schedule'];

      expect((await adminStep('backup')).status).toBe('todo');
    });

    it('asks the Doctor for each category and forwards refresh', async () => {
      await service.get({ id: 'u1', permissions: ADMIN }, { refresh: true });

      const categories = doctor.run.mock.calls.map(([arg]) => arg.category).sort();
      expect(categories).toEqual(['ai', 'backup', 'email', 'push', 'storage']);
      for (const [arg] of doctor.run.mock.calls) expect(arg.refresh).toBe(true);
    });

    it('does not refresh by default', async () => {
      await service.get({ id: 'u1', permissions: ADMIN });

      for (const [arg] of doctor.run.mock.calls) expect(arg.refresh).toBe(false);
    });
  });

  describe('allowlist step', () => {
    it('excludes INITIAL_ADMIN_EMAIL case-insensitively', async () => {
      config.get.mockImplementation((key: string) => (key === 'INITIAL_ADMIN_EMAIL' ? ' Admin@Example.com ' : undefined));

      await service.get({ id: 'u1', permissions: ADMIN });

      expect(prisma.allowedEmail.findFirst).toHaveBeenCalledWith({
        where: { NOT: { email: { equals: 'Admin@Example.com', mode: 'insensitive' } } },
        select: { id: true },
      });
    });

    it('counts any entry when no initial admin email is configured', async () => {
      await service.get({ id: 'u1', permissions: ADMIN });

      expect(prisma.allowedEmail.findFirst).toHaveBeenCalledWith({ where: {}, select: { id: true } });
    });

    it('is todo with no other entries and done with one', async () => {
      expect((await adminStep('allowlist')).status).toBe('todo');

      prisma.allowedEmail.findFirst.mockResolvedValue({ id: 'a' });

      expect((await adminStep('allowlist')).status).toBe('done');
    });
  });

  describe('requiredDone', () => {
    it('is true when storage, email and allowlist are done, regardless of features', async () => {
      prisma.allowedEmail.findFirst.mockResolvedValue({ id: 'a' });
      doctorChecks['ai.enabled'] = check('ai.enabled', 'fail');
      doctorChecks['push.vapid'] = check('push.vapid', 'skip');

      const res = await service.get({ id: 'u1', permissions: ADMIN });

      expect(res.admin!.requiredDone).toBe(true);
      expect(res.admin!.completed).toBeLessThan(res.admin!.total);
    });

    it.each([
      ['storage', () => (doctorChecks['storage.config'] = check('storage.config', 'fail'))],
      ['email', () => (doctorChecks['email.config'] = check('email.config', 'warn'))],
      ['allowlist', () => prisma.allowedEmail.findFirst.mockResolvedValue(null)],
    ])('is false when %s is todo', async (_name, breakIt) => {
      prisma.allowedEmail.findFirst.mockResolvedValue({ id: 'a' });
      breakIt();

      const res = await service.get({ id: 'u1', permissions: ADMIN });

      expect(res.admin!.requiredDone).toBe(false);
    });
  });

  describe('read-only', () => {
    it('never creates, updates, upserts or deletes anything', async () => {
      prisma.allowedEmail.findFirst.mockResolvedValue({ id: 'a' });

      await service.get({ id: 'u1', permissions: ADMIN }, { refresh: true });

      const writes = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'];
      for (const [model, delegate] of Object.entries<any>(prisma)) {
        for (const method of writes) {
          expect(`${model}.${method}: ${delegate[method]?.mock?.calls?.length ?? 0}`).toBe(`${model}.${method}: 0`);
        }
      }
    });

    it('has no write method on the mocked client at all (a write would throw)', async () => {
      await expect(service.get({ id: 'u1', permissions: ADMIN })).resolves.toBeDefined();
      expect(prisma.userSettings.create).toBeUndefined();
    });
  });
});
