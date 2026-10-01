import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AiConfigService } from '../ai/config/ai-config.service';
import { PERMISSIONS } from '../common/constants/roles.constants';
import {
  OnboardingGoal,
  onboardingSettingsSchema,
} from '../common/schemas/user-settings-namespaces.schema';
import { DoctorService } from '../doctor/doctor.service';
import { DoctorCheckReport } from '../doctor/dto/doctor-report.dto';
import { PrismaService } from '../prisma/prisma.service';
import {
  OnboardingAdminBlock,
  OnboardingResponse,
  OnboardingStep,
  OnboardingUserBlock,
} from './dto/onboarding.dto';

// =============================================================================
// OnboardingService — the first-run checklist, derived (#203)
// =============================================================================
//
// READ-ONLY. Nothing here writes: the UI state (`welcomeSeenAt`, ...) is read
// straight from `user_settings` rather than through `UserSettingsService`,
// whose `getSettings` creates a default row on first read. Step completion is
// never stored; it is derived from the data every time.
//
// USER STEPS are cheap existence queries, one per step the caller can perform.
// A step the caller lacks the permission for is omitted, not shown as todo.
//
// ADMIN STEPS reuse the Doctor's checks (its cached, read-only report) rather
// than re-implementing any configuration probe. The one exception is the
// allowlist step, which is a count, not a health check.
// =============================================================================

type UserStepId = 'health_profile' | 'gym' | 'first_workout' | 'ai_plan';

interface UserStepDef {
  id: UserStepId;
  label: string;
  href: string;
}

const USER_STEPS: Record<UserStepId, UserStepDef> = {
  health_profile: {
    id: 'health_profile',
    label: 'Complete your health profile',
    href: '/settings/health-profile',
  },
  gym: { id: 'gym', label: 'Add your gym', href: '/gyms/new' },
  first_workout: {
    id: 'first_workout',
    label: 'Log your first workout',
    href: '/train',
  },
  ai_plan: {
    id: 'ai_plan',
    label: 'Create an AI training plan',
    href: '/train/plans/new',
  },
};

/** Lifting goals put the gym and a workout first; everything else the profile. */
const LIFTING_GOALS: readonly OnboardingGoal[] = ['strength', 'hypertrophy'];

const DEFAULT_ORDER: readonly UserStepId[] = [
  'health_profile',
  'gym',
  'first_workout',
  'ai_plan',
];
const LIFTING_ORDER: readonly UserStepId[] = [
  'gym',
  'first_workout',
  'health_profile',
  'ai_plan',
];

interface AdminDoctorStepDef {
  id: string;
  group: 'required' | 'features';
  label: string;
  href: string;
  /** Doctor check ids; the step is done when every one is `pass`. */
  checks: readonly string[];
}

/** The Doctor categories the admin steps read. */
export const ONBOARDING_DOCTOR_CATEGORIES = [
  'storage',
  'email',
  'ai',
  'push',
  'backup',
] as const;

const STORAGE_STEP: AdminDoctorStepDef = {
  id: 'storage',
  group: 'required',
  label: 'Connect object storage',
  href: '/admin/settings/storage',
  checks: ['storage.config', 'storage.bucket'],
};
const EMAIL_STEP: AdminDoctorStepDef = {
  id: 'email',
  group: 'required',
  label: 'Set up email delivery',
  href: '/admin/settings/email',
  checks: ['email.config'],
};
const FEATURE_STEPS: readonly AdminDoctorStepDef[] = [
  {
    id: 'ai',
    group: 'features',
    label: 'Turn on AI',
    href: '/admin/settings/ai',
    checks: ['ai.enabled', 'ai.providers'],
  },
  {
    id: 'push',
    group: 'features',
    label: 'Enable Web Push',
    href: '/admin/settings/push',
    checks: ['push.vapid'],
  },
  {
    id: 'backup',
    group: 'features',
    label: 'Schedule database backups',
    href: '/admin/settings/db-backup',
    checks: ['backup.schedule'],
  },
];

