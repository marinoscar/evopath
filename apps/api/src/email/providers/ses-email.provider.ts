import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { BaseEmailProvider, SecretRedactor } from '../base-email.provider';
import { CredentialsService } from '../../credentials/credentials.service';
import { EmailSettingsService } from '../email-settings.service';
import {
  SES_CREDENTIAL_NAME,
  SES_CREDENTIAL_PURPOSE,
} from '../ses-credential.constants';
import type { EmailMessage, EmailSendResult } from '../email.types';

// =============================================================================
// SesEmailProvider (issue #122, epic #109; own credential as of #585)
// =============================================================================
//
// AWS SES v2, for deployments already running on AWS: cheaper than a hosted
// mail API, better deliverability than an arbitrary SMTP relay.
//
// SES HAS ITS OWN, ADMIN-CONFIGURABLE CREDENTIAL. The access key id is a
// non-secret field in the `email` settings namespace (`sesAccessKeyId`, see
// email-settings.schema.ts); the secret access key lives in the encrypted
// credential store at `(purpose 'email_ses', name 'default')` -- its own
// address, written and read exactly like the SMTP password (see
// smtp-credential.constants.ts, smtp-email.provider.ts). An admin sets both
// on the email settings page with no restart, matching how every other
// runtime-configured credential in this app works.
//
// THIS STILL DOES NOT READ THE S3 STORAGE PROVIDER'S CREDENTIAL, AND MUST
// NOT. MemoriaHub's reference SES provider loads the S3 storage provider's
// database credential row and decrypts it. That makes email depend on
// storage being configured -- a deployment that sends mail and keeps files on
// local disk cannot send mail, and "why is email broken?" gets answered in
// the storage settings page. Epic #109 calls that coupling out by name and it
// is still correct: if you find yourself reading a storage credential here,
// that is the bug. SES gets its OWN purpose in `CredentialsService`, entirely
// independent of storage's.
//
// The client is built LAZILY, on send, never in the constructor. A missing
// credential or an unset region must not stop the module -- and therefore the
// whole API -- from starting, because email being unconfigured is a normal
// state for a fresh install. The id, secret and region can all change under
// us when an admin edits the settings, so binding any of them at DI time
// would need a restart to take effect.
// =============================================================================

@Injectable()
export class SesEmailProvider extends BaseEmailProvider {
  protected readonly logger = new Logger(SesEmailProvider.name);
  protected readonly transportName = 'SES';

