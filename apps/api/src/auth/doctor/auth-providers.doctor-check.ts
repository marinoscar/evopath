import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '../../doctor/doctor-check.interface';
import { DoctorCheckRegistry } from '../../doctor/doctor-check.registry';
import { AuthService } from '../auth.service';

/**
 * `auth` / `auth.providers` — at least one sign-in provider is configured.
 *
 * Asks `AuthService.getEnabledProviders()`, the same list the sign-in page
 * renders, so the doctor cannot disagree with what a user actually sees.
 */
@Injectable()
export class AuthProvidersDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'auth.providers';
  readonly category = 'auth';
  readonly label = 'Sign-in providers';

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly auth: AuthService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const providers = (await this.auth.getEnabledProviders()).filter((p) => p.enabled);

    if (providers.length === 0) {
      return {
        status: 'fail',
        detail: 'No sign-in provider is configured; nobody can sign in',
        remedy:
          'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_CALLBACK_URL (see ' +
          'infra/compose/.env.example) and restart the API.',
        data: { providers: 0 },
      };
    }

    return {
      status: 'pass',
      detail: `Enabled: ${providers.map((p) => p.name).join(', ')}`,
      data: { providers: providers.length },
    };
  }
}