export interface OnboardingCaller {
  id: string;
  permissions: readonly string[];
}

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly doctor: DoctorService,
    private readonly aiConfig: AiConfigService,
    private readonly config: ConfigService,
  ) {}

  async get(
    caller: OnboardingCaller,
    options: { refresh?: boolean } = {},
  ): Promise<OnboardingResponse> {
    const isAdmin = caller.permissions.includes(
      PERMISSIONS.SYSTEM_SETTINGS_READ,
    );

    const [state, admin] = await Promise.all([
      this.readState(caller.id),
      isAdmin ? this.adminBlock(options.refresh === true) : Promise.resolve(null),
    ]);

    const user = await this.userBlock(caller, state.goal);

    return { ...state, user, admin };
  }

  /** The persisted UI state; nulls when absent or unreadable. Never writes. */
  private async readState(userId: string): Promise<{
    welcomeSeenAt: string | null;
    checklistDismissedAt: string | null;
    goal: OnboardingGoal | null;
  }> {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { value: true },
    });

    const raw = (row?.value as { onboarding?: unknown } | null | undefined)
      ?.onboarding;
    const parsed = onboardingSettingsSchema.safeParse(raw ?? {});
    const value = parsed.success ? parsed.data : {};

    return {
      welcomeSeenAt: value.welcomeSeenAt ?? null,
      checklistDismissedAt: value.checklistDismissedAt ?? null,
      goal: value.goal ?? null,
    };
  }

  private async userBlock(
    caller: OnboardingCaller,
    goal: OnboardingGoal | null,
  ): Promise<OnboardingUserBlock> {
    const has = (permission: string) => caller.permissions.includes(permission);
    const userId = caller.id;

    const checks: Partial<Record<UserStepId, () => Promise<boolean>>> = {};

    if (has(PERMISSIONS.HEALTH_DATA_READ)) {
      // A stored row is a saved profile: the read API reports `version: 0`
      // only when there is none, and the first save creates it at version 1.
      checks.health_profile = async () =>
        (await this.prisma.healthProfile.findUnique({
          where: { userId },
          select: { id: true },
        })) !== null;
    }

    if (has(PERMISSIONS.GYMS_READ)) {
      checks.gym = async () =>
        (await this.prisma.gym.findFirst({
          where: { userId },
          select: { id: true },
        })) !== null;
    }

    if (has(PERMISSIONS.WORKOUTS_READ)) {
      checks.first_workout = async () =>
        (await this.prisma.workout.findFirst({
          where: { userId, status: 'completed' },
          select: { id: true },
        })) !== null;
    }

    if (
      has(PERMISSIONS.AI_USE) &&
      has(PERMISSIONS.PROGRAMS_READ) &&
      (await this.isAiEnabled())
    ) {
      checks.ai_plan = async () =>
        (await this.prisma.program.findFirst({
          where: { userId },
          select: { id: true },
        })) !== null;
    }

    const order =
      goal !== null && LIFTING_GOALS.includes(goal)
        ? LIFTING_ORDER
        : DEFAULT_ORDER;
    const included = order.filter((id) => checks[id] !== undefined);
    const done = await Promise.all(included.map((id) => checks[id]!()));

    const steps: OnboardingStep[] = included.map((id, index) => ({
      id,
      group: null,
      status: done[index] ? 'done' : 'todo',
      label: USER_STEPS[id].label,
      detail: null,
      href: USER_STEPS[id].href,
    }));

    return summarize(steps);
  }

  private async isAiEnabled(): Promise<boolean> {
    try {
      return await this.aiConfig.isEnabled();
    } catch (error) {
      // A broken AI policy read must not take the whole checklist down; the
      // AI step is simply not offered.
      this.logger.warn(
        `AI policy unavailable for onboarding: ${(error as Error).message}`,
      );
      return false;
    }
  }

  private async adminBlock(refresh: boolean): Promise<OnboardingAdminBlock> {
    const [reports, allowlistDone] = await Promise.all([
      Promise.all(
        ONBOARDING_DOCTOR_CATEGORIES.map((category) =>
          this.doctor.run({ category, refresh }),
        ),
      ),
      this.hasInvitedUsers(),
    ]);

    const byId = new Map<string, DoctorCheckReport>();
    for (const report of reports) {
      for (const check of report.checks) byId.set(check.id, check);
    }

    const steps: OnboardingStep[] = [
      doctorStep(STORAGE_STEP, byId),
      doctorStep(EMAIL_STEP, byId),
      {
        id: 'allowlist',
        group: 'required',
        status: allowlistDone ? 'done' : 'todo',
        label: 'Invite your first users',
        detail: null,
        href: '/admin/settings/users',
      },
      ...FEATURE_STEPS.map((def) => doctorStep(def, byId)),
    ];

    const requiredDone = steps
      .filter((step) => step.group === 'required')
      .every((step) => step.status === 'done');

    return { ...summarize(steps), requiredDone };
  }

  /** At least one allowlist entry that is not the bootstrap administrator. */
  private async hasInvitedUsers(): Promise<boolean> {
    const initialAdminEmail = this.config
      .get<string>('INITIAL_ADMIN_EMAIL')
      ?.trim();

    const entry = await this.prisma.allowedEmail.findFirst({
      where: initialAdminEmail
        ? {
            NOT: {
              email: { equals: initialAdminEmail, mode: 'insensitive' },
            },
          }
        : {},
      select: { id: true },
    });

    return entry !== null;
  }
}

function doctorStep(
  def: AdminDoctorStepDef,
  byId: ReadonlyMap<string, DoctorCheckReport>,
): OnboardingStep {
  const reports = def.checks.map((id) => byId.get(id));
  const done = reports.every((report) => report?.status === 'pass');
  const blocking = reports.find(
    (report): report is DoctorCheckReport =>
      report !== undefined && report.status !== 'pass',
  );

  return {
    id: def.id,
    group: def.group,
    status: done ? 'done' : 'todo',
    label: def.label,
    detail: done ? null : (blocking?.remedy ?? blocking?.detail ?? null),
    href: def.href,
  };
}

function summarize(steps: OnboardingStep[]): {
  steps: OnboardingStep[];
  completed: number;
  total: number;
} {
  return {
    steps,
    completed: steps.filter((step) => step.status === 'done').length,
    total: steps.length,
  };
}
