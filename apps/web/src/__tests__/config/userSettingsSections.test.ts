import { describe, it, expect } from 'vitest';
import { USER_SETTINGS_SECTIONS } from '../../config/userSettingsSections';

/**
 * Issue #126, epic #109. The Notifications card follows the same
 * MANDATORY settings-registry pattern every other `/settings/*` card does
 * (see CLAUDE.md's "MANDATORY: Settings UI Pattern" and
 * `config/userSettingsSections.tsx`'s own header): declared once, here, with
 * NO `permission` field.
 *
 * Every other card under `USER_SETTINGS_SECTIONS` is unpermissioned for the
 * same reason - these are the caller's OWN settings, and the API grants
 * `user_settings:read` / `user_settings:write` to all three roles. A
 * `permission` field on this card would invent an authorization rule the API
 * does not enforce, and would lock a Viewer out of saying how they want to be
 * contacted.
 */
describe('USER_SETTINGS_SECTIONS - Notifications card (issue #126)', () => {
  function findNotificationsCard() {
    for (const section of USER_SETTINGS_SECTIONS) {
      const card = section.cards.find((c) => c.path === '/settings/notifications');
      if (card) return card;
    }
    return undefined;
  }

  it('is present in the registry', () => {
    const card = findNotificationsCard();
    expect(card).toBeDefined();
    expect(card?.title).toBe('Notifications');
  });

  it('declares no permission - reachable by every authenticated user, not gated on a specific one', () => {
    const card = findNotificationsCard();
    expect(card).toBeDefined();
    expect('permission' in (card as object)).toBe(false);
    expect(card?.permission).toBeUndefined();
  });

  it('points at /settings/notifications', () => {
    const card = findNotificationsCard();
    expect(card?.path).toBe('/settings/notifications');
  });

  it('is grouped under Account, not Security - it is about how the account is contacted, not a credential', () => {
    const accountSection = USER_SETTINGS_SECTIONS.find((s) => s.label === 'Account');
    expect(accountSection?.cards.some((c) => c.path === '/settings/notifications')).toBe(
      true,
    );
  });

  // The wider claim: this is not a one-off omission on this card, it is true
  // of the whole per-user registry (see the file's own header comment). A
  // regression that added a permission ANYWHERE in USER_SETTINGS_SECTIONS
  // would be exactly the kind of invented gate that CLAUDE.md's Settings UI
  // Pattern rule 3 warns against.
  /**
   * Replaces "no card declares a permission" (#425, epic #419), deliberately.
   *
   * Every per-user card edits something the API grants all three roles, so for
   * those a permission would invent a rule the API does not enforce. `AI Keys`
   * is the first exception, and a real one: `ai:use` is a grant a deployment
   * can withhold from a role (AI calls cost money), and the `/api/ai/keys`
   * controller enforces exactly that string. The allow-list keeps the rule for
   * everything else — a new gated user card has to be added here on purpose.
   */
  const PERMISSION_GATED_USER_CARDS: Record<string, string> = {
    '/settings/ai': 'ai:use',
    // #47 (E2.1): the exact string `GET /api/health-profile` enforces.
    '/settings/health-profile': 'health_data:read',
    // Training agents: the exact string `/api/ai/training/*` enforces.
    '/settings/ai/agents': 'ai:use',
  };

  it('only cards listed in PERMISSION_GATED_USER_CARDS declare a permission', () => {
    const allCards = USER_SETTINGS_SECTIONS.flatMap((section) => section.cards);
    for (const card of allCards) {
      const expected = card.path ? PERMISSION_GATED_USER_CARDS[card.path] : undefined;
      expect(card.permission, `${card.title} permission`).toBe(expected);
    }
    // Every allow-listed card still exists — a stale entry is a silent hole.
    for (const path of Object.keys(PERMISSION_GATED_USER_CARDS)) {
      expect(allCards.some((card) => card.path === path), `${path} is registered`).toBe(true);
    }
  });
});

/**
 * Issue #47 (E2.1). The Health Profile card lives in a NEW `Health` group,
 * appended after `Security` (append, never insert), gated on the exact string
 * the API's `GET /api/health-profile` enforces, and not behind the AI feature.
 */
describe('USER_SETTINGS_SECTIONS - Health Profile card (issue #47)', () => {
  it('appends a Health group directly after Security', () => {
    const labels = USER_SETTINGS_SECTIONS.map((section) => section.label);
    expect(labels.indexOf('Health')).toBe(labels.indexOf('Security') + 1);
  });

  it('declares the Health Profile card with health_data:read and no feature gate', () => {
    const health = USER_SETTINGS_SECTIONS.find((section) => section.label === 'Health');
    const card = health?.cards.find((c) => c.path === '/settings/health-profile');
    expect(card).toBeDefined();
    expect(card?.title).toBe('Health Profile');
    expect(card?.permission).toBe('health_data:read');
    expect(card?.feature).toBeUndefined();
  });
});

/**
 * The Training agents card lives in a NEW `AI` group, appended after `Health`
 * (append, never insert), gated on `ai:use` and hidden while AI is off.
 */
describe('USER_SETTINGS_SECTIONS - Training agents card', () => {
  it('appends an AI group after Health, as the last group', () => {
    const labels = USER_SETTINGS_SECTIONS.map((section) => section.label);
    expect(labels.indexOf('AI')).toBe(labels.indexOf('Health') + 1);
    expect(labels[labels.length - 1]).toBe('AI');
  });

  it('declares the Training agents card with ai:use and the ai feature gate', () => {
    const ai = USER_SETTINGS_SECTIONS.find((section) => section.label === 'AI');
    const card = ai?.cards.find((c) => c.path === '/settings/ai/agents');
    expect(card).toMatchObject({ title: 'Training agents', permission: 'ai:use', feature: 'ai' });
  });
});
