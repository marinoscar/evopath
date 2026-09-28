import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

// =============================================================================
// SesEmailProvider — tests (issue #122, epic #109; own credential as of #585)
// =============================================================================
//
// `@aws-sdk/client-sesv2` is mocked entirely, at the module level, BEFORE it
// is ever imported — including transitively, via ses-email.provider.ts.
// Nothing in this file opens a real HTTPS connection or makes a signed AWS
// request. `sesConstructorMock` records what each `new SESv2Client(...)` call
// was built with — the only way to observe the region/credential chain the
// provider resolves internally, since that resolution is private.
//
// The provider is instantiated directly (`new SesEmailProvider(...)`) rather
// than through a Nest TestingModule: its constructor takes three plain
// dependencies, and nearly every test below needs a different combination of
// config/settings/credential values, so a hand-built triple of fakes per test
// is far clearer than rebuilding a DI container for each one.
//
// #585 moved the AWS credential off the environment and onto its own
// admin-configurable field (`sesAccessKeyId`, a setting) plus its own
// encrypted-credential-store entry (`(email_ses, default)`, the secret access
// key) — exactly mirroring how the SMTP password already works. This file's
// `makeCredentials` helper is the same shape as
// `smtp-email.provider.spec.ts`'s.
// =============================================================================

const sesSendMock = jest.fn();
const sesDestroyMock = jest.fn();
const sesConstructorMock = jest.fn();

jest.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: jest.fn().mockImplementation((config: unknown) => {
    sesConstructorMock(config);
    return { send: sesSendMock, destroy: sesDestroyMock };
  }),
  SendEmailCommand: jest.fn().mockImplementation((input: unknown) => ({
    __command: 'SendEmailCommand',
    input,
  })),
}));

import { SesEmailProvider } from './ses-email.provider';
import {
  SES_CREDENTIAL_NAME,
  SES_CREDENTIAL_PURPOSE,
} from '../ses-credential.constants';
import type { CredentialsService } from '../../credentials/credentials.service';
import type { EmailSettingsService } from '../email-settings.service';
import type { EmailSettings } from '../email-settings.schema';
import type { EmailMessage } from '../email.types';

const baseMessage: EmailMessage = {
  to: 'recipient@example.com',
  from: 'sender@example.com',
  subject: 'Test subject',
  html: '<p>hello</p>',
  text: 'hello',
};

const baseEmailSettings: EmailSettings = {
  provider: 'ses',
  enabled: true,
};

