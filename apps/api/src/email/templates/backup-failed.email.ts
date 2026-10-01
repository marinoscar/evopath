import {
  APP_NAME,
  callout,
  codeBlock,
  detailRows,
  formatEmailDuration,
  html,
  layoutAttachments,
  paragraph,
  plainText,
  renderLayout,
  textCallout,
  textDetailLines,
  timestampRow,
  type DetailRow,
} from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// "Database backup failed" template — `db_backup.backup_failed` (#288, #254)
// =============================================================================
//
// ONE TEMPLATE FOR TWO OUTCOMES, and the difference between them is carried in
// the payload rather than in a second file:
//
//   * `failed` — the run itself reported an error. Something observed it break
//     and wrote down what.
//   * `stale`  — the run stopped heartbeating and the ten-minute sweep gave up
//     on it. NOTHING observed it fail; the process executing it went away.
//
// They are the same message to the same audience about the same missing
// recovery point, and the only thing a reader does differently is where they
// go looking — so `outcome` selects one sentence and the rest is shared.
// Splitting them into two templates would duplicate the whole body to vary a
// clause, and duplicating a body is how two copies of one message drift.
//
// THE CONSEQUENCE IS STATED IN THE FIRST PARAGRAPH, deliberately. "A backup
// failed" is a status; "you have one fewer recovery point than you think, and
// nothing retries this before the next scheduled run" is the fact that decides
// whether the reader acts tonight or on Monday.
//
// No product name is hard-coded; `APP_NAME` is the only seam.
// =============================================================================

/** Which of the two give-up paths produced this message. */
export type BackupFailureOutcome = 'failed' | 'stale';

/** Everything the backup-failure message renders. */
export interface BackupFailedEmailData {
  /** The `database_backup_runs` row id. */
  runId: string;

  /** Which give-up path this was. See {@link BackupFailureOutcome}. */
  outcome: BackupFailureOutcome;

  /**
   * The recorded failure text. For a `stale` run this is the sweep's own
   * explanation rather than an error from the dump. `null` when nothing was
   * recorded at all.
   */
  error: string | null;

  /** When the run started, or `null` when the row never recorded it. */
  startedAt: Date | null;

  /** When the run was settled `failed` or `stale`. Rendered as UTC. */
  failedAt: Date;

  /** How the run was triggered, as stored (`scheduled`, `manual`, ...). */
  trigger: string | null;

  /** Absolute URL of the application root, for the CTA. Optional. */
  appUrl?: string;
}

/** Where the CTA points, appended to `appUrl`. Matches `adminSections.tsx`. */
const DB_BACKUP_ADMIN_PATH = '/admin/settings/db-backup';

/** `null` is a fact about the row, not a blank. Give it words. */
function orNone(value: string | null): string {
  return value === null || value.trim().length === 0 ? 'Not recorded' : value;
}

/** The one sentence that differs between the two outcomes. */
function outcomeSentence(outcome: BackupFailureOutcome): string {
  return outcome === 'stale'
    ? 'It stopped sending heartbeats and was given up on. Nothing observed it fail: the process executing it went away.'
    : 'It reported an error and was recorded as failed.';
}

/** The recipient's own notification settings page, appended to `appUrl`. */
const NOTIFICATION_SETTINGS_PATH = '/settings/notifications';

/**
 * Render the backup-failure message.
 */
export function backupFailedEmail(data: BackupFailedEmailData): RenderedEmail {
  const error = orNone(data.error);
  const trigger = orNone(data.trigger);
  const sentence = outcomeSentence(data.outcome);

  const subject = `${APP_NAME}: database backup failed`;

  const title = 'Database backup failed';
  const eyebrow = 'Operations';
  const ctaUrl = data.appUrl ? `${data.appUrl}${DB_BACKUP_ADMIN_PATH}` : undefined;
  const ctaLabel = ctaUrl ? 'Open database backup' : undefined;
  const preferencesUrl = data.appUrl
    ? `${data.appUrl}${NOTIFICATION_SETTINGS_PATH}`
    : undefined;
  const footerReason = `You received this because you can view database backups in ${APP_NAME}.`;

  const intro = `A database backup of ${APP_NAME} did not complete. ${sentence}`;
  const calloutTitle = 'You have one fewer recovery point';
  // Timestamps go through the shared formatter (`1 Oct 2026, 02:00 UTC`); the
  // duration is derived from the two instants already in the data, and is
  // omitted when the start was never recorded rather than guessed.
  const duration =
    data.startedAt === null
      ? undefined
      : formatEmailDuration(data.startedAt, data.failedAt);
  const facts: Array<DetailRow & { value: string }> = [
    { label: 'Run id', value: data.runId, mono: true },
    { label: 'Outcome', value: data.outcome },
    { label: 'Triggered by', value: trigger },
    timestampRow('Started at', data.startedAt),
    timestampRow('Settled at', data.failedAt),
  ];
  if (duration !== undefined) facts.push({ label: 'Duration', value: duration });
  const reasonLabel = 'Recorded reason';

  // THE CONSEQUENCE LEADS, in the callout directly under the opening line:
  // see the header block for why.
  const bodyHtml = html`
    ${paragraph(intro)}
    ${callout({
      tone: 'critical',
      title: calloutTitle,
      body: html`This deployment now has <strong>one fewer recovery point</strong> than its retention policy assumes, and the run is <strong>not retried automatically</strong> — the next scheduled backup is the retry.`,
    })}
    ${detailRows(facts)}
    ${codeBlock(error, { label: reasonLabel })}
  `;

  const htmlDocument = renderLayout({
    title,
    eyebrow,
    previewText: `Run ${data.runId} ended as ${data.outcome}: ${error}`,
    bodyHtml,
    ctaLabel,
    ctaUrl,
    footerReason,
    preferencesUrl,
  });

  const text = plainText({
    eyebrow,
    title,
    lines: [
      intro,
      '',
      ...textCallout({
        tone: 'critical',
        title: calloutTitle,
        body:
          'This deployment now has ONE FEWER RECOVERY POINT than its retention policy assumes, ' +
          'and the run is NOT retried automatically - the next scheduled backup is the retry.',
      }),
      '',
      ...textDetailLines(facts),
      '',
      `${reasonLabel}:`,
      `  ${error}`,
    ],
    ctaLabel,
    ctaUrl,
    footerReason,
    preferencesUrl,
  });

  return {
    subject,
    html: htmlDocument,
    text,
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
    attachments: layoutAttachments(),
  };
}
