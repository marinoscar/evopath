import { APP_NAME, html, plainText, renderLayout } from './layout';
import { TRANSACTIONAL_EMAIL_HEADERS, type RenderedEmail } from './email-template.types';

// =============================================================================
// coach.weekly_review email (E7.5 registers it; E7.10 writes the real one)
// =============================================================================
//
// A MINIMAL PLACEHOLDER. `coach.weekly_review` declares the `email` channel
// (docs/specs/ai-coach.md §3.5), and the email channel records a delivery
// failure for an email-enabled event with no template, so E7.5 registers this
// one with the event. E7.10 (#250) replaces the body with the review's
// deterministic stats block and the coach's narrative. Until then nothing
// raises the event.
//
// The review email is ALWAYS in the clean register (spec §2.10): the content
// guard checks it with `surface: 'email'` before it is ever rendered here.
// =============================================================================

/** Everything the weekly review email renders. E7.10 extends it. */
export interface CoachWeeklyReviewEmailData {
  /** The review's headline (guard-approved, clean register). */
  title: string;
  /** The review's text (guard-approved, clean register). Plain text. */
  body: string;
  /** The coach message id, for the `/coach?m=<id>` link. */
  messageId: string;
  /** Absolute URL of the application root, for the CTA. Optional. */
  appUrl?: string;
}

export function coachWeeklyReviewEmail(data: CoachWeeklyReviewEmailData): RenderedEmail {
  const ctaUrl = data.appUrl ? `${data.appUrl}/coach?m=${encodeURIComponent(data.messageId)}` : undefined;
  const subject = `${APP_NAME}: your weekly coach review`;

  const bodyHtml = html`
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:0 0 16px 0;font-size:16px;line-height:24px;color:#1f2937;">
          <strong>${data.title}</strong>
        </td>
      </tr>
      <tr>
        <td style="padding:0 0 16px 0;font-size:14px;line-height:22px;color:#1f2937;white-space:pre-line;">
          ${data.body}
        </td>
      </tr>
    </table>
  `;

  return {
    subject,
    html: renderLayout({
      title: 'Your weekly review',
      previewText: data.title,
      bodyHtml,
      ctaLabel: ctaUrl ? 'Open your coach' : undefined,
      ctaUrl,
    }),
    text: plainText({
      title: 'Your weekly review',
      lines: [data.title, '', data.body],
      ctaLabel: ctaUrl ? 'Open your coach' : undefined,
      ctaUrl,
    }),
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
  };
}
