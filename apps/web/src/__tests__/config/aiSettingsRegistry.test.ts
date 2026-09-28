import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
const userAiKeysController = readApiSource('ai/keys/user-ai-keys.controller.ts');

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
    });
  });
});
