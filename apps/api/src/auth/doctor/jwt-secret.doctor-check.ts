import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DoctorCheck, DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';

/** `jwt.strategy.ts` and `maintenance.module.ts` fall back to this when JWT_SECRET is unset. */
export const JWT_FALLBACK_SECRET = 'fallback-secret';

/** Shorter than this is guessable enough to be worth a warning (256 bits of HS256 key). */
export const JWT_MIN_SECRET_LENGTH = 32;

const REMEDY =
  'Set JWT_SECRET to a random value of at least 32 characters (e.g. `openssl rand -base64 48`) ' +
  'and restart the API. Every signed-in user will have to sign in again.';

/** Pure: judges the configured secret. Reports its LENGTH only, never its value. */
export function decideJwtSecret(secret: string | undefined | null): DoctorCheckOutcome {
  if (!secret || secret === JWT_FALLBACK_SECRET) {
    return {
      status: 'fail',
      detail: 'JWT_SECRET is not set; tokens are signed with a publicly known fallback key',
      remedy: REMEDY,
    };
  }

  if (secret.length < JWT_MIN_SECRET_LENGTH) {
    return {
      status: 'warn',
      detail: `JWT_SECRET is only ${secret.length} characters long`,
      remedy: REMEDY,
      data: { length: secret.length },
    };
  }

  return { status: 'pass', detail: 'JWT_SECRET is set and long enough', data: { length: secret.length } };
}

/** `auth` / `auth.jwt-secret` — the access-token signing key is real. */
@Injectable()
export class JwtSecretDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'auth.jwt-secret';
  readonly category = 'auth';
  readonly label = 'JWT signing secret';

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    return decideJwtSecret(this.config.get<string>('jwt.secret'));
  }
}
