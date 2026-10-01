import { NOTIFICATION_EVENTS } from '../notification-events';
import { EVENT_BROWSER_TEMPLATES, sanitizeLink } from './browser-notification.channel';
import { EVENT_EMAIL_TEMPLATES } from './email-notification.channel';
import { pushActionsOf } from './push-notification.channel';

// =============================================================================
// The AI Coach notifications (E7.5, #245; docs/specs/ai-coach.md §3.5)
// =============================================================================

const KEYS = ['coach.nudge', 'coach.celebration', 'coach.photo_prompt', 'coach.weekly_review'] as const;

describe('coach notification events', () => {
  it.each([
    ['coach.nudge', ['browser', 'push']],
    ['coach.celebration', ['browser', 'push']],
    ['coach.photo_prompt', ['browser', 'push']],
    ['coach.weekly_review', ['email', 'browser', 'push']],
  ])('%s is registered for %j, on by default, not mandatory', (key, channels) => {
    const event = NOTIFICATION_EVENTS.find((e) => e.key === key);
    expect(event).toMatchObject({ channels, defaultEnabled: true });
    expect(event?.mandatory ?? false).toBe(false);
  });

  it('the weekly review has an email template (E7.10 fleshes it out)', () => {
    expect(EVENT_EMAIL_TEMPLATES['coach.weekly_review']).toBe('coach-weekly-review');
  });

  it.each(KEYS)('%s renders the lock-screen pair and links to /coach?m=<id>', (key) => {
    const content = EVENT_BROWSER_TEMPLATES[key]!({ messageId: 'msg-1', pushTitle: 'Safe title', pushBody: 'Safe body' } as never);
    expect(content).toEqual({ title: 'Safe title', body: 'Safe body', link: '/coach?m=msg-1', data: { messageId: 'msg-1' } });
    expect(sanitizeLink(content.link)).toBe('/coach?m=msg-1');
  });

  it('adds the "Hear Coach" action only when the audio is ready', () => {
    const content = EVENT_BROWSER_TEMPLATES['coach.nudge']!({
      messageId: 'msg-1',
      pushTitle: 't',
      pushBody: 'b',
      hasAudio: true,
    } as never);
    expect(content.actions).toEqual([{ action: 'hear', title: '▶ Hear Coach', link: '/coach?m=msg-1&autoplay=1' }]);
  });

  it('refuses a malformed payload inside the template (a recorded delivery failure, not a crash later)', () => {
    expect(() => EVENT_BROWSER_TEMPLATES['coach.nudge']!({ messageId: 'msg-1' } as never)).toThrow(TypeError);
  });
});

describe('pushActionsOf', () => {
  it('keeps valid actions, drops off-origin links and bad ids, caps at two', () => {
    expect(
      pushActionsOf({
        title: 't',
        body: 'b',
        actions: [
          { action: 'hear', title: 'Hear', link: '/coach?m=1&autoplay=1' },
          { action: 'evil', title: 'Evil', link: 'https://evil.example.com' },
          { action: 'Bad Id', title: 'Bad', link: '/x' },
          { action: 'two', title: 'Two', link: '/two' },
          { action: 'three', title: 'Three', link: '/three' },
        ],
      }),
    ).toEqual([
      { action: 'hear', title: 'Hear', link: '/coach?m=1&autoplay=1' },
      { action: 'two', title: 'Two', link: '/two' },
    ]);
    expect(pushActionsOf({ title: 't', body: 'b' })).toEqual([]);
  });
});