function makeConfig(values: Record<string, string>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function makeEmailSettings(value: EmailSettings): EmailSettingsService {
  return {
    get: jest.fn().mockResolvedValue(value),
  } as unknown as EmailSettingsService;
}

function makeCredentials(secret: string | null): CredentialsService {
  return {
    getSecret: jest.fn().mockResolvedValue(secret),
  } as unknown as CredentialsService;
}

/** A settings object carrying the non-secret half of the SES credential. */
const withAccessKeyId = (
  settings: EmailSettings,
  accessKeyId = 'AKIAEXAMPLE',
): EmailSettings => ({ ...settings, sesAccessKeyId: accessKeyId });

describe('SesEmailProvider', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // The SES credential comes from its own settings field + CredentialsService,
  // never from the environment (#585)
  // ==========================================================================

  describe('the credential comes from settings + CredentialsService, not the environment', () => {
    it('reads the secret access key through CredentialsService.getSecret with the SES purpose and default name', async () => {
      const credentials = makeCredentials('super-secret-access-key-value');
      const provider = new SesEmailProvider(
        makeConfig({}),
        makeEmailSettings(withAccessKeyId({ ...baseEmailSettings, sesRegion: 'us-east-2' })),
        credentials,
      );
      sesSendMock.mockResolvedValueOnce({ MessageId: 'ses-msg-1' });

      await provider.send(baseMessage);

      expect(credentials.getSecret).toHaveBeenCalledWith(
        SES_CREDENTIAL_PURPOSE,
        SES_CREDENTIAL_NAME,
      );
      expect(SES_CREDENTIAL_PURPOSE).toBe('email_ses');
    });

    it('never reads the old environment-based config keys for the access key id or secret', async () => {
      const config = makeConfig({});
      const provider = new SesEmailProvider(
        config,
        makeEmailSettings(withAccessKeyId({ ...baseEmailSettings, sesRegion: 'us-east-2' })),
        makeCredentials('super-secret-access-key-value'),
      );
      sesSendMock.mockResolvedValueOnce({ MessageId: 'ses-msg-2' });

      await provider.send(baseMessage);

      expect(config.get).not.toHaveBeenCalledWith('email.awsAccessKeyId');
      expect(config.get).not.toHaveBeenCalledWith('email.awsSecretAccessKey');
    });

    it('still calls CredentialsService even on a configuration failure (the id is missing)', async () => {
      const credentials = makeCredentials('super-secret-access-key-value');
      const provider = new SesEmailProvider(
        makeConfig({}),
        makeEmailSettings(baseEmailSettings), // no sesAccessKeyId
        credentials,
      );

      await provider.send(baseMessage);

      expect(credentials.getSecret).toHaveBeenCalledWith(
        SES_CREDENTIAL_PURPOSE,
        SES_CREDENTIAL_NAME,
      );
    });
  });

  // ==========================================================================
  // Missing/incomplete configuration is a result, never a throw
  // ==========================================================================

  describe('missing/incomplete configuration is a result, not a throw', () => {
    it('reports a failure, not an exception, when no AWS credentials are configured', async () => {
      const provider = new SesEmailProvider(
        makeConfig({}),
        makeEmailSettings(baseEmailSettings),
        makeCredentials(null),
      );

      const result = await provider.send(baseMessage);

      expect(result).toEqual({
        success: false,
        error:
          'SES: AWS credentials are not set. Enter the SES access key ID and secret access key in email settings.',
      });
      expect(sesConstructorMock).not.toHaveBeenCalled();
    });

    it('reports a failure when the secret access key is missing even if the access key id is present', async () => {
      const provider = new SesEmailProvider(
        makeConfig({}),
        makeEmailSettings(withAccessKeyId(baseEmailSettings)),
        makeCredentials(null),
      );

      const result = await provider.send(baseMessage);

      expect(result.success).toBe(false);
      expect(result.error).toContain('AWS credentials are not set');
    });

    it('reports a failure when the access key id is missing even if the secret access key is stored', async () => {
      const provider = new SesEmailProvider(
        makeConfig({}),
        makeEmailSettings(baseEmailSettings), // no sesAccessKeyId
        makeCredentials('super-secret-access-key-value'),
      );

      const result = await provider.send(baseMessage);

      expect(result.success).toBe(false);
      expect(result.error).toContain('AWS credentials are not set');
    });

    it('reports an explicit region error rather than silently defaulting to us-east-1', async () => {
      const provider = new SesEmailProvider(
        makeConfig({
          // no email.sesRegionFallback configured either
        }),
        makeEmailSettings(withAccessKeyId(baseEmailSettings)), // no sesRegion
        makeCredentials('super-secret-access-key-value'),
      );

      const result = await provider.send(baseMessage);

      expect(result).toEqual({
        success: false,
        error:
          'SES: No SES region is configured. Set the SES region in email settings, or SES_REGION in the environment.',
      });
      expect(sesConstructorMock).not.toHaveBeenCalled();
      // The whole point of this test: an unconfigured region must never
      // silently resolve to a default region.
      expect(result.error).not.toContain('us-east-1');
    });
  });

  // ==========================================================================
  // Region resolution — UNCHANGED by #585, still settings-first, env-fallback
  // ==========================================================================

  describe('region resolution', () => {
    it('prefers email.sesRegion from settings over the SES_REGION environment fallback', async () => {
      const provider = new SesEmailProvider(
        makeConfig({ 'email.sesRegionFallback': 'us-west-2' }),
        makeEmailSettings(
          withAccessKeyId({ ...baseEmailSettings, sesRegion: 'eu-west-1' }),
        ),
        makeCredentials('super-secret-access-key-value'),
      );
      sesSendMock.mockResolvedValueOnce({ MessageId: 'ses-msg-2' });

      await provider.send(baseMessage);

      expect(sesConstructorMock).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'eu-west-1' }),
      );
    });

    it('falls back to SES_REGION when no email.sesRegion setting is configured', async () => {
      const provider = new SesEmailProvider(
        makeConfig({ 'email.sesRegionFallback': 'ap-southeast-2' }),
        makeEmailSettings(withAccessKeyId(baseEmailSettings)), // no sesRegion
        makeCredentials('super-secret-access-key-value'),
      );
      sesSendMock.mockResolvedValueOnce({ MessageId: 'ses-msg-3' });

      await provider.send(baseMessage);

      expect(sesConstructorMock).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'ap-southeast-2' }),
      );
    });
  });

  // ==========================================================================
  // Sending
  // ==========================================================================

  describe('sending', () => {
    it('returns { success: true } with the SES message id on acceptance', async () => {
      const provider = new SesEmailProvider(
        makeConfig({}),
        makeEmailSettings(withAccessKeyId({ ...baseEmailSettings, sesRegion: 'us-east-1' })),
        makeCredentials('super-secret-access-key-value'),
      );
      sesSendMock.mockResolvedValueOnce({ MessageId: 'ses-real-message-id' });

      const result = await provider.send(baseMessage);

      expect(result).toEqual({ success: true, messageId: 'ses-real-message-id' });
    });

    it('builds the SendEmailCommand input from the message, including extra headers', async () => {
      const provider = new SesEmailProvider(
        makeConfig({}),
        makeEmailSettings(withAccessKeyId({ ...baseEmailSettings, sesRegion: 'us-east-1' })),
        makeCredentials('super-secret-access-key-value'),
      );
      sesSendMock.mockResolvedValueOnce({ MessageId: 'ses-msg-4' });

      await provider.send({
        ...baseMessage,
        headers: { 'X-Correlation-Id': 'abc-123' },
      });

      const commandArg = sesSendMock.mock.calls[0][0] as { input: unknown };
      expect(commandArg.input).toMatchObject({
        FromEmailAddress: baseMessage.from,
        Destination: { ToAddresses: [baseMessage.to] },
        Content: {
          Simple: {
            Subject: { Data: baseMessage.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: baseMessage.html, Charset: 'UTF-8' },
              Text: { Data: baseMessage.text, Charset: 'UTF-8' },
            },
            Headers: [{ Name: 'X-Correlation-Id', Value: 'abc-123' }],
          },
        },
      });
    });

    it('omits the Headers field when the message carries none', async () => {
      const provider = new SesEmailProvider(
        makeConfig({}),
        makeEmailSettings(withAccessKeyId({ ...baseEmailSettings, sesRegion: 'us-east-1' })),
        makeCredentials('super-secret-access-key-value'),
      );
      sesSendMock.mockResolvedValueOnce({ MessageId: 'ses-msg-5' });

      await provider.send(baseMessage);

      const commandArg = sesSendMock.mock.calls[0][0] as {
        input: { Content: { Simple: Record<string, unknown> } };
      };
      expect(commandArg.input.Content.Simple.Headers).toBeUndefined();
    });

    it('reports a failure when SES accepts the request but returns no message id', async () => {
      const provider = new SesEmailProvider(
        makeConfig({}),
        makeEmailSettings(withAccessKeyId({ ...baseEmailSettings, sesRegion: 'us-east-1' })),
        makeCredentials('super-secret-access-key-value'),
      );
      sesSendMock.mockResolvedValueOnce({});

      const result = await provider.send(baseMessage);

      expect(result).toEqual({
        success: false,
        error: 'SES: SES accepted the request but returned no message id.',
      });
    });

    it('returns a failure result, never a rejection, when the SDK call rejects with an Error', async () => {
      const provider = new SesEmailProvider(
        makeConfig({}),
        makeEmailSettings(withAccessKeyId({ ...baseEmailSettings, sesRegion: 'us-east-1' })),
        makeCredentials('super-secret-access-key-value'),
      );
      sesSendMock.mockRejectedValueOnce(new Error('Network timeout'));

      await expect(provider.send(baseMessage)).resolves.toEqual({
        success: false,
        error: 'SES: Network timeout',
      });
    });

    it('returns a failure result when the SDK rejects with a non-Error value', async () => {
      const provider = new SesEmailProvider(
        makeConfig({}),
        makeEmailSettings(withAccessKeyId({ ...baseEmailSettings, sesRegion: 'us-east-1' })),
        makeCredentials('super-secret-access-key-value'),
      );
      sesSendMock.mockRejectedValueOnce({ $metadata: { httpStatusCode: 403 } });

      const result = await provider.send(baseMessage);

      expect(result.success).toBe(false);
      expect(result.error).toBe('SES: Non-Error value of type object thrown.');
    });
  });

  // ==========================================================================
  // Rate-limit classification (issue #456) — passes through BaseEmailProvider
  // ==========================================================================

  describe('rate-limit classification', () => {
    it('tags a TooManyRequestsException rejection as rateLimited', async () => {
      const provider = new SesEmailProvider(
        makeConfig({}),
        makeEmailSettings(withAccessKeyId({ ...baseEmailSettings, sesRegion: 'us-east-1' })),
        makeCredentials('super-secret-access-key-value'),
      );
      const throttleError = Object.assign(new Error('Maximum sending rate exceeded.'), {
        name: 'TooManyRequestsException',
        $metadata: { httpStatusCode: 429 },
      });
      sesSendMock.mockRejectedValueOnce(throttleError);

      const result = await provider.send(baseMessage);

      expect(result.success).toBe(false);
      expect(result.rateLimited).toBe(true);
    });

    it('does not tag an authentication/authorization error as rateLimited', async () => {
      const provider = new SesEmailProvider(
        makeConfig({}),
        makeEmailSettings(withAccessKeyId({ ...baseEmailSettings, sesRegion: 'us-east-1' })),
        makeCredentials('super-secret-access-key-value'),
      );
      const authError = Object.assign(new Error('The security token is invalid'), {
        name: 'UnrecognizedClientException',
        $metadata: { httpStatusCode: 403 },
      });
      sesSendMock.mockRejectedValueOnce(authError);

      const result = await provider.send(baseMessage);

      expect(result.success).toBe(false);
      expect(result.rateLimited).toBeUndefined();
    });
  });

  // ==========================================================================
  // Client caching
  // ==========================================================================

  describe('client caching', () => {
    it('reuses the cached client across sends with the same region and access key', async () => {
      const provider = new SesEmailProvider(
        makeConfig({}),
        makeEmailSettings(withAccessKeyId({ ...baseEmailSettings, sesRegion: 'us-east-1' })),
        makeCredentials('super-secret-access-key-value'),
      );
      sesSendMock.mockResolvedValue({ MessageId: 'ses-msg-a' });

      await provider.send(baseMessage);
      await provider.send(baseMessage);

      expect(sesConstructorMock).toHaveBeenCalledTimes(1);
    });

    it('rebuilds and destroys the old client when the region changes', async () => {
      const emailSettings = makeEmailSettings(
        withAccessKeyId({ ...baseEmailSettings, sesRegion: 'us-east-1' }),
      );
      const provider = new SesEmailProvider(
        makeConfig({}),
        emailSettings,
        makeCredentials('super-secret-access-key-value'),
      );
      sesSendMock.mockResolvedValue({ MessageId: 'ses-msg-b' });

      await provider.send(baseMessage);
      (emailSettings.get as jest.Mock).mockResolvedValueOnce(
        withAccessKeyId({ ...baseEmailSettings, sesRegion: 'eu-central-1' }),
      );
      await provider.send(baseMessage);

      expect(sesConstructorMock).toHaveBeenCalledTimes(2);
      expect(sesDestroyMock).toHaveBeenCalledTimes(1);
    });

    it('rebuilds and destroys the old client when the secret access key rotates, even with the same region and access key id', async () => {
      // The whole reason the implementation puts the secret INTO the cache key
      // (`${region} ${accessKeyId} ${secretAccessKey}`, see the class-level
      // comment on `buildClient`): a runtime secret rotation must take effect
      // on the very next send, not at the next process restart.
      const credentialsGetSecret = jest
        .fn()
        .mockResolvedValueOnce('old-secret-access-key-value')
        .mockResolvedValueOnce('new-rotated-secret-access-key-value');
      const credentials = {
        getSecret: credentialsGetSecret,
      } as unknown as CredentialsService;
      const provider = new SesEmailProvider(
        makeConfig({}),
        makeEmailSettings(withAccessKeyId({ ...baseEmailSettings, sesRegion: 'us-east-1' })),
        credentials,
      );
      sesSendMock.mockResolvedValue({ MessageId: 'ses-msg-c' });

      await provider.send(baseMessage);
      await provider.send(baseMessage);

      expect(sesConstructorMock).toHaveBeenCalledTimes(2);
      expect(sesDestroyMock).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Secret redaction
  // ==========================================================================

  describe('secret redaction in returned/logged errors', () => {
    it('redacts the AWS secret access key from an SDK error message', async () => {
      const secret = 'super-secret-access-key-value-1234';
      const provider = new SesEmailProvider(
        makeConfig({}),
        makeEmailSettings(withAccessKeyId({ ...baseEmailSettings, sesRegion: 'us-east-1' })),
        makeCredentials(secret),
      );
      sesSendMock.mockRejectedValueOnce(
        new Error(
          `SignatureDoesNotMatch: could not validate signature computed with secret ${secret}`,
        ),
      );

      const result = await provider.send(baseMessage);

      expect(result.success).toBe(false);
      expect(result.error).not.toContain(secret);
      expect(result.error).toContain('[redacted]');
    });

    it('never logs the AWS secret access key', async () => {
      const secret = 'super-secret-access-key-value-5678';
      const provider = new SesEmailProvider(
        makeConfig({}),
        makeEmailSettings(withAccessKeyId({ ...baseEmailSettings, sesRegion: 'us-east-1' })),
        makeCredentials(secret),
      );
      sesSendMock.mockRejectedValueOnce(new Error(`auth error, key=${secret}`));

      await provider.send(baseMessage);

      const loggedLines = warnSpy.mock.calls.map((call) => String(call[0]));
      for (const line of loggedLines) {
        expect(line).not.toContain(secret);
      }
    });
  });
});
