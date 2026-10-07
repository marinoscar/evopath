import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import { AiConfigService } from '../ai-config.service';

export const AI_SETTINGS_PATH = '/admin/settings/ai';

/**
 * `ai` / `ai.enabled` — is the AI platform switched on?
 *
 * OFF IS `skip`, NOT `warn` AND NOT `pass`: turning AI off is an operator's
 * decision (see `doctor-check.interface.ts`, rule 5), so there is nothing to
 * fix — but nothing was verified either. The provider check depends on this
 * one and is skipped with it.
 */
@Injectable()
export class AiEnabledDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'ai.enabled';
  readonly category = 'ai';
  readonly label = 'AI platform';
  readonly settingsPath = AI_SETTINGS_PATH;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly aiConfig: AiConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const policy = await this.aiConfig.resolve({ fresh: true });

    if (!policy.enabled) {
      return { status: 'skip', detail: 'AI is switched off', data: { enabled: false } };
    }

    return { status: 'pass', detail: 'AI is switched on', data: { enabled: true, keyPolicy: policy.keyPolicy } };
  }
}
