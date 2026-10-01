import { APP_NAME, SafeHtml, html, plainText, renderLayout, safeUrl } from './layout';
import { TRANSACTIONAL_EMAIL_HEADERS, type RenderedEmail } from './email-template.types';

// =============================================================================
// coach.weekly_review email (E7.10, #250; docs/specs/ai-coach.md §2.10)
// =============================================================================
//
// The weekly review as an email: the persona's intro, the deterministic stats
// table, the wins and the one focus, a "Plan my week" call to action to
// `/coach` and a preferences link to `/settings/notifications`. Transactional
// headers: this is the user's own review, never a marketing send.
//
// WHAT IS RENDERED FROM WHERE
//   - every number comes from `stats` (built by code from the training
//     signals); the template formats it, the model never supplies one;
//   - the words come from the review's `emailProse`, which is ALWAYS the
//     clean register (spec §2.10: profanity never appears in email, even for
//     an unlocked Sarge L3) and has passed the content guard with
//     `surface: 'email'`;
//   - every interpolation goes through the `html` tag (escaped); there is no
//     raw model HTML anywhere, and the subject is collapsed to one line.
//
// The payload is the `coach.message.deliver` notification data: it also
// carries the push fields (`pushTitle`, ...), which this template ignores.
// The data types are declared here, structurally, so the email module does
// not import the coach.
// =============================================================================

export interface CoachWeeklyReviewEmailStats {
  isoWeek: string;
  /** Monday and Sunday of the week (`YYYY-MM-DD`). */
  weekStart: string;
  weekEnd: string;
  planned: number;
  completed: number;
  /** Null when nothing was planned ("No plan this week", never 0 %). */
  adherencePct: number | null;
  weeklyStreak: number;
  streakPassesLeft: number;
  prs: ReadonlyArray<{ exercise: string; value: number; unit: 'kg' | 'reps'; reps: number | null }>;
  checkIns: number;
  photosAdded: number;
  nextWeekSessions: number;
  noPlan: boolean;
}

export interface CoachWeeklyReviewEmailProse {
  headline: string;
  intro: string;
  wins: readonly string[];
  focus: string;
}

/** Everything the weekly review email renders. */
export interface CoachWeeklyReviewEmailData {
  /** The coach message id (the in-app card). */
  messageId: string;
  /** The persona's display name ("Coach", "Sarge", ...). */
  personaName: string;
  stats: CoachWeeklyReviewEmailStats;
  /** Clean-register prose (guard-approved). Plain text. */
  prose: CoachWeeklyReviewEmailProse;
  /** Absolute URL of the application root, for the links. Optional: without it the links are omitted. */
  appUrl?: string;
}

/** Where "Plan my week" leads. */
export const COACH_PATH = '/coach';
/** Where the reader manages which coach emails they get. */
export const NOTIFICATION_PREFERENCES_PATH = '/settings/notifications';
export const PLAN_MY_WEEK_LABEL = 'Plan my week';

const SUBJECT_MAX = 120;

/** One line, no control characters or angle brackets, bounded: a subject is a header value. */
function subjectLine(headline: string): string {
  // Angle brackets are dropped too: a subject is plain text, and a mail client
  // that renders it as markup must not find any.
  const clean = headline
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const text = clean.length > 0 ? `Your weekly review: ${clean}` : 'Your weekly review';
  return text.length <= SUBJECT_MAX ? text : `${text.slice(0, SUBJECT_MAX - 1)}…`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function formatPr(pr: CoachWeeklyReviewEmailStats['prs'][number]): string {
  if (pr.unit === 'reps') return `${pr.exercise}: ${plural(pr.value, 'rep', 'reps')}`;
  return pr.reps !== null ? `${pr.exercise}: ${pr.value} kg x ${pr.reps}` : `${pr.exercise}: ${pr.value} kg`;
}

/** The stats table rows, as label/value pairs (shared by the HTML and the text part). */
export function weeklyReviewStatRows(stats: CoachWeeklyReviewEmailStats): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  rows.push([
    'Sessions',
    stats.noPlan ? `${stats.completed} completed (no plan this week)` : `${stats.completed} of ${stats.planned} completed`,
  ]);
  rows.push(['Adherence', stats.adherencePct === null ? 'No plan this week' : `${stats.adherencePct}%`]);
  rows.push([
    'Weekly streak',
    plural(stats.weeklyStreak, 'week', 'weeks') +
      (stats.streakPassesLeft > 0 ? ` (${plural(stats.streakPassesLeft, 'streak pass', 'streak passes')} left)` : ''),
  ]);
  rows.push(['Personal records', stats.prs.length === 0 ? 'None this week' : stats.prs.map(formatPr).join('; ')]);
  rows.push(['Check-ins', plural(stats.checkIns, 'day', 'days')]);
  rows.push(['Progress photos', String(stats.photosAdded)]);
  rows.push([
    'Next week',
    stats.nextWeekSessions > 0 ? `${plural(stats.nextWeekSessions, 'session', 'sessions')} planned` : 'Nothing planned yet',
  ]);
  return rows;
}

