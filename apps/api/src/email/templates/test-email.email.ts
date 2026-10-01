import type { EmailProviderKind } from '../email-settings.schema';
import {
  APP_NAME,
  callout,
  detailRows,
  formatEmailTimestamp,
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
// "Test email" template (issue #123, epic #109)
// =============================================================================
//
// The message behind #124's "Send test email" button. It ships in #123 rather
// than with the button because the button needs something to send, and because
// it is the first exercise of the layout, the escaping mechanism and the
// mandatory text part — if any of the three is wrong, this is where it shows.
//
// THIS IS A DIAGNOSTIC, NOT A GREETING. #124's entire purpose is telling an
// admin why their mail configuration does not work; epic #109 calls that out
// as the page's whole job. So the body states WHICH transport carried this
// message, WHEN, TO WHOM and AT WHOSE REQUEST. An admin debugging "the test
// said it sent but nothing arrived" needs to know whether the message in front
// of them came from the SES they just switched to or from the SMTP relay they
// switched away from — and a message that only says "it works" cannot answer
// that.
//
// The three real event templates (`user.welcome`, `allowlist.invitation`,
// `security.role_changed`) are #128, deliberately not here.
// =============================================================================

/**
 * Everything the test message renders.
 *
 * NOTE THE ABSENT CLOCK: `sentAt` is passed in rather than read from `new
 * Date()` inside the template. A template that reads the clock is not a pure
 * function of its input, which makes its output untestable without freezing
 * time and makes "what exactly did we send?" unanswerable after the fact.
 * Every template in this module follows the same rule.
 */
export interface TestEmailData {
  /** Address the admin typed into the test form. Echoed back as a check. */
  recipientEmail: string;

  /** Transport that actually carried this message. The key diagnostic fact. */
  providerKind: EmailProviderKind;

  /** When the send was initiated. Rendered via `formatEmailTimestamp` (UTC). */
  sentAt: Date;

  /**
   * Who pressed the button, if known — display name or email.
   *
   * Optional because the caller may not have it, not because it is
   * decorative: on a system with several admins, "who triggered this" is the
   * difference between a test and an unexplained message in an inbox.
   */
  triggeredBy?: string;

  /**
   * Absolute URL of the admin email settings page, for the CTA.
   *
   * PASSED IN, NOT BUILT HERE. A template that knows the web app's route table
   * is a template that breaks silently when a route moves, and it would have
   * to know `APP_URL` too — configuration a pure renderer has no business
   * reading. #124 has both and supplies the finished URL.
   */
  settingsUrl?: string;
}

/**
 * Human labels for the transports. The stored value (`ses`) is an
 * implementation key; an admin reading their inbox should see the product name
 * they chose in the dropdown.
 *
 * TYPED `Record<EmailProviderKind, string>`, so adding a transport to
 * `EMAIL_PROVIDER_KINDS` fails to compile here until it is named — rather than
 * rendering a blank where the diagnostic fact should be.
 */
const PROVIDER_LABELS: Record<EmailProviderKind, string> = {
  ses: 'Amazon SES',
  smtp: 'SMTP',
};

/**
 * Render the test message.
 */
export function testEmail(data: TestEmailData): RenderedEmail {
  const providerLabel = PROVIDER_LABELS[data.providerKind];
  // Shared formatter: UTC, said explicitly, never the host's zone or locale.
  // The SUBJECT keeps seconds (see below); the body reads at minute precision.
  const sentAtRow = timestampRow('Sent at', data.sentAt);
  const timestamp = sentAtRow.value;
  const subjectTimestamp = formatEmailTimestamp(data.sentAt, { seconds: true });

  // The timestamp is IN THE SUBJECT, which looks like clutter and is not.
  // Gmail and Outlook both thread on identical subject lines, so a second test
  // send collapses into the first one's conversation and is easy to miss
  // entirely — turning "I fixed the config and retried, nothing arrived" into
  // a false negative at the exact moment the admin is trying to tell whether
  // their change worked. Distinct subjects keep each attempt a separate row.
  // Seconds are kept here (and only here) so two sends within the same minute
  // still get distinct subjects.
  const subject = `Test email from ${APP_NAME} (${subjectTimestamp})`;

  const title = 'Your email configuration works';
  const eyebrow = 'Test';
  const ctaLabel = data.settingsUrl ? 'Open email settings' : undefined;
  const footerReason =
    `You received this because an administrator pressed "Send test email" in the ${APP_NAME} email settings. ` +
    'Nobody else received it, and nothing else is sent as a result of it.';

  // The facts, in one list both parts render from. `triggeredBy` is a display
  // name from an OAuth profile and `recipientEmail` came straight off an admin
  // form: the html half escapes them through `detailRows`.
  const facts: Array<DetailRow & { value: string }> = [
    { label: 'Provider', value: providerLabel },
    sentAtRow,
    { label: 'Delivered to', value: data.recipientEmail },
  ];
  if (data.triggeredBy) {
    facts.push({ label: 'Requested by', value: data.triggeredBy });
  }

  const calloutTitle = `Delivered via ${providerLabel}`;
  const calloutBody =
    'Its arrival confirms the whole path: settings, credentials, transport and delivery.';

  const bodyHtml = html`
    ${paragraph(html`This message was sent by the <strong>Send test email</strong> button on the admin email settings page.`)}
    ${callout({ tone: 'success', title: calloutTitle, body: calloutBody })}
    ${detailRows(facts)}
  `;

  const htmlDocument = renderLayout({
    title,
    eyebrow,
    // The preheader repeats the transport rather than the good news, because
    // the inbox list is where an admin comparing two test sends is looking.
    previewText: `Test message delivered via ${providerLabel} at ${timestamp}.`,
    bodyHtml,
    ctaLabel,
    ctaUrl: data.settingsUrl,
    footerReason,
  });

  // Hand-written, not stripped from the markup above. Same facts, same order,
  // shaped for a reader with no HTML — see the note above `plainText` in
  // layout.ts.
  const text = plainText({
    eyebrow,
    title,
    lines: [
      'This message was sent by the "Send test email" button on the admin email settings page.',
      '',
      ...textCallout({ tone: 'success', title: calloutTitle, body: calloutBody }),
      '',
      ...textDetailLines(facts),
    ],
    ctaLabel,
    ctaUrl: data.settingsUrl,
    footerReason,
  });

  return {
    subject,
    html: htmlDocument,
    text,
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
    attachments: layoutAttachments(),
  };
}
