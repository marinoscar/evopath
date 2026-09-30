import { Injectable, OnModuleInit } from '@nestjs/common';

import { DoctorCheck, DoctorCheckOutcome } from '../../doctor/doctor-check.interface';
import { DoctorCheckRegistry } from '../../doctor/doctor-check.registry';
import { EmailSettingsAdminView, EmailSettingsService } from '../email-settings.service';
import { DEFAULT_SMTP_PORT } from '../email-settings.schema';

export const EMAIL_SETTINGS_PATH = '/admin/settings/email';

const REMEDY_OPEN = `Complete the email settings at ${EMAIL_SETTINGS_PATH}, then use "Send test email" there.`;

/**
 * Pure: judges the admin view of the email settings.
 *
 * The view carries credential STATUS (configured or not), never material —
 * `describeForAdmin` does not select the ciphertext — so nothing here can leak
 * a password. The access key id is not reported either.
 */
export function decideEmailConfig(view: EmailSettingsAdminView): DoctorCheckOutcome {
  if (view.settingsError) {
    return { status: 'fail', detail: view.settingsError, remedy: REMEDY_OPEN };
  }

  if (!view.provider) {
    return {
      status: 'warn',
      detail: 'Email is not configured; notifications are delivered in-app only',
      remedy: `Choose SMTP or Amazon SES at ${EMAIL_SETTINGS_PATH}.`,
    };
  }

  const missing: string[] = [];

  if (!view.fromAddress) missing.push('from address');

  if (view.provider === 'smtp') {
    if (!view.smtpHost) missing.push('SMTP host');
    if (view.smtpUsername && !view.smtpPasswordStatus.configured) missing.push('SMTP password');
  } else {
    if (!view.sesRegion) missing.push('SES region');
    if (view.sesAccessKeyId && !view.sesSecretAccessKeyStatus.configured) missing.push('SES secret access key');
  }

  const data = { provider: view.provider, enabled: view.enabled };

  if (missing.length > 0) {
    return {
      status: 'fail',
      detail: `Email (${view.provider}) is missing: ${missing.join(', ')}`,
      remedy: REMEDY_OPEN,
      data,
    };
  }

  const via =
    view.provider === 'smtp'
      ? `SMTP via ${view.smtpHost}:${view.smtpPort ?? DEFAULT_SMTP_PORT}`
      : `Amazon SES in ${view.sesRegion}`;

  if (!view.enabled) {
    return {
      status: 'warn',
      detail: `${via} is configured but switched off; no email is sent`,
      remedy: `Turn email on at ${EMAIL_SETTINGS_PATH} when it should be delivered.`,
      data,
    };
  }

  return { status: 'pass', detail: `${via}, from ${view.fromAddress}`, data };
}

/** `email` / `email.config` — outgoing email is configured. Never sends. */
@Injectable()
export class EmailConfigDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'email.config';
  readonly category = 'email';
  readonly label = 'Email delivery';
  readonly settingsPath = EMAIL_SETTINGS_PATH;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly emailSettings: EmailSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    return decideEmailConfig(await this.emailSettings.describeForAdmin());
  }
}
