import { TRANSACTIONAL_EMAIL_HEADERS } from './email-template.types';
import {
  coachWeeklyReviewEmail,
  weeklyReviewStatRows,
  type CoachWeeklyReviewEmailData,
} from './coach-weekly-review.email';

// =============================================================================
// coach.weekly_review email (E7.10 AC 6): stats table, persona intro, wins,
// focus, "Plan my week" to /coach, the preferences link, transactional
// headers, escaping, the text part.
// =============================================================================

const DATA: CoachWeeklyReviewEmailData = {
  messageId: 'review-1',
  personaName: 'Coach',
  stats: {
    isoWeek: '2026-W40',
    weekStart: '2026-09-28',
    weekEnd: '2026-10-04',
    planned: 4,
    completed: 3,
    adherencePct: 75,
    weeklyStreak: 5,
    streakPassesLeft: 1,
    prs: [
      { exercise: 'Bench Press', value: 82.5, unit: 'kg', reps: 5 },
      { exercise: 'Pull-up', value: 12, unit: 'reps', reps: null },
    ],
    checkIns: 4,
    photosAdded: 1,
    nextWeekSessions: 3,
    noPlan: false,
  },
  prose: {
    headline: 'A solid week of work',
    intro: 'You showed up for most of your plan.',
    wins: ['A new best on Bench Press', 'Three sessions done'],
    focus: 'Protect your Wednesday session.',
  },
  appUrl: 'https://app.example.com/',
};

describe('coachWeeklyReviewEmail', () => {
  const email = coachWeeklyReviewEmail(DATA);

  it('subject carries the headline', () => {
    expect(email.subject).toBe('Your weekly review: A solid week of work');
  });

  it('carries the transactional headers', () => {
    expect(email.headers).toEqual(TRANSACTIONAL_EMAIL_HEADERS);
  });

  it('renders the persona intro, the stats table, wins and focus', () => {
    expect(email.html).toContain('Coach says:');
    expect(email.html).toContain('You showed up for most of your plan.');
    for (const value of ['3 of 4 completed', '75%', '5 weeks (1 streak pass left)', 'Bench Press: 82.5 kg x 5', 'Pull-up: 12 reps', '4 days', '3 sessions planned']) {
      expect(email.html).toContain(value);
      expect(email.text).toContain(value);
    }
    expect(email.html).toContain('<li>A new best on Bench Press</li>');
    expect(email.html).toContain('Protect your Wednesday session.');
  });

  it('"Plan my week" links to /coach; the preferences link to /settings/notifications', () => {
    expect(email.html).toContain('href="https://app.example.com/coach"');
    expect(email.html).toContain('Plan my week');
    expect(email.html).toContain('href="https://app.example.com/settings/notifications"');
    expect(email.text).toContain('Plan my week: https://app.example.com/coach');
    expect(email.text).toContain('https://app.example.com/settings/notifications');
  });

  it('without an app URL, the links are omitted and the preferences hint stays', () => {
    const plain = coachWeeklyReviewEmail({ ...DATA, appUrl: undefined });
    expect(plain.html).not.toContain('href="https://');
    expect(plain.html).toContain('Settings, Notifications');
    expect(plain.text).toContain('Settings, Notifications');
  });

  it('the text part says what the HTML says, with CRLF endings', () => {
    expect(email.text).toContain('Coach says:\r\nYou showed up for most of your plan.');
    expect(email.text).toContain('  - Three sessions done');
    expect(email.text).toContain('Focus for next week:');
  });

  it('escapes every piece of model text and every name (no raw model HTML)', () => {
    const hostile = coachWeeklyReviewEmail({
      ...DATA,
      personaName: '<b>Sarge</b>',
      stats: { ...DATA.stats, prs: [{ exercise: '<script>x()</script>', value: 1, unit: 'kg', reps: 1 }] },
      prose: {
        headline: '"><img src=x onerror=alert(1)>',
        intro: '<script>alert(1)</script>',
        wins: ['<iframe src="javascript:alert(1)">'],
        focus: '<a href="javascript:alert(1)">x</a>',
      },
    });
    expect(hostile.html).not.toMatch(/<script|<img|<iframe|<b>Sarge|href="javascript/i);
    expect(hostile.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(hostile.subject).not.toMatch(/[<>]/);
  });

  it('the subject is one line even if the headline is not', () => {
    const multi = coachWeeklyReviewEmail({ ...DATA, prose: { ...DATA.prose, headline: 'Good\r\nBcc: someone@example.com' } });
    expect(multi.subject).not.toMatch(/[\r\n]/);
  });

  it('a week with nothing planned shows "No plan this week", never 0 %', () => {
    const rows = weeklyReviewStatRows({ ...DATA.stats, planned: 0, completed: 1, adherencePct: null, noPlan: true });
    expect(rows).toContainEqual(['Adherence', 'No plan this week']);
    expect(rows).toContainEqual(['Sessions', '1 completed (no plan this week)']);
    expect(JSON.stringify(rows)).not.toContain('0%');
  });

  it('an empty wins list and focus render no empty sections', () => {
    const bare = coachWeeklyReviewEmail({ ...DATA, prose: { ...DATA.prose, wins: [], focus: '' } });
    expect(bare.html).not.toContain('<ul');
    expect(bare.html).not.toContain('Focus for next week');
    expect(bare.text).not.toContain('Wins:');
  });

  it('refuses a payload without the review (the channel records the failed delivery)', () => {
    expect(() => coachWeeklyReviewEmail({ messageId: 'x' } as never)).toThrow(TypeError);
  });
});