  /**
   * Cached client, keyed by the inputs that determine its construction.
   *
   * Reused because an SESv2Client owns an HTTPS agent and a connection pool;
   * building one per message means a fresh TLS handshake for every email.
   * Keyed rather than built once so an admin's region change takes effect on
   * the next send instead of at the next deploy.
   */
  private cached: { key: string; client: SESv2Client } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly emailSettings: EmailSettingsService,
    // The SES secret access key's only home, matching `SmtpEmailProvider`'s
    // use of the same service for the SMTP password. Only `getSecret` is
    // called from here, at the moment a client is built for a send -- never
    // `setSecret`/`describe`, which are `EmailSettingsService`'s job on the
    // write/admin-read paths.
    private readonly credentials: CredentialsService,
  ) {
    super();
  }

  /**
   * @see BaseEmailProvider.deliver -- this may throw freely; `send`, the only
   * public entry point, converts anything thrown into a failure result. There
   * is intentionally no try/catch anywhere in this file.
   */
  protected async deliver(
    msg: EmailMessage,
    redact: SecretRedactor,
  ): Promise<EmailSendResult> {
    const client = await this.buildClient(redact);

    const result = await client.send(
      new SendEmailCommand({
        FromEmailAddress: msg.from,
        Destination: { ToAddresses: [msg.to] },
        Content: {
          Simple: {
            Subject: { Data: msg.subject, Charset: 'UTF-8' },
            Body: {
              // Both parts, always. SESv2 will happily send HTML-only; a
              // message with no text alternative scores worse with spam
              // filters and is unreadable in a text-only client. `EmailMessage`
              // makes `text` required and this passes it straight through.
              Html: { Data: msg.html, Charset: 'UTF-8' },
              Text: { Data: msg.text, Charset: 'UTF-8' },
            },
            // SESv2 accepts extra headers on Simple content. Used for
            // per-recipient headers (a List-Unsubscribe pair, a correlation
            // id) that cannot be provider-level configuration.
            ...(msg.headers
              ? {
                  Headers: Object.entries(msg.headers).map(([Name, Value]) => ({
                    Name,
                    Value,
                  })),
                }
              : {}),
          },
        },
      }),
    );

    if (!result.MessageId) {
      // SES returns 200 with a MessageId on acceptance. No id means we cannot
      // answer "did this actually go out?" later from a delivery record
      // (#125), so report it rather than recording a success we cannot trace.
      return {
        success: false,
        error: 'SES accepted the request but returned no message id.',
      };
    }

    return { success: true, messageId: result.MessageId };
  }

  /**
   * Resolve credentials and region, and build (or reuse) the client.
   *
   * Throws a plain `Error` for each missing piece, with a message written for
   * the admin who will read it in #124's dialog: it names the setting to go
   * and fix.
   */
  private async buildClient(redact: SecretRedactor): Promise<SESv2Client> {
    const settings = await this.emailSettings.get();
    const accessKeyId = settings.sesAccessKeyId || '';

    // The plaintext read. `EmailSettingsService` never calls `getSecret` --
    // this is the ONE place in the module that does, at the moment the value
    // is actually needed to sign a request, matching `SmtpEmailProvider`.
    const secretAccessKey =
      (await this.credentials.getSecret(
        SES_CREDENTIAL_PURPOSE,
        SES_CREDENTIAL_NAME,
      )) || '';

    // Registered the instant we hold it, BEFORE anything that can throw while
    // holding it. An AWS SDK error that serialised its own request context
    // would otherwise carry this string into an admin's browser (#124) and a
    // database row (#125). See SecretRedactor.
    redact.protect(secretAccessKey);

    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        'AWS credentials are not set. Enter the SES access key ID and secret access key in email settings.',
      );
    }

    // Settings first, environment second: an admin editing a setting must be
    // able to override the deploy-time default without a redeploy, which is
    // the entire reason `sesRegion` is a setting at all. Unlike the access
    // key id and secret, the region keeps an environment-backed DEFAULT
    // (`sesRegionFallback` / `SES_REGION`) -- a non-secret field, matching the
    // pattern the telemetry feature's GreptimeDB connection defaults already
    // use, and not part of this credential fix.
    const region =
      settings.sesRegion ||
      this.config.get<string>('email.sesRegionFallback') ||
      '';

    if (!region) {
      throw new Error(
        'No SES region is configured. Set the SES region in email settings, or SES_REGION in the environment.',
      );
    }

    // The secret is IN the cache key, unlike the analogous cache in
    // `SmtpEmailProvider` (which keys on the transport options and rebuilds a
    // transporter, a far cheaper object, per message shape anyway). It has to
    // be: an admin can rotate the SES secret access key at runtime without
    // touching the access key id, and a cache keyed on the id alone would keep
    // serving a client signed with the old secret until this process
    // restarts. This adds no new exposure -- the client we are about to build
    // holds the same secret for as long as it stays cached regardless.
    const key = `${region} ${accessKeyId} ${secretAccessKey}`;

    if (this.cached?.key === key) {
      return this.cached.client;
    }

    const client = new SESv2Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
      // Bounded retries. The SDK default (3 attempts with exponential backoff)
      // suits a queue worker and is wrong for a send that may sit in a request
      // path: a throttled SES would hold the caller open for seconds. #125
      // owns retry policy; a transport should fail fast and report.
      maxAttempts: 2,
    });

    // Replacing a cached client: drop the old one's sockets rather than
    // leaking a connection pool on every region change.
    this.cached?.client.destroy();
    this.cached = { key, client };

    return client;
  }
}
