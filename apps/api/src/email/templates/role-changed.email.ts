import {
  APP_NAME,
  callout,
  detailRows,
  html,
  layoutAttachments,
  paragraph,
  plainText,
  renderLayout,
  textCallout,
  textDetailLines,
  timestampRow,
} from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// "Your roles changed" template — `security.role_changed` (issue #128, epic #109)
// =============================================================================
//
// THE SECURITY MESSAGE, and the only one of the three whose event is
// `mandatory: true`. A user cannot switch this off, so this template is the
// backstop against a privilege change nobody outside the admin console can
// see. That framing drives two decisions the other two templates do not face.
//
// -----------------------------------------------------------------------------
// 1. IT SHOWS BEFORE AND AFTER, NOT JUST AFTER
// -----------------------------------------------------------------------------
//
// "Your roles are now Viewer" is unactionable: the recipient cannot tell
// whether anything changed, whether they gained access or lost it, or whether
// this is the change they asked for. The DELTA is the alertable fact — a
// silent demotion and a silent promotion are both worth a second look, and
// only the pair shows either.
//
// -----------------------------------------------------------------------------
// 2. IT DOES NOT NAME THE ADMINISTRATOR WHO MADE THE CHANGE
// -----------------------------------------------------------------------------
//
// `allowlist-invitation.email.ts` names the admin deliberately; this one
// deliberately does not, and the difference is the reader. An invitation goes
// to somebody being asked to act, and attribution is what makes it credible.
// This goes to somebody who may have just been demoted or removed, and naming
// the individual who did it discloses an internal identity into an adversarial
// reading of the same message for no operational gain. The recipient's action
// is the same either way: if this was not expected, raise it. `audit_events`
// holds the actor for whoever investigates, which is the controlled place for
// it.
//
// -----------------------------------------------------------------------------
// 3. IT STATES WHEN THE CHANGE TAKES EFFECT, WHICH IS NOT IMMEDIATELY
// -----------------------------------------------------------------------------
//
// Roles are carried in the access token's claims and re-read from the database
// only when that token is refreshed (`AuthService.refreshAccessToken`), so a
// signed-in user keeps their old permissions until their current access token
// expires — up to `JWT_ACCESS_TTL_MINUTES`. Omitting that produces the support
// ticket "you said I'm an Admin now but nothing changed"; stating it makes the
// message accurate and gives the reader the one action that resolves it.
// =============================================================================

/**
 * Everything the role-change message renders.
 *
 * `changedAt` is PASSED IN rather than read from `new Date()` here, per the
 * rule on `TestEmailData`: a template that reads the clock is not a pure
 * function of its input, and "what exactly did we send?" stops being
 * answerable after the fact — which for a security notification is the whole
 * value of having sent it.
 */
export interface RoleChangedEmailData {
  /** The account whose roles changed. Stated so a reader with several knows which. */
  recipientEmail: string;

  /** Roles held BEFORE the change, as stored. May be empty. */
  previousRoles: string[];

  /** Roles held AFTER the change, as stored. May be empty — access can be removed entirely. */
  currentRoles: string[];

  /** When the change was made. Rendered via `formatEmailTimestamp` (UTC). */
  changedAt: Date;

  /**
   * Absolute URL of the application root, for the CTA. Optional, as everywhere
   * else: with no `APP_URL` configured the layout omits the button rather than
   * rendering one that goes nowhere.
   */
  appUrl?: string;
}

/**
 * Role names as a reader should see them, or an explicit phrase when there are
 * none.
 *
 * THE EMPTY CASE IS THE IMPORTANT ONE. An account can be left with no roles at
 * all, which is the single most alarming outcome this message reports, and
 * rendering it as a blank space beside "Now:" reads as a formatting bug rather
 * than as a loss of access. It gets words.
 */
function formatRoles(roles: string[]): string {
  if (roles.length === 0) return 'None';

  return roles
    .map((role) => role.charAt(0).toUpperCase() + role.slice(1))
    .join(', ');
}

/**
 * Render the role-change message.
 */
export function roleChangedEmail(data: RoleChangedEmailData): RenderedEmail {
  const previous = formatRoles(data.previousRoles);
  const current = formatRoles(data.currentRoles);
  const changedAtRow = timestampRow('Changed at', data.changedAt);
  const timestamp = changedAtRow.value;

  const subject = `Your access to ${APP_NAME} has changed`;

  const title = 'Your roles changed';
  const eyebrow = 'Security';
  const ctaLabel = data.appUrl ? `Open ${APP_NAME}` : undefined;
  // NO preferences link: this event is mandatory, and the footer says why
  // rather than offering a switch that does not exist.
  const footerReason =
    `You received this because the roles on your ${APP_NAME} account changed. ` +
    'This notification cannot be turned off, because a change to your access should never be silent.';

  const intro = `An administrator changed the roles on your ${APP_NAME} account. Your roles decide what you can see and do, so this changes your access.`;
  const facts = [
    { label: 'Account', value: data.recipientEmail },
    { label: 'Previously', value: previous },
    { label: 'Now', value: current },
    changedAtRow,
  ];
  const calloutTitle = 'When it takes effect';
  const calloutBody =
    'If you are signed in, the change applies the next time your session refreshes. Sign out and back in to apply it straight away.';
  const unexpected = 'If you were not expecting this, contact an administrator now.';

  const bodyHtml = html`
    ${paragraph(intro)}
    ${detailRows(facts)}
    ${callout({ tone: 'info', title: calloutTitle, body: calloutBody })}
    ${paragraph(unexpected, { tone: 'muted' })}
  `;

  const htmlDocument = renderLayout({
    title,
    eyebrow,
    // The preheader carries the delta itself. This is the one message whose
    // value can be entirely delivered in the inbox list: a reader who sees
    // "Admin, Viewer -> Viewer" already knows whether to open it.
    previewText: `${previous} → ${current}, changed at ${timestamp}.`,
    bodyHtml,
    ctaLabel,
    ctaUrl: data.appUrl,
    footerReason,
  });

  const text = plainText({
    eyebrow,
    title,
    lines: [
      intro,
      '',
      ...textDetailLines(facts),
      '',
      ...textCallout({ tone: 'info', title: calloutTitle, body: calloutBody }),
      '',
      unexpected,
    ],
    ctaLabel,
    ctaUrl: data.appUrl,
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