function statRow(label: string, value: string): SafeHtml {
  return html`<tr>
    <td style="padding:6px 16px 6px 0;font-size:14px;line-height:20px;color:#4b5563;white-space:nowrap;vertical-align:top;">
      ${label}
    </td>
    <td style="padding:6px 0;font-size:14px;line-height:20px;color:#1f2937;vertical-align:top;">
      <strong>${value}</strong>
    </td>
  </tr>`;
}

export function coachWeeklyReviewEmail(data: CoachWeeklyReviewEmailData): RenderedEmail {
  const { stats, prose } = data;
  if (!stats || !prose || typeof prose.headline !== 'string' || typeof prose.intro !== 'string') {
    throw new TypeError('A weekly review email needs `stats` and `prose`.');
  }

  const appUrl = data.appUrl ? data.appUrl.replace(/\/+$/, '') : undefined;
  const ctaUrl = appUrl ? `${appUrl}${COACH_PATH}` : undefined;
  const preferencesUrl = appUrl ? safeUrl(`${appUrl}${NOTIFICATION_PREFERENCES_PATH}`) : null;
  const headline = prose.headline.trim() || 'Your week in review';
  const wins = (prose.wins ?? []).filter((w) => typeof w === 'string' && w.trim().length > 0);
  const rows = weeklyReviewStatRows(stats);
  const weekLabel = `Week ${stats.isoWeek} (${stats.weekStart} to ${stats.weekEnd})`;

  const winsHtml =
    wins.length > 0
      ? html`<p style="margin:0 0 8px 0;font-size:14px;line-height:22px;color:#1f2937;"><strong>Wins</strong></p>
          <ul style="margin:0 0 16px 0;padding:0 0 0 20px;font-size:14px;line-height:22px;color:#1f2937;">
            ${wins.map((win) => html`<li>${win}</li>`)}
          </ul>`
      : html``;

  const focusHtml = prose.focus?.trim()
    ? html`<p style="margin:0 0 8px 0;font-size:14px;line-height:22px;color:#1f2937;"><strong>Focus for next week</strong></p>
        <p style="margin:0 0 16px 0;font-size:14px;line-height:22px;color:#1f2937;">${prose.focus}</p>`
    : html``;

  const preferencesHtml = preferencesUrl
    ? html`You can choose which coach messages reach your inbox in
        <a href="${preferencesUrl}" style="color:#4b5563;">notification preferences</a>.`
    : html`You can choose which coach messages reach your inbox under Settings, Notifications.`;

  const bodyHtml = html`
    <p style="margin:0 0 4px 0;font-size:16px;line-height:24px;color:#1f2937;"><strong>${headline}</strong></p>
    <p style="margin:0 0 16px 0;font-size:13px;line-height:20px;color:#6b7280;">${weekLabel}</p>
    <p style="margin:0 0 4px 0;font-size:13px;line-height:20px;color:#6b7280;">${data.personaName} says:</p>
    <p style="margin:0 0 20px 0;font-size:14px;line-height:22px;color:#1f2937;white-space:pre-line;">${prose.intro}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">
      ${rows.map(([label, value]) => statRow(label, value))}
    </table>
    ${winsHtml}
    ${focusHtml}
    <p style="margin:16px 0 0 0;font-size:12px;line-height:18px;color:#6b7280;">
      This is your weekly review from your ${APP_NAME} coach. ${preferencesHtml}
    </p>
  `;

  const textLines: [string, ...string[]] = [
    headline,
    weekLabel,
    '',
    `${data.personaName} says:`,
    prose.intro,
    '',
    ...rows.map(([label, value]) => `  ${label}: ${value}`),
  ];
  if (wins.length > 0) textLines.push('', 'Wins:', ...wins.map((w) => `  - ${w}`));
  if (prose.focus?.trim()) textLines.push('', 'Focus for next week:', `  ${prose.focus}`);
  textLines.push(
    '',
    preferencesUrl
      ? `Choose which coach messages reach your inbox: ${preferencesUrl}`
      : 'You can choose which coach messages reach your inbox under Settings, Notifications.',
  );

  return {
    subject: subjectLine(headline),
    html: renderLayout({
      title: 'Your weekly review',
      previewText: headline,
      bodyHtml,
      ctaLabel: ctaUrl ? PLAN_MY_WEEK_LABEL : undefined,
      ctaUrl,
    }),
    text: plainText({
      title: 'Your weekly review',
      lines: textLines,
      ctaLabel: ctaUrl ? PLAN_MY_WEEK_LABEL : undefined,
      ctaUrl,
    }),
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
  };
}
