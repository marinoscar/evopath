import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import { AiConfigAdminService } from '../ai-config-admin.service';
import { AiConfigResponse } from '../dto/ai-config-response.dto';
import { AI_SETTINGS_PATH } from './ai-enabled.doctor-check';

/**
 * Pure: can every ENABLED provider actually serve a call?
 *
 *   - enabled but no adapter registered → it can never serve one;
 *   - enabled, needs a key, no org key, and the policy promises an org-key
 *     fallback (`byok_with_org_fallback`) → users without their own key fail;
 *   - under plain `byok` a missing org key is expected — users bring keys.
 *
 * Reads key STATUS only (`keyStatus.configured`), never a hint or material,
 * and calls no model: the "Test" button at /admin/settings/ai does that.
 */
export function decideAiProviders(view: Pick<AiConfigResponse, 'keyPolicy' | 'providers'>): DoctorCheckOutcome {
  const enabled = view.providers.filter((p) => p.enabled);
  const data = { enabledProviders: enabled.length, keyPolicy: view.keyPolicy };

  if (enabled.length === 0) {
    return {
      status: 'fail',
      detail: 'AI is on, but no provider is enabled; every AI call will fail',
      remedy: `Enable a provider and save its key at ${AI_SETTINGS_PATH}, or switch AI off there.`,
      data,
    };
  }

  const problems: string[] = [];

  for (const provider of enabled) {
    if (!provider.registered) {
      problems.push(`${provider.displayName}: no adapter is available in this build`);
      continue;
    }

    const needsKey = provider.requiresKey !== false;

    if (needsKey && !provider.keyStatus.configured && view.keyPolicy === 'byok_with_org_fallback') {
      problems.push(`${provider.displayName}: no organization key, but the key policy promises a fallback`);
    }
  }

  if (problems.length > 0) {
    return {
      status: 'fail',
      detail: problems.join('; '),
      remedy: `Save an organization key for each enabled provider at ${AI_SETTINGS_PATH}, or disable the provider there.`,
      data,
    };
  }

  const names = enabled.map((p) =>
    p.requiresKey === false
      ? `${p.displayName} (no key needed)`
      : p.keyStatus.configured
        ? `${p.displayName} (org key)`
        : `${p.displayName} (users' own keys)`,
  );

  return { status: 'pass', detail: `Enabled: ${names.join(', ')}`, data };
}

/** `ai` / `ai.providers` — every enabled provider has what it needs to serve a call. */
@Injectable()
export class AiProvidersDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'ai.providers';
  readonly category = 'ai';
  readonly label = 'AI providers and keys';
  readonly settingsPath = AI_SETTINGS_PATH;
  readonly dependsOn = ['ai.enabled'];

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly aiAdmin: AiConfigAdminService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    return decideAiProviders(await this.aiAdmin.describeForAdmin());
  }
}
