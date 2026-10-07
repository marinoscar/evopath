import { DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { DoctorCheckRegistry } from '@marinoscar/platform-api/doctor';
import { EmailSettingsAdminView, EmailSettingsService } from '../email-settings.service';
import { EmailConfigDoctorCheck, decideEmailConfig } from './email-config.doctor-check';

function expectRemedy(outcome: DoctorCheckOutcome): void {
  expect(['warn', 'fail']).toContain(outcome.status);
  expect(outcome.remedy).toEqual(expect.stringMatching(/\S{10,}/));
}

const status = (configured: boolean) => ({
  configured,
  hint: configured ? '••••word' : null,
  updatedAt: null,
  updatedByUserId: null,
});

function view(overrides: Partial<EmailSettingsAdminView> = {}): EmailSettingsAdminView {
  return {
    provider: 'smtp',
    enabled: true,
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpUsername: 'mailer',
    fromAddress: 'no-reply@example.com',
    smtpPasswordStatus: status(true),
    sesSecretAccessKeyStatus: status(false),
    settingsError: null,
    version: 3,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  } as EmailSettingsAdminView;
}

describe('email.config doctor check', () => {
  it('passes a complete, enabled SMTP configuration', () => {
    const outcome = decideEmailConfig(view());

    expect(outcome).toMatchObject({ status: 'pass', data: { provider: 'smtp' } });
    expect(outcome.detail).toContain('smtp.example.com:587');
  });

  it('never reports the password hint', () => {
    expect(JSON.stringify(decideEmailConfig(view()))).not.toContain('word');
  });

  it('warns when no provider is chosen', () => {
    const outcome = decideEmailConfig(view({ provider: null }));
    expect(outcome.status).toBe('warn');
    expectRemedy(outcome);
  });

  it('warns when configured but switched off', () => {
    const outcome = decideEmailConfig(view({ enabled: false }));
    expect(outcome.status).toBe('warn');
    expectRemedy(outcome);
  });

  it('fails an SMTP username with no stored password', () => {
    const outcome = decideEmailConfig(view({ smtpPasswordStatus: status(false) }));
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('SMTP password');
    expectRemedy(outcome);
  });

  it('fails SES without a region', () => {
    const outcome = decideEmailConfig(view({ provider: 'ses', sesRegion: undefined }));
    expect(outcome.detail).toContain('SES region');
    expectRemedy(outcome);
  });

  it('fails a stored row that does not validate', () => {
    const outcome = decideEmailConfig(view({ settingsError: 'The stored email configuration is invalid at: smtpPort.' }));
    expect(outcome.status).toBe('fail');
    expectRemedy(outcome);
  });

  it('reads the admin view (never sends) and registers itself', async () => {
    const describeForAdmin = jest.fn().mockResolvedValue(view());
    const registry = new DoctorCheckRegistry();
    const check = new EmailConfigDoctorCheck(registry, { describeForAdmin } as unknown as EmailSettingsService);
    check.onModuleInit();

    await expect(check.run()).resolves.toMatchObject({ status: 'pass' });
    expect(registry.get('email.config')).toBe(check);
  });
});
