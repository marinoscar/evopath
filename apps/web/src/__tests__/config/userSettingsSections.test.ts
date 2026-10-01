import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  USER_HUB_PATH,
  USER_HUB_TITLE,
  USER_SETTINGS_SECTIONS,
} from '../../config/userSettingsSections';
import { settingsPageTitle, visibleSettingsSections } from '../../config/adminSections';

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
    // #190 (H6): the exact string the health documents controller's reads enforce.
    '/settings/health-documents': 'health_data:read',
    // Training agents: the exact string `/api/ai/training/*` enforces.
    '/settings/ai/agents': 'ai:use',
    // E7.3 (#243): the exact string `coach-settings.controller.ts` enforces.
    '/settings/coach': 'ai:use',
    // #283 (epic #276): the exact string the health-sync controller's reads enforce.
    '/settings/connected-devices': 'goals:read',
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
  it('appends an AI group directly after Health', () => {
    const labels = USER_SETTINGS_SECTIONS.map((section) => section.label);
    expect(labels.indexOf('AI')).toBe(labels.indexOf('Health') + 1);
  });

  it('declares the Training agents card with ai:use and the ai feature gate', () => {
    const ai = USER_SETTINGS_SECTIONS.find((section) => section.label === 'AI');
    const card = ai?.cards.find((c) => c.path === '/settings/ai/agents');
    expect(card).toMatchObject({ title: 'Training agents', permission: 'ai:use', feature: 'ai' });
  });
});

/**
 * Issue #202. The per-user factory reset lives in a NEW `Danger Zone` group,
 * appended after `AI` as the LAST group (append, never insert). No
 * `permission` (the API enforces `user_settings:write`, which every role
 * holds) and no `feature` (it must stay reachable while AI is off).
 */
describe('USER_SETTINGS_SECTIONS - Danger Zone card (issue #202)', () => {
  it('appends a Danger Zone group after AI, as the last group', () => {
    const labels = USER_SETTINGS_SECTIONS.map((section) => section.label);
    expect(labels.indexOf('Danger Zone')).toBe(labels.indexOf('AI') + 1);
    expect(labels[labels.length - 1]).toBe('Danger Zone');
  });

  it('declares the Delete all my data card with no permission and no feature gate', () => {
    const group = USER_SETTINGS_SECTIONS.find((section) => section.label === 'Danger Zone');
    expect(group?.cards).toHaveLength(1);
    const card = group?.cards[0];
    expect(card?.title).toBe('Delete all my data');
    expect(card?.path).toBe('/settings/danger-zone');
    expect(card?.permission).toBeUndefined();
    expect(card?.feature).toBeUndefined();
  });
});

/**
 * Issue #190 (H6). Health Documents is APPENDED to the `Health` group after
 * Health Profile, as its own destination (not a tab on Health Profile), gated
 * on the exact string `health-documents.controller.ts` enforces on its reads.
 * The permission is read off the API workspace on disk, the mechanical half of
 * CLAUDE.md Settings UI Pattern rule 3.
 */
describe('USER_SETTINGS_SECTIONS - Health Documents card (issue #190)', () => {
  const API_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../api/src');
  const health = USER_SETTINGS_SECTIONS.find((section) => section.label === 'Health');
  const card = health?.cards.find((c) => c.path === '/settings/health-documents');

  it('is appended after Health Profile in the Health group', () => {
    // `Connected devices` (#283) is appended after it.
    expect(health?.cards.map((c) => c.title).slice(0, 2)).toEqual(['Health Profile', 'Health Documents']);
  });

  it('declares health_data:read, no feature gate and no alwaysShow', () => {
    expect(card).toMatchObject({ title: 'Health Documents', permission: 'health_data:read' });
    expect(card?.feature).toBeUndefined();
    expect(card?.alwaysShow).toBeUndefined();
    expect(card?.disabled).toBeUndefined();
  });

  it('declares the exact permission the documents controller enforces on its reads', () => {
    const roles = readFileSync(resolve(API_SRC, 'common/constants/roles.constants.ts'), 'utf8');
    const controller = readFileSync(
      resolve(API_SRC, 'health-documents/health-documents.controller.ts'),
      'utf8',
    );
    expect(roles).toContain("HEALTH_DATA_READ: 'health_data:read'");
    expect(controller).toContain('@Auth({ permissions: [PERMISSIONS.HEALTH_DATA_READ] })');
  });

  it('is visible with health_data:read, hidden without it, and titles its route', () => {
    const titles = (granted: string[]) =>
      visibleSettingsSections(USER_SETTINGS_SECTIONS, (p) => granted.includes(p)).flatMap((s) =>
        s.cards.map((c) => c.title),
      );
    expect(titles(['health_data:read'])).toContain('Health Documents');
    expect(titles([])).not.toContain('Health Documents');
    expect(
      settingsPageTitle(
        USER_SETTINGS_SECTIONS,
        USER_HUB_PATH,
        USER_HUB_TITLE,
        '/settings/health-documents',
      ),
    ).toBe('Health Documents');
  });
});

