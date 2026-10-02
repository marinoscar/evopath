import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { ADMIN_SECTIONS, visibleSettingsSections } from '../../config/adminSections';
import { USER_SETTINGS_SECTIONS } from '../../config/userSettingsSections';

/**
 * Cross-cutting AI registry parity (issue #435, epic #419).
 *
 * `settingsRegistry.test.ts`'s "the AI group (#425)" and "AI Keys" cases
 * already pin the individual cards' identity, feature flags and gate
 * behavior — this file does NOT re-test that. What it adds is the piece
 * #425's own suite does not do for its AI cards (unlike its own Storage and
 * About cases): checking each card's `permission` against the LITERAL
 * string the API controller enforces, read off the API workspace's source
 * on disk — the mechanical half of CLAUDE.md's Settings UI Pattern rule 3 —
 * and doing so GENERICALLY, over every card this registry tags `feature:
 * 'ai'` or routes under an AI path, so a fifth AI card added later is
 * covered with no edit to this file.
 */

const API_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../api/src');

function readApiSource(relPath: string): string {
  return readFileSync(resolve(API_SRC, relPath), 'utf8');
}

const rolesConstants = readApiSource('common/constants/roles.constants.ts');
const aiAdminController = readApiSource('ai/config/ai-admin.controller.ts');
const aiAssignmentsController = readApiSource('ai/assignments/ai-assignments-admin.controller.ts');
const userAiKeysController = readApiSource('ai/keys/user-ai-keys.controller.ts');
// E7.3 (#243): the coach's two controllers, user and admin.
const coachSettingsController = readApiSource('coach/coach-settings.controller.ts');
const coachAdminController = readApiSource('coach/admin/coach-admin-settings.controller.ts');

/** Every admin + user card whose destination is part of the AI surface. */
function allAiTaggedCards() {
  const admin = ADMIN_SECTIONS.flatMap((section) => section.cards).filter(
    (card) => card.feature === 'ai' || card.path?.startsWith('/admin/settings/ai'),
  );
  const user = USER_SETTINGS_SECTIONS.flatMap((section) => section.cards).filter(
    (card) => card.feature === 'ai' || card.path?.startsWith('/settings/ai'),
  );

  return { admin, user, all: [...admin, ...user] };
}

