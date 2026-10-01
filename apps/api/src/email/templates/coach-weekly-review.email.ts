import {
  APP_NAME,
  SafeHtml,
  callout,
  detailRows,
  html,
  layoutAttachments,
  paragraph,
  plainText,
  renderLayout,
  textCallout,
  textDetailLines,
} from './layout';
import { TRANSACTIONAL_EMAIL_HEADERS, type RenderedEmail } from './email-template.types';

// =============================================================================
// coach.weekly_review email (E7.10, #250; docs/specs/ai-coach.md §2.10)
// =============================================================================
//
// The weekly review as an email: the persona's intro, the deterministic stats
// table (`detailRows`), the wins and the one focus (an `info` callout), a
// "Plan my week" call to action to `/coach` and the layout's "Manage email
// preferences" footer link to `/settings/notifications`. Built from the shared
// layout components (#257) and returns the layout's inline brand mark as
// `attachments`. Transactional headers: this is the user's own review, never a
// marketing send.
//
// WHAT IS RENDERED FROM WHERE
//   - every number comes from `stats` (built by code from the training
//     signals); the template formats it, the model never supplies one;
//   - the words come from the review's `emailProse`, which is ALWAYS the
//     clean register (spec §2.10: profanity never appears in email, even for
//     an unlocked Sarge L3) and has passed the content guard with
//     `surface: 'email'`;
//   - every interpolation goes through the `html` tag or a layout component
//     (escaped); there is no raw model HTML anywhere, and the subject is
//     collapsed to one line.
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
/** Hidden preheader budget; clients cut the inbox snippet around here. */
const PREVIEW_TEXT_MAX = 140;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

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
  return truncate(text, SUBJECT_MAX);
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

/** Split model prose into display paragraphs: blank lines separate, single newlines are soft wraps. */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((p) =>
      p
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join(' '),
    )
    .filter((p) => p.length > 0);
}

/** The title of the focus callout, in both parts. */
const FOCUS_TITLE = 'Focus for next week';
/** The heading above the wins list, in both parts. */
const WINS_TITLE = 'Wins';

export function coachWeeklyReviewEmail(data: CoachWeeklyReviewEmailData): RenderedEmail {
  const { stats, prose } = data;
  if (!stats || !prose || typeof prose.headline !== 'string' || typeof prose.intro !== 'string') {
    throw new TypeError('A weekly review email needs `stats` and `prose`.');
  }

  const appUrl = data.appUrl ? data.appUrl.replace(/\/+$/, '') : undefined;
  const ctaUrl = appUrl ? `${appUrl}${COACH_PATH}` : undefined;
  const ctaLabel = ctaUrl ? PLAN_MY_WEEK_LABEL : undefined;
  const preferencesUrl = appUrl ? `${appUrl}${NOTIFICATION_PREFERENCES_PATH}` : undefined;
  const headline = prose.headline.trim() || 'Your week in review';
  const wins = (prose.wins ?? []).filter((w) => typeof w === 'string' && w.trim().length > 0);
  const focus = typeof prose.focus === 'string' ? prose.focus.trim() : '';
  const introParagraphs = splitParagraphs(prose.intro);
  const facts = weeklyReviewStatRows(stats).map(([label, value]) => ({ label, value }));

  const eyebrow = 'Weekly review';
  const weekLabel = `Week ${stats.isoWeek} (${stats.weekStart} to ${stats.weekEnd})`;
  const personaLine = `${data.personaName} says:`;
  // Without an app URL the footer has no "Manage email preferences" link, so
  // the reason says where the setting lives instead.
  const footerReason =
    `This is your weekly review from your ${APP_NAME} coach.` +
    (preferencesUrl ? '' : ' You can choose which coach messages reach your inbox under Settings, Notifications.');

  // Every value below is interpolated through the `html` tag or passed as a
  // plain string to a layout component, which escapes it: no model text is
  // ever emitted as markup.
  const winsHtml =
    wins.length > 0
      ? html`${paragraph(html`<strong>${WINS_TITLE}</strong>`)}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:0 0 20px 0;">
            <ul style="margin:0;padding:0 0 0 20px;font-size:15px;line-height:24px;">${wins.map((win) => html`<li>${win}</li>`)}</ul>
          </td></tr></table>`
      : SafeHtml.EMPTY;

  const bodyHtml = html`
    ${paragraph(weekLabel, { tone: 'muted' })}
    ${paragraph(html`<strong>${personaLine}</strong>`)}
    ${introParagraphs.map((text) => paragraph(text))}
    ${detailRows(facts)}
    ${winsHtml}
    ${focus ? callout({ tone: 'info', title: FOCUS_TITLE, body: focus }) : SafeHtml.EMPTY}
  `;

  const htmlDocument = renderLayout({
    title: headline,
    eyebrow,
    // The subject already shows the headline beside the preheader; the
    // preheader carries the persona's opening line instead.
    previewText: introParagraphs[0] ? truncate(introParagraphs[0], PREVIEW_TEXT_MAX) : weekLabel,
    bodyHtml,
    ctaLabel,
    ctaUrl,
    footerReason,
    preferencesUrl,
  });

  // Hand-written, same content in the same order (see `plainText` in layout.ts).
  const lines: [string, ...string[]] = [weekLabel, '', personaLine];
  lines.push(introParagraphs.join('\r\n\r\n') || prose.intro, '', ...textDetailLines(facts));
  if (wins.length > 0) lines.push('', `${WINS_TITLE}:`, ...wins.map((w) => `  - ${w}`));
  if (focus) lines.push('', ...textCallout({ tone: 'info', title: FOCUS_TITLE, body: focus }));

  const text = plainText({
    eyebrow,
    title: headline,
    lines,
    ctaLabel,
    ctaUrl,
    footerReason,
    preferencesUrl,
  });

  return {
    subject: subjectLine(headline),
    html: htmlDocument,
    text,
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
    attachments: layoutAttachments(),
  };
}
