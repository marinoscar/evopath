import { NOTIFICATION_EVENTS } from '../notification-events';
import { EVENT_BROWSER_TEMPLATES, TRAINING_CHANGE_BODY_MAX } from './browser-notification.channel';

// =============================================================================
// The evaluate graph's notifications: registry entries and browser templates.
// =============================================================================

const PROGRAM = '11111111-1111-4111-8111-111111111111';

describe('training adaptation notifications', () => {
  it.each(['training.plan_adapted', 'training.plan_proposal'])('%s is registered for browser and push, on by default, not mandatory', (key) => {
    const event = NOTIFICATION_EVENTS.find((e) => e.key === key);
    expect(event).toMatchObject({ channels: ['browser', 'push'], defaultEnabled: true });
    expect(event?.mandatory ?? false).toBe(false);
  });

  it('a safety stop stays mandatory', () => {
    expect(NOTIFICATION_EVENTS.find((e) => e.key === 'training.plan_safety_stop')?.mandatory).toBe(true);
  });

  it.each([
    ['training.plan_adapted', 'Your plan was adjusted'],
    ['training.plan_proposal', 'Your coach suggests a change'],
  ] as const)('%s: the title, a body of at most 140 characters of the summary, a link to the history', (key, title) => {
    const template = EVENT_BROWSER_TEMPLATES[key]!;
    const long = template({ programId: PROGRAM, summary: `Squat goes up.  ${'x'.repeat(300)}`, changeLogId: 'c' } as never);
    expect(long.title).toBe(title);
    expect(long.body.length).toBeLessThanOrEqual(TRAINING_CHANGE_BODY_MAX);
    expect(long.body.startsWith('Squat goes up. x')).toBe(true);
    expect(long.link).toBe(`/train/plans/${PROGRAM}/history`);

    const empty = template({ programId: PROGRAM, summary: '', changeLogId: 'c' } as never);
    expect(empty.body.length).toBeGreaterThan(0);
    expect(empty.body.length).toBeLessThanOrEqual(TRAINING_CHANGE_BODY_MAX);
    expect(`${long.body} ${empty.body}`).not.toMatch(/push through/i);
  });
});