describe('AI settings registry — literal permission parity with the API (#435)', () => {
  it('roles.constants.ts declares exactly the three literal AI permission strings this file checks against', () => {
    // Anchors the comparison itself: if these three literals ever drifted in
    // roles.constants.ts, every check below would quietly compare the
    // registry against a stale string instead of the real one.
    expect(rolesConstants).toContain("AI_CONFIG_READ: 'ai_config:read'");
    expect(rolesConstants).toContain("AI_CONFIG_WRITE: 'ai_config:write'");
    expect(rolesConstants).toContain("AI_USE: 'ai:use'");
  });

  it('finds the AI-tagged cards at all, so a broken discovery cannot pass vacuously', () => {
    const { admin, user } = allAiTaggedCards();
    expect(admin.length).toBeGreaterThanOrEqual(3); // AI, AI Models, AI Usage
    expect(user.length).toBeGreaterThanOrEqual(1); // AI Keys
  });

  describe('admin cards under /admin/settings/ai/*', () => {
    it('every one declares a permission the AI admin controller actually enforces, never invented', () => {
      const { admin } = allAiTaggedCards();
      const offenders = admin.filter(
        (card) => card.permission !== 'ai_config:read' && card.permission !== 'ai_config:write',
      );

      expect(offenders.map((c) => c.title)).toEqual([]);
    });

    it('ai-admin.controller.ts really does enforce PERMISSIONS.AI_CONFIG_READ on a GET route', () => {
      expect(aiAdminController).toContain('PERMISSIONS.AI_CONFIG_READ');
      expect(aiAdminController).toContain('PERMISSIONS.AI_CONFIG_WRITE');
    });

    it('ai-assignments-admin.controller.ts (#173) enforces the same read/write pair', () => {
      expect(aiAssignmentsController).toMatch(/@Get\('assignments'\)\s*@Auth\(\{ permissions: \[PERMISSIONS\.AI_CONFIG_READ\] \}\)/);
      expect(aiAssignmentsController).toMatch(/@Put\('assignments'\)\s*@Auth\(\{ permissions: \[PERMISSIONS\.AI_CONFIG_WRITE\] \}\)/);
    });

    it('coach-admin-settings.controller.ts (E7.3) enforces the same read/write pair the Coach card relies on', () => {
      expect(coachAdminController).toMatch(/@Get\('settings'\)\s*@Auth\(\{ permissions: \[PERMISSIONS\.AI_CONFIG_READ\] \}\)/);
      expect(coachAdminController).toMatch(/@Put\('settings'\)\s*@Auth\(\{ permissions: \[PERMISSIONS\.AI_CONFIG_WRITE\] \}\)/);
      const { admin } = allAiTaggedCards();
      expect(admin.find((card) => card.path === '/admin/settings/coach')?.permission).toBe('ai_config:read');
    });

    it('is never confused with ai:use — an admin AI card must not mirror the per-user permission', () => {
      const { admin } = allAiTaggedCards();
      expect(admin.every((card) => card.permission !== 'ai:use')).toBe(true);
    });
  });

  describe('user cards under /settings/ai (AI Keys)', () => {
    it('declares exactly ai:use, the literal string user-ai-keys.controller.ts enforces', () => {
      const { user } = allAiTaggedCards();
      const offenders = user.filter((card) => card.permission !== 'ai:use');

      expect(offenders.map((c) => c.title)).toEqual([]);
    });

    it('coach-settings.controller.ts (E7.3) enforces PERMISSIONS.AI_USE behind AiEnabledGuard', () => {
      expect(coachSettingsController).toContain('@UseGuards(AiEnabledGuard)');
      expect(coachSettingsController).toMatch(/@Get\('settings'\)\s*@Auth\(\{ permissions: \[PERMISSIONS\.AI_USE\] \}\)/);
      expect(coachSettingsController).toMatch(/@Put\('settings'\)\s*@Auth\(\{ permissions: \[PERMISSIONS\.AI_USE\] \}\)/);
      const { user } = allAiTaggedCards();
      expect(user.find((card) => card.path === '/settings/coach')?.permission).toBe('ai:use');
    });

    // #325. The memory controller is built in parallel with this card; the
    // literal check runs as soon as the file exists in this tree.
    it.skipIf(!existsSync(resolve(API_SRC, 'memory/memory.controller.ts')))(
      'memory.controller.ts (#325) enforces PERMISSIONS.AI_USE behind AiEnabledGuard',
      () => {
        const memoryController = readApiSource('memory/memory.controller.ts');
        expect(memoryController).toContain('AiEnabledGuard');
        expect(memoryController).toContain('PERMISSIONS.AI_USE');
        expect(memoryController).not.toMatch(/PERMISSIONS\.AI_CONFIG_/);
      },
    );

    it('the Memory card (#325) declares exactly ai:use', () => {
      const { user } = allAiTaggedCards();
      expect(user.find((card) => card.path === '/settings/memory')).toMatchObject({
        permission: 'ai:use',
        feature: 'ai',
      });
    });

    it('user-ai-keys.controller.ts really does enforce PERMISSIONS.AI_USE', () => {
      expect(userAiKeysController).toContain('PERMISSIONS.AI_USE');
    });

    it('is never confused with ai_config:* — a per-user card must not mirror the deployment-wide permission', () => {
      const { user } = allAiTaggedCards();
      expect(user.every((card) => card.permission !== 'ai_config:read' && card.permission !== 'ai_config:write')).toBe(
        true,
      );
    });
  });

  describe('feature gating: every AI card is feature-gated except the one that switches AI on', () => {
    it('every AI-tagged card declares feature: "ai", except the admin AI card itself', () => {
      const { all } = allAiTaggedCards();
      const missingFeature = all
        .filter((card) => card.path !== '/admin/settings/ai')
        .filter((card) => card.feature !== 'ai')
        .map((card) => card.title);

      expect(missingFeature).toEqual([]);
    });

    it('the admin AI card (the switch itself) deliberately carries no feature gate', () => {
      const { admin } = allAiTaggedCards();
      const switchCard = admin.find((card) => card.path === '/admin/settings/ai');

      expect(switchCard?.feature).toBeUndefined();
    });

    it('every AI card is deniable — none is an alwaysShow escape hatch', () => {
      const { all } = allAiTaggedCards();
      expect(all.every((card) => card.alwaysShow === undefined)).toBe(true);
    });
  });

  describe('the whole set stays invisible with no ai_config/ai:use permission held, feature on', () => {
    it('an admin holding every OTHER permission still sees no AI card', () => {
      const nonAi = ['system_settings:read', 'users:read', 'jobs:read', 'nodes:read', 'broadcasts:read'];
      const result = visibleSettingsSections(
        ADMIN_SECTIONS,
        (permission) => nonAi.includes(permission),
        '',
        { ai: true },
      );

      const titles = result.flatMap((section) => section.cards.map((card) => card.title));
      expect(titles).not.toContain('AI');
      expect(titles).not.toContain('AI Models');
      expect(titles).not.toContain('AI Usage');
      expect(titles).not.toContain('AI Model Assignments');
      expect(titles).not.toContain('Coach');
    });
  });
});
