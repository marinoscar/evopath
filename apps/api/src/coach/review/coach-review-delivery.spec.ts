import { NOW, createdOf, setupReview } from '../../../test/coach/coach-weekly-review.fixtures';
import { findEmailTemplate } from '../../email/templates';
import { EVENT_BROWSER_TEMPLATES } from '../../notifications/channels/browser-notification.channel';
import { EVENT_EMAIL_TEMPLATES } from '../../notifications/channels/email-notification.channel';
import { CoachMessageDeliverHandler } from '../nudges/handlers/coach-message-deliver.handler';

// =============================================================================
// A weekly review from the job to the channels (E7.10 AC 5, 6, 6a, 7)
// =============================================================================
//
// The row `ai.coach.weekly_review` persists is handed to
// `coach.message.deliver`; its `notifyNow` payload is rendered by the real
// email and browser templates. Proves: the email gets the stats and the
// CLEAN prose, the browser/push half only the lock-screen teaser, and the
// review is outside the daily cap.
// =============================================================================

const MESSAGE = '00000000-0000-4000-8000-0000000000b1';
const USER = '00000000-0000-4000-8000-000000000001';

async function persistedReview(options: Parameters<typeof setupReview>[0] = {}) {
  const t = setupReview(options);
  await t.handler.run('job-1', { userId: USER, isoWeek: '2026-W40' }, NOW);
  return createdOf(t);
}

function deliverer(row: Record<string, any>, appUrl: string | null = 'https://app.example.com') {
  const prisma = {
    coachMessage: {
      findUnique: jest.fn(async () => ({
        ...row,
        id: MESSAGE,
        deliveredAt: null,
        audioStatus: 'none',
        user: { healthProfile: { timeZone: 'Europe/Madrid' } },
      })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const notifications = {
    notifyNow: jest.fn(async (_event: string, _user: string, _data: Record<string, any>) => ({
      rateLimited: false,
      retryAfterMs: null,
      notificationId: 'inbox-1',
    })),
  };
  const coachState = { recordNudgeSent: jest.fn() };
  const config = { get: jest.fn((key: string) => (key === 'appUrl' ? (appUrl ?? undefined) : undefined)) };
  const handler = new CoachMessageDeliverHandler(
    { register: jest.fn() } as never,
    prisma as never,
    notifications as never,
    coachState as never,
    { coachNudgeDelivered: jest.fn() } as never,
    config as never,
  );
  return { handler, notifications, coachState };
}

describe('weekly review delivery', () => {
  it('raises coach.weekly_review with the email payload and does not count against the daily cap', async () => {
    const row = await persistedReview();
    const d = deliverer(row);
    await expect(d.handler.deliver(MESSAGE, NOW)).resolves.toMatchObject({ status: 'delivered', eventKey: 'coach.weekly_review' });
    expect(d.coachState.recordNudgeSent).not.toHaveBeenCalled();

    const [, , data] = d.notifications.notifyNow.mock.calls[0];
    expect(data).toMatchObject({
      messageId: MESSAGE,
      personaName: 'Coach',
      stats: row.data.stats,
      prose: {
        headline: row.data.emailProse.headline,
        intro: row.data.emailProse.intro,
        wins: row.data.emailProse.wins,
        focus: row.data.emailProse.focus,
      },
      appUrl: 'https://app.example.com',
    });
  });

  it('the payload renders through the registered email template: stats, clean prose, CTA, preferences', async () => {
    const row = await persistedReview();
    const d = deliverer(row);
    await d.handler.deliver(MESSAGE, NOW);
    const [eventKey, , data] = d.notifications.notifyNow.mock.calls[0];

    const template = findEmailTemplate(EVENT_EMAIL_TEMPLATES[eventKey]!)!;
    const email = template(data as never);
    expect(email.subject).toContain(row.data.emailProse.headline);
    expect(email.html).toContain(`${row.data.stats.completed} of ${row.data.stats.planned} completed`);
    expect(email.html).toContain('https://app.example.com/coach');
    expect(email.html).toContain('https://app.example.com/settings/notifications');
  });

  it('unlocked Sarge L3: the in-app card keeps the profane intro, the email renders the clean one (AC 6a)', async () => {
    const profane = {
      headline: 'Weekly report, recruit',
      intro: 'Not a bad damn week, recruit. You moved real weight. Now do it again.',
      wins: [],
      focus: 'Own your Wednesday.',
      nextWeekPlanPrompt: 'Plan my next week.',
    };
    const clean = { ...profane, intro: 'Not a bad week, recruit. You moved real weight. Now do it again.' };
    const row = await persistedReview({
      coach: { personaId: 'drill_sergeant', intensity: 3, profanity: true, adultConfirmedAt: '2026-01-01T00:00:00Z' },
      system: { allowProfanePersonas: true },
      answers: [profane, clean],
    });
    expect(row.body).toContain('damn');

    const d = deliverer(row);
    await d.handler.deliver(MESSAGE, NOW);
    const [eventKey, , data] = d.notifications.notifyNow.mock.calls[0];
    const email = findEmailTemplate(EVENT_EMAIL_TEMPLATES[eventKey]!)!(data as never);
    expect(email.html).not.toMatch(/damn/i);
    expect(email.subject).not.toMatch(/damn/i);
    expect(email.text).not.toMatch(/damn/i);
    expect(email.html).toContain('Sarge says:');
  });

  it('the browser and push half carries only the lock-screen-safe teaser, never stats (AC 7)', async () => {
    const row = await persistedReview();
    const d = deliverer(row);
    await d.handler.deliver(MESSAGE, NOW);
    const [eventKey, , data] = d.notifications.notifyNow.mock.calls[0];

    const content = EVENT_BROWSER_TEMPLATES[eventKey]!(data as never);
    expect(content).toEqual({
      title: 'Your week in review',
      body: 'Coach has your weekly review.',
      link: `/coach?m=${MESSAGE}`,
      data: { messageId: MESSAGE },
    });
    expect(`${content.title} ${content.body}`).not.toMatch(/\d/);
  });

  it('without an app URL the email omits its links but still renders', async () => {
    const row = await persistedReview();
    const d = deliverer(row, null);
    await d.handler.deliver(MESSAGE, NOW);
    const [eventKey, , data] = d.notifications.notifyNow.mock.calls[0];
    expect(data.appUrl).toBeUndefined();
    const email = findEmailTemplate(EVENT_EMAIL_TEMPLATES[eventKey]!)!(data as never);
    expect(email.html).not.toContain('href="https://');
  });

  it('a stored review whose data does not parse still delivers in-app; the email template refuses it', async () => {
    const row = await persistedReview();
    const d = deliverer({ ...row, data: { version: 99 } });
    await expect(d.handler.deliver(MESSAGE, NOW)).resolves.toMatchObject({ status: 'delivered' });
    const [eventKey, , data] = d.notifications.notifyNow.mock.calls[0];
    expect(() => findEmailTemplate(EVENT_EMAIL_TEMPLATES[eventKey]!)!(data as never)).toThrow(TypeError);
  });
});
