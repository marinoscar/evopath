import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ROLES } from '../../common/constants/roles.constants';
import { DoctorCheck, DoctorCheckOutcome } from '../../doctor/doctor-check.interface';
import { DoctorCheckRegistry } from '../../doctor/doctor-check.registry';
import { PrismaService } from '../../prisma/prisma.service';

/** Pure: judges the bootstrap variable and the number of active admins. */
export function decideInitialAdmin(input: { initialAdminEmailSet: boolean; activeAdmins: number }): DoctorCheckOutcome {
  const data = { activeAdmins: input.activeAdmins, initialAdminEmailSet: input.initialAdminEmailSet };

  if (input.activeAdmins === 0) {
    return {
      status: 'fail',
      detail: 'No active user holds the Admin role',
      remedy: input.initialAdminEmailSet
        ? 'Sign in with the INITIAL_ADMIN_EMAIL account; it is granted Admin on sign-in.'
        : 'Set INITIAL_ADMIN_EMAIL to your email address, restart the API and sign in with that account.',
      data,
    };
  }

  if (!input.initialAdminEmailSet) {
    return {
      status: 'warn',
      detail: `${input.activeAdmins} active admin(s), but INITIAL_ADMIN_EMAIL is not set`,
      remedy:
        'Set INITIAL_ADMIN_EMAIL so there is always a way back in: that account bypasses the ' +
        'allowlist and is granted Admin on sign-in.',
      data,
    };
  }

  return { status: 'pass', detail: `${input.activeAdmins} active admin(s)`, data };
}

/** `auth` / `auth.initial-admin` — somebody can administer this deployment. */
@Injectable()
export class InitialAdminDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'auth.initial-admin';
  readonly category = 'auth';
  readonly label = 'Administrator access';
  readonly settingsPath = '/admin/settings/users';
  readonly dependsOn = ['db.connection'];

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const email = this.config.get<string>('INITIAL_ADMIN_EMAIL');
    const activeAdmins = await this.prisma.user.count({
      where: { isActive: true, userRoles: { some: { role: { name: ROLES.ADMIN } } } },
    });

    return decideInitialAdmin({
      initialAdminEmailSet: typeof email === 'string' && email.trim() !== '',
      activeAdmins: Number(activeAdmins ?? 0),
    });
  }
}
