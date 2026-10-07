import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import { ActiveVapidConfig, PushConfigService } from '../push-config.service';
import {
  isValidVapidPublicKey,
  isValidVapidSubject,
  privateKeyDerivesPublicKey,
} from '../push-test.service';

export const PUSH_SETTINGS_PATH = '/admin/settings/push';

/**
 * Pure: judges the ACTIVE VAPID key pair with the same helpers the push test
 * uses — minus the send. The private key is only ever passed to
 * `privateKeyDerivesPublicKey`; the outcome carries verdicts, never keys.
 */
export function decidePushVapid(config: ActiveVapidConfig | null): DoctorCheckOutcome {
  if (!config) {
    return {
      status: 'warn',
      detail: 'Web Push is not configured or is switched off; browsers get no push notifications',
      remedy: `Generate a VAPID key pair and enable Web Push at ${PUSH_SETTINGS_PATH}.`,
    };
  }

  const problems: string[] = [];

  if (!isValidVapidPublicKey(config.publicKey)) {
    problems.push('the public key is not a valid P-256 point');
  } else if (!privateKeyDerivesPublicKey(config.privateKey, config.publicKey)) {
    problems.push('the private key does not match the public key');
  }

  if (!isValidVapidSubject(config.subject)) {
    problems.push('the subject is not a mailto: address or an https:// URL');
  }

  if (problems.length > 0) {
    return {
      status: 'fail',
      detail: `The active VAPID configuration is invalid: ${problems.join('; ')}`,
      remedy: `Regenerate the VAPID key pair (or correct the subject) at ${PUSH_SETTINGS_PATH}. Existing browser subscriptions will need to re-subscribe.`,
    };
  }

  return { status: 'pass', detail: 'A valid VAPID key pair and subject are active' };
}

/** `push` / `push.vapid` — Web Push can sign a send. Never sends. */
@Injectable()
export class PushVapidDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'push.vapid';
  readonly category = 'push';
  readonly label = 'Web Push keys';
  readonly settingsPath = PUSH_SETTINGS_PATH;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly pushConfig: PushConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    return decidePushVapid(await this.pushConfig.resolveActiveVapidConfig());
  }
}
