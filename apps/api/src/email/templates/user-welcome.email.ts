import {
  APP_NAME,
  SafeHtml,
  detailRows,
  html,
  layoutAttachments,
  paragraph,
  plainText,
  renderLayout,
  textDetailLines,
} from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// "Welcome" template — `user.welcome` (issue #128, epic #109)
// =============================================================================
//
// The first of the three real event templates. It renders the message sent
// ONCE, at the moment a user record is first created through OAuth — not on
// every login, and not before that row is committed. Both of those are
// properties of the TRIGGER, not of this file; see the call site in
// `auth.service.ts`, which is where the fire-once condition is enforced and
// documented.
//
// WHAT THIS MESSAGE IS FOR. The recipient has just signed in successfully, so
// it is not an activation step and it must not read like one — there is
// nothing for them to click to "finish setting up". Its job is to leave a
// durable record in their inbox that an account now exists here, under which
// address, and with what level of access. That last part is the one fact they
// cannot discover for themselves without signing in and hunting: a Viewer who
// expected Contributor learns it here rather than by finding a button missing.
//
// It is also the ONE email in this system whose absence is harmless, which is
// why `user.welcome` is opt-out (`mandatory` is absent in the registry) while
// `security.role_changed` is not.
// =============================================================================

/**
 * Everything the welcome message renders.
 *
 * NO CLOCK AND NO CONFIGURATION READ, per the rule stated on `TestEmailData`:
 * a template is a pure function of this object. The absolute `appUrl` is
 * supplied by the caller for the same reason — a template that built it would
 * have to know both `APP_URL` and the web app's route table.
 */
export interface UserWelcomeEmailData {
  /** The address the account was created under. Stated back as the fact it is. */
  recipientEmail: string;

  /**
   * Display name from the OAuth profile, when the provider supplied one.
   *
   * Optional because Google does not guarantee it. Interpolated through the
   * `html` tag, so it is ESCAPED — this string came from a third party's
   * profile and is the most obviously attacker-influenced value in the
   * payload.
   */
  recipientName?: string;

  /**
   * Roles the new account was given, as stored (`viewer`, `admin`).
   *
   * Rendered because "what can I actually do here?" is the only question a
   * welcome message is uniquely placed to answer. May be empty — a seeding
   * failure would produce that — in which case the sentence is omitted rather
   * than rendered as an empty list.
   */
  roles: string[];

  /**
   * Absolute URL of the application root, for the CTA. Optional: with no
   * `APP_URL` configured there is no honest link to offer, and the layout
   * omits the button rather than rendering one that goes nowhere.
   */
  appUrl?: string;
}

/**
 * Role names as a reader should see them.
 *
 * Stored names are lower-case identifiers (`admin`); an email is product copy,
 * not a database dump. Shared with `role-changed.email.ts` would be the
 * obvious move and is deliberately NOT made: these are two independent pieces
 * of copy and a shared formatter is how one template's wording change silently
 * edits another's.
 */
function formatRoles(roles: string[]): string {
  return roles
    .map((role) => role.charAt(0).toUpperCase() + role.slice(1))
    .join(', ');
}

/** The recipient's own notification settings page, appended to `appUrl`. */
const NOTIFICATION_SETTINGS_PATH = '/settings/notifications';

/**
 * Render the welcome message.
 */
export function userWelcomeEmail(data: UserWelcomeEmailData): RenderedEmail {
  const greetingName = data.recipientName?.trim();
  const roleList = data.roles.length > 0 ? formatRoles(data.roles) : null;

  // No timestamp in the subject, unlike the test email. That one is sent
  // repeatedly at an admin's request and must not thread; this one is sent
  // exactly once per account, so there is nothing for it to collapse into.
  const subject = `Welcome to ${APP_NAME}`;

  const title = `Welcome to ${APP_NAME}`;
  const eyebrow = 'Account';
  const ctaLabel = data.appUrl ? `Open ${APP_NAME}` : undefined;
  const preferencesUrl = data.appUrl
    ? `${data.appUrl}${NOTIFICATION_SETTINGS_PATH}`
    : undefined;
  const footerReason =
    `You received this because an account was just created for this address on ${APP_NAME}. ` +
    'It is sent once, and you can turn it off with the rest of your notifications.';

  const facts: { label: string; value: string }[] = [
    { label: 'Sign in with', value: data.recipientEmail },
  ];
  if (roleList) {
    facts.push({ label: data.roles.length > 1 ? 'Roles' : 'Role', value: roleList });
  }

  const intro = `Your account on ${APP_NAME} has been created and is ready to use. Use the address below every time you sign in.`;
  const rolesNote =
    'Your role decides what you can see and do. If it is not the access you expected, ask an administrator to change it — you will get an email when they do.';

  const bodyHtml = html`
    ${greetingName ? paragraph(html`Hello ${greetingName},`) : SafeHtml.EMPTY}
    ${paragraph(intro)}
    ${detailRows(facts)}
    ${roleList ? paragraph(rolesNote, { tone: 'muted' }) : SafeHtml.EMPTY}
  `;

  const htmlDocument = renderLayout({
    title,
    eyebrow,
    // The preheader names the account rather than repeating the subject, which
    // the inbox list already shows immediately to its left.
    previewText: `Your account for ${data.recipientEmail} is ready.`,
    bodyHtml,
    ctaLabel,
    ctaUrl: data.appUrl,
    footerReason,
    preferencesUrl,
  });

  // Hand-written, same facts in the same order. Not stripped from the markup
  // above — see the note above `plainText` in layout.ts for why no such
  // function exists in this module.
  const lines: string[] = [];
  if (greetingName) {
    lines.push(`Hello ${greetingName},`, '');
  }
  lines.push(intro, '', ...textDetailLines(facts));
  if (roleList) {
    lines.push('', rolesNote);
  }

  const text = plainText({
    eyebrow,
    title,
    // Split so the leading element is a literal: `PlainTextOptions.lines` is a
    // non-empty tuple, and an array whose length TypeScript cannot see widens
    // to `string[]` and stops satisfying it.
    lines: [lines[0]!, ...lines.slice(1)],
    ctaLabel,
    ctaUrl: data.appUrl,
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
