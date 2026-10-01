import { NOTIFICATION_EVENTS } from '../notification-events';
import { EVENT_BROWSER_TEMPLATES } from './browser-notification.channel';

// =============================================================================
// The health export's notifications (H7, #191): registry entries and browser
// templates. The payload is the export id and format, never a value or URL.
// =============================================================================

describe('health export notifications', () => {
  it.each(['health.export_ready', 'health.export_failed'])(
    '%s is registered for browser and push, on by default, not mandatory',
    (key) => {
      const event = NOTIFICATION_EVENTS.find((e) => e.key === key);
      expect(event).toMatchObject({ channels: ['browser', 'push'], defaultEnabled: true });
      expect(event?.mandatory ?? false).toBe(false);
    },
  );

  it('ready names the format and links to the health page', () => {
    const content = EVENT_BROWSER_TEMPLATES['health.export_ready']!({ exportId: 'e', format: 'pdf' } as never);
    expect(content).toEqual({
      title: 'Your health export is ready',
      body: 'Your PDF health data export is ready to download for the next 7 days.',
      link: '/health',
    });
  });

  it('failed asks to try again, and tolerates an unknown format', () => {
    const content = EVENT_BROWSER_TEMPLATES['health.export_failed']!({ exportId: 'e', format: 'docx' } as never);
    expect(content.title).toBe('Your health export failed');
    expect(content.body).toBe('Your health data export could not be created. Please try again.');
    expect(content.link).toBe('/health');
  });
});