/**
 * E7.3 (#243). The Coach card is APPENDED to the `AI` group after Training
 * agents, gated on `ai:use` (the literal string the coach settings controller
 * enforces, read off the API source on disk) and hidden while AI is off.
 */
describe('USER_SETTINGS_SECTIONS - Coach card (E7.3, #243)', () => {
  const API_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../api/src');
  const ai = USER_SETTINGS_SECTIONS.find((section) => section.label === 'AI');

  it('is appended after Training agents, the last card of the AI group', () => {
    expect(ai?.cards.map((card) => card.title)).toEqual(['Training agents', 'Coach']);
  });

  it('declares ai:use and the ai feature gate', () => {
    const card = ai?.cards.find((c) => c.path === '/settings/coach');
    expect(card).toMatchObject({ title: 'Coach', permission: 'ai:use', feature: 'ai' });
  });

  it('matches the permission coach-settings.controller.ts enforces on every route', () => {
    const controller = readFileSync(resolve(API_SRC, 'coach/coach-settings.controller.ts'), 'utf8');
    const auths = controller.match(/@Auth\(\{ permissions: \[PERMISSIONS\.[A-Z_]+\] \}\)/g) ?? [];
    expect(auths.length).toBeGreaterThanOrEqual(3);
    expect(new Set(auths)).toEqual(new Set(['@Auth({ permissions: [PERMISSIONS.AI_USE] })']));
    expect(controller).toContain('@UseGuards(AiEnabledGuard)');
  });

  it('titles /settings/coach "Coach" while AI is on and falls back to the hub title while it is off', () => {
    expect(
      settingsPageTitle(USER_SETTINGS_SECTIONS, USER_HUB_PATH, USER_HUB_TITLE, '/settings/coach', { ai: true }),
    ).toBe('Coach');
    expect(settingsPageTitle(USER_SETTINGS_SECTIONS, USER_HUB_PATH, USER_HUB_TITLE, '/settings/coach')).toBe(
      USER_HUB_TITLE,
    );
  });

  it('is hidden while AI is off and without ai:use', () => {
    const titles = (features: Record<string, boolean>, perms: string[]) =>
      visibleSettingsSections(USER_SETTINGS_SECTIONS, (p) => perms.includes(p), '', features).flatMap((s) =>
        s.cards.map((c) => c.title),
      );
    expect(titles({ ai: true }, ['ai:use'])).toContain('Coach');
    expect(titles({ ai: false }, ['ai:use'])).not.toContain('Coach');
    expect(titles({ ai: true }, [])).not.toContain('Coach');
  });
});

/**
 * Issue #283, epic #276. Connected devices is APPENDED to the `Health` group
 * after Health Documents, gated on `goals:read` — the exact string every read
 * route of the health-sync controller enforces (the contract reuses the goals
 * grants). Not behind any feature flag.
 */
describe('USER_SETTINGS_SECTIONS - Connected devices card (#283)', () => {
  const health = USER_SETTINGS_SECTIONS.find((section) => section.label === 'Health');
  const card = health?.cards.find((c) => c.path === '/settings/connected-devices');

  it('is the last card of the Health group, after Health Documents', () => {
    expect(health?.cards.map((c) => c.title)).toEqual([
      'Health Profile',
      'Health Documents',
      'Connected devices',
    ]);
  });

  it('declares goals:read, no feature gate and no alwaysShow', () => {
    expect(card).toMatchObject({ title: 'Connected devices', permission: 'goals:read' });
    expect(card?.feature).toBeUndefined();
    expect(card?.alwaysShow).toBeUndefined();
    expect(card?.disabled).toBeUndefined();
  });

  it('is visible with goals:read, hidden without it, and titles its route', () => {
    const titles = (granted: string[]) =>
      visibleSettingsSections(USER_SETTINGS_SECTIONS, (p) => granted.includes(p)).flatMap((s) =>
        s.cards.map((c) => c.title),
      );
    expect(titles(['goals:read'])).toContain('Connected devices');
    expect(titles(['goals:write'])).not.toContain('Connected devices');
    expect(
      settingsPageTitle(USER_SETTINGS_SECTIONS, USER_HUB_PATH, USER_HUB_TITLE, '/settings/connected-devices'),
    ).toBe('Connected devices');
  });

  it('is routed in App.tsx behind the same permission', () => {
    const app = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../App.tsx'), 'utf8');
    expect(app).toMatch(
      /path="\/settings\/connected-devices"\s+element=\{\s+<RequirePermission\s+permission="goals:read"/,
    );
  });
});
