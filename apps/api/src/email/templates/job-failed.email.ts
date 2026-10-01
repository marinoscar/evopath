import {
  APP_NAME,
  callout,
  codeBlock,
  detailRows,
  html,
  layoutAttachments,
  paragraph,
  plainText,
  renderLayout,
  textCallout,
  textDetailLines,
} from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// "Background job failed" template — `jobs.job_failed` (issue #288, epic #254)
// =============================================================================
//
// THE FIRST OF FOUR OPERATIONAL TEMPLATES, and the one that sets the house
// style for the other three. Read the differences from the #128 templates
// as deliberate rather than as drift:
//
//   * THE READER IS AN OPERATOR, NOT A USER. Nobody's account has changed and
//     nothing is being asked of them personally. What they need is enough to
//     decide whether to go and look: WHAT failed, WHY, HOW MANY TIMES it was
//     tried, and WHEN it gave up. Reassurance ("you can safely ignore this")
//     would be actively wrong.
//
//   * IT SAYS "TERMINAL" IN WORDS. `jobs.job_failed` fires ONLY when the
//     attempt budget is spent or a rate limit has been hit past its ceiling —
//     never on a retry, never on a deferral. A reader who does not know that
//     will wait for a retry that is not coming, so the message states it.
//
//   * THE ERROR IS RENDERED VERBATIM AND ESCAPED. `lastError` is a message
//     from a handler this repository does not own; it can contain anything,
//     including markup. The `html` tagged literal escapes it by construction —
//     which is the whole reason every interpolation in this file goes through
//     that tag rather than through string concatenation.
//
// NO PRODUCT NAME IS HARD-CODED anywhere below. `APP_NAME` is the single seam
// (epic #254 success criterion 11); a fork renames the application in one
// place and every message follows.
// =============================================================================

/**
 * Everything the job-failure message renders.
 *
 * `failedAt` is PASSED IN rather than read from `new Date()` here, per the
 * rule the #128 templates set: a template that reads the clock is not a pure
 * function of its input, and "what exactly did we send?" stops being
 * answerable after the fact.
 */
export interface JobFailedEmailData {
  /** The job row's id, so a reader can find it in the admin list. */
  jobId: string;

  /** The registered handler type (`admin.broadcast.chunk`, ...). */
  jobType: string;

  /**
   * The last error the handler reported. `null` when the job was given up on
   * without one ever being recorded — rendered as an explicit phrase rather
   * than as a blank, for the same reason `role-changed.email.ts` spells out
   * "None" for an empty role list.
   */
  error: string | null;

  /** How many attempts were made before the give-up. */
  attempts: number;

  /**
   * Which side ran it — the in-process worker or a named worker node — or
   * `null` when the row never recorded one.
   */
  executor: string | null;

  /** When the job was settled `failed`. Rendered as UTC; see `formatTimestamp`. */
  failedAt: Date;

  /**
   * Absolute URL of the application root, for the CTA. Optional, as
   * everywhere else: with no `APP_URL` configured the layout omits the button
   * rather than rendering one that goes nowhere.
   */
  appUrl?: string;
}

/** Where the CTA points, appended to `appUrl`. Matches `adminSections.tsx`. */
const JOBS_ADMIN_PATH = '/admin/settings/jobs';

/**
 * ISO 8601, in UTC, with the `Z` left on — the same choice, for the same
 * reason, as every other template here: the server does not know the reader's
 * time zone, and this timestamp's job is to be matched against a log line.
 */
function formatTimestamp(value: Date): string {
  return value.toISOString();
}

/** `null` is a fact about the row, not a blank. Give it words. */
function orNone(value: string | null): string {
  return value === null || value.trim().length === 0 ? 'Not recorded' : value;
}

/** The recipient's own notification settings page, appended to `appUrl`. */
const NOTIFICATION_SETTINGS_PATH = '/settings/notifications';

/**
 * Render the job-failure message.
 */
export function jobFailedEmail(data: JobFailedEmailData): RenderedEmail {
  const timestamp = formatTimestamp(data.failedAt);
  const error = orNone(data.error);
  const executor = orNone(data.executor);

  const subject = `${APP_NAME}: background job "${data.jobType}" failed`;

  const title = 'Background job failed';
  const eyebrow = 'Operations';
  const ctaUrl = data.appUrl ? `${data.appUrl}${JOBS_ADMIN_PATH}` : undefined;
  const ctaLabel = ctaUrl ? 'Open jobs' : undefined;
  const preferencesUrl = data.appUrl
    ? `${data.appUrl}${NOTIFICATION_SETTINGS_PATH}`
    : undefined;
  const footerReason = `You received this because you can view background jobs in ${APP_NAME}.`;

  const intro = `A background job in ${APP_NAME} used up its retry budget and was given up on.`;
  const calloutTitle = 'It will not be retried automatically';
  const calloutBody =
    'The work it was doing has not been done. Fix the cause shown below, then run the work again if it is still needed.';
  const facts = [
    { label: 'Job type', value: data.jobType, mono: true },
    { label: 'Job id', value: data.jobId, mono: true },
    { label: 'Attempts', value: String(data.attempts) },
    { label: 'Ran on', value: executor },
    { label: 'Failed at', value: timestamp },
  ];
  const errorLabel = 'Last error reported by the handler';

  // `error` is a message from a handler this repository does not own: it goes
  // through `codeBlock`, which escapes it like every other value here.
  const bodyHtml = html`
    ${paragraph(intro)}
    ${callout({ tone: 'critical', title: calloutTitle, body: calloutBody })}
    ${detailRows(facts)}
    ${codeBlock(error, { label: errorLabel })}
  `;

  const htmlDocument = renderLayout({
    title,
    eyebrow,
    // The preheader carries the type and the error, so the inbox list alone
    // often answers "do I need to open this?".
    previewText: `${data.jobType} gave up after ${data.attempts} attempt(s): ${error}`,
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
        title: 'It will NOT be retried automatically',
        body: calloutBody,
      }),
      '',
      ...textDetailLines(facts),
      '',
      `${errorLabel}:`,
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
