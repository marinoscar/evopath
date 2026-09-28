import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import TuneIcon from '@mui/icons-material/Tune';
import {
  ADMIN_SECTIONS,
  ADMIN_HUB_PATH,
  ADMIN_HUB_TITLE,
  visibleSettingsSections,
  settingsPageTitle,
} from '../../config/adminSections';
import type { SettingsSectionDef } from '../../config/adminSections';
import {
  USER_SETTINGS_SECTIONS,
  USER_HUB_PATH,
  USER_HUB_TITLE,
} from '../../config/userSettingsSections';

/**
 * Issue #91, epic #90 — `visibleSettingsSections` and `settingsPageTitle` are
 * the ONE gate every consumer (hub, rail, AppBar title) runs. A bug here is a
 * bug in three surfaces at once, and this suite is what makes that provable
 * with a single assertion per behavior instead of three near-identical
 * component tests.
 *
 * `visibleSettingsSections` is exercised two ways:
 *   - against a small local FIXTURE, for the cases that need independent
 *     control over `permission` / `alwaysShow` (ADMIN_SECTIONS today has no
 *     `alwaysShow` card, and no card with an undeniable permission either);
 *   - against the REAL `ADMIN_SECTIONS` / `USER_SETTINGS_SECTIONS`, for the
 *     cases that are really about the real data (title-vs-description search,
 *     and "it works for the user registry too").
 */

/** A real Icon component, reused across the fixture — only its identity is asserted anywhere, so one is enough. */
const Icon = TuneIcon;

function buildFixture(): SettingsSectionDef[] {
  return [
    {
      label: 'Alpha',
      cards: [
        { title: 'Open Card', description: 'visible to anyone, no gate', Icon, path: '/x/open' },
        {
          title: 'Gated Card',
          description: 'needs a permission the fixture can deny',
          Icon,
          path: '/x/gated',
          permission: 'alpha:read',
        },
        {
          title: 'Bypass Card',
          description: 'gated, but escapes the gate via alwaysShow',
          Icon,
          path: '/x/bypass',
          permission: 'alpha:write',
          alwaysShow: true,
        },
      ],
    },
    {
      label: 'Beta (fully gated)',
      cards: [
        {
          title: 'Beta Only',
          description: 'the only card in its section, and it is gated',
          Icon,
          path: '/x/beta',
          permission: 'beta:read',
        },
      ],
    },
  ];
}

function titlesOf(sections: SettingsSectionDef[]): string[] {
  return sections.flatMap((section) => section.cards.map((card) => card.title));
}

describe('visibleSettingsSections — permission gating', () => {
  it('drops a card whose permission is not held', () => {
    const result = visibleSettingsSections(buildFixture(), () => false);

    expect(titlesOf(result)).not.toContain('Gated Card');
  });

  it('removes a section entirely once every one of its cards is filtered out, rather than rendering it empty', () => {
    // 'Beta Only' is the section's sole card and is gated, so with every
    // permission denied the whole section must disappear — not survive as a
    // header over zero cards, which reads as a loading failure.
    const result = visibleSettingsSections(buildFixture(), () => false);

    expect(result.find((section) => section.label === 'Beta (fully gated)')).toBeUndefined();
  });

  it('lets alwaysShow bypass the permission gate', () => {
    const result = visibleSettingsSections(buildFixture(), () => false);

    expect(titlesOf(result)).toContain('Bypass Card');
  });

  it('shows a card with no permission declared regardless of what hasPermission answers', () => {
    const result = visibleSettingsSections(buildFixture(), () => false);

    expect(titlesOf(result)).toContain('Open Card');
  });
});

describe('visibleSettingsSections — search', () => {
  it('matches a card title case-insensitively', () => {
    // Grant everything so the search filter is the only thing under test.
    const result = visibleSettingsSections(ADMIN_SECTIONS, () => true, 'mAiL');

    expect(titlesOf(result)).toContain('Email');
  });

  it('does not match a term that appears only in the description, never the title', () => {
    // Email's description reads "...send a test message to prove it works" —
    // "message" is in no card TITLE in ADMIN_SECTIONS. Matching descriptions
    // too would mean a two-letter query surfacing cards on prose the user
    // never sees highlighted, which `visibleSettingsSections`'s own doc
    // comment calls out as the worse, unpredictable result set this design
    // avoids.
    const result = visibleSettingsSections(ADMIN_SECTIONS, () => true, 'message');

    expect(titlesOf(result)).toHaveLength(0);
  });

  it('composes with permission gating: a title match the user lacks permission for stays hidden', () => {
    // 'gated' matches only 'Gated Card' by title in the fixture. It is denied
    // and not alwaysShow, so the hit must not surface — search narrows what is
    // ELIGIBLE to show, it never re-opens a closed permission gate.
    const result = visibleSettingsSections(buildFixture(), () => false, 'gated');

    expect(result).toEqual([]);
  });

  it('treats an empty string query the same as no query argument at all', () => {
    const hasPermission = (permission: string) => permission === 'alpha:read';
    const fixture = buildFixture();

    expect(visibleSettingsSections(fixture, hasPermission, '')).toEqual(
      visibleSettingsSections(fixture, hasPermission),
    );
  });

  it('treats a whitespace-only query the same as no query argument at all', () => {
    const hasPermission = (permission: string) => permission === 'alpha:read';
    const fixture = buildFixture();

    expect(visibleSettingsSections(fixture, hasPermission, '   ')).toEqual(
      visibleSettingsSections(fixture, hasPermission),
    );
  });
});

describe('visibleSettingsSections — works identically against USER_SETTINGS_SECTIONS', () => {
  it('shows every user-settings card that declares no permission and no feature, with no permissions held', () => {
    // Since #425 one user card (`AI Keys`) declares both a permission (`ai:use`)
    // and a feature (`ai`); every other one is still open to any signed-in user.
    const result = visibleSettingsSections(USER_SETTINGS_SECTIONS, () => false);
    const ungated = USER_SETTINGS_SECTIONS.flatMap((section) => section.cards)
      .filter((card) => !card.permission && !card.feature)
      .map((card) => card.title);

    expect(titlesOf(result).sort()).toEqual(ungated.sort());
    expect(titlesOf(result)).not.toContain('AI Keys');
  });

  it('shows every user-settings card once the permission is held and AI is on', () => {
    const result = visibleSettingsSections(USER_SETTINGS_SECTIONS, () => true, '', { ai: true });

    expect(titlesOf(result).sort()).toEqual(titlesOf(USER_SETTINGS_SECTIONS).sort());
  });

  it('still matches by title only for the user registry', () => {
    // Profile's description reads "Your display name and profile image..." —
    // "display" is in no user-settings card title.
    const byDescriptionOnly = visibleSettingsSections(USER_SETTINGS_SECTIONS, () => false, 'display');
    expect(titlesOf(byDescriptionOnly)).toHaveLength(0);

    const byTitle = visibleSettingsSections(USER_SETTINGS_SECTIONS, () => false, 'profile');
    expect(titlesOf(byTitle)).toContain('Profile');
  });
});

/**
 * Issue #366. `System`, `Appearance`, `Feature Flags` and `Advanced (JSON)`
 * were removed outright — not disabled, not hidden behind a permission — so
 * this is a regression guard against any of the four quietly reappearing
 * (e.g. a bad merge resurrecting a card whose page no longer exists, which
 * would send a click straight to `App.tsx`'s `*` catch-all).
 */
describe('removed settings pages (#366) stay gone', () => {
  const allCards = ADMIN_SECTIONS.flatMap((section) => section.cards);

  it('declares no card for System, Appearance, Feature Flags or Advanced (JSON)', () => {
    const titles = allCards.map((card) => card.title);
    expect(titles).not.toContain('System');
    expect(titles).not.toContain('Appearance');
    expect(titles).not.toContain('Feature Flags');
    expect(titles).not.toContain('Advanced (JSON)');
  });

  it('routes none of the removed paths', () => {
    const paths = allCards.map((card) => card.path);
    expect(paths).not.toContain('/admin/settings/general');
    expect(paths).not.toContain('/admin/settings/appearance');
    expect(paths).not.toContain('/admin/settings/feature-flags');
    expect(paths).not.toContain('/admin/settings/advanced');
  });
});

/**
 * Issue #225, epic #215. The `Notifications` page is a registry CARD, never a
 * fourth tab on an existing settings page — `CLAUDE.md`'s mandatory settings-UI
 * rule 1, stated as an assertion: a route with no registry entry is one the hub,
 * the Console rail and the AppBar title resolver all disagree about, because
 * none of the three has any way to learn it exists.
 *
 * The route/permission agreement with `App.tsx` is asserted generically for
 * every card in `destinations.test.ts`; what is pinned here is this card's own
 * identity, and that the gate genuinely denies.
 */
describe('the Notifications card (#225)', () => {
  const card = ADMIN_SECTIONS.flatMap((section) => section.cards).find(
    (entry) => entry.title === 'Notifications',
  );

  it('is declared in ADMIN_SECTIONS', () => {
    expect(card).toBeDefined();
  });

  it('routes to /admin/settings/notifications', () => {
    expect(card?.path).toBe('/admin/settings/notifications');
  });

  it('declares the exact permission the API enforces on GET /api/system-settings', () => {
    // `system-settings.controller.ts` — the same document this page edits, and
    // the same string its three sibling cards mirror. The registry never
    // invents a permission.
    expect(card?.permission).toBe('system_settings:read');
  });

  it('is not an alwaysShow escape hatch — the gate must be able to deny it', () => {
    expect(card?.alwaysShow).toBeUndefined();
  });

  it('appears for an admin holding system_settings:read', () => {
    const result = visibleSettingsSections(
      ADMIN_SECTIONS,
      (permission) => permission === 'system_settings:read',
    );

    expect(titlesOf(result)).toContain('Notifications');
  });

  it('appears in none of the three surfaces for a viewer', () => {
    // A viewer holds `user_settings:*` only. One assertion covers the hub, the
    // rail and the title resolver because all three run this same function.
    const viewerPermissions = ['user_settings:read', 'user_settings:write'];
    const result = visibleSettingsSections(ADMIN_SECTIONS, (permission) =>
      viewerPermissions.includes(permission),
    );

    expect(titlesOf(result)).not.toContain('Notifications');
  });

  it('resolves its route to its own title, not the hub title', () => {
    expect(
      settingsPageTitle(
        ADMIN_SECTIONS,
        ADMIN_HUB_PATH,
        ADMIN_HUB_TITLE,
        '/admin/settings/notifications',
      ),
    ).toBe('Notifications');
  });
});

/**
 * Issue #325, epic #319. The `Broadcasts` page is a registry CARD, never a
 * fourth tab on the admin Notifications settings page — `CLAUDE.md`'s mandatory
 * settings-UI rule 1 and rule 2, stated as assertions. The two pages answer
 * different questions: `/admin/settings/notifications` is the deployment-wide
 * kill switch (reachability of the notification MECHANISM), while this one
 * composes and dispatches one announcement to every user. A tab strip would
 * present the second as content of the first.
 *
 * The route/permission agreement with `App.tsx` is asserted generically for
 * every card in `destinations.test.ts`; what is pinned here is this card's own
 * identity, and that the gate genuinely denies.
 */
describe('the Broadcasts card (#325)', () => {
  const card = ADMIN_SECTIONS.flatMap((section) => section.cards).find(
    (entry) => entry.title === 'Broadcasts',
  );

  it('is declared in ADMIN_SECTIONS', () => {
    expect(card).toBeDefined();
  });

  it('routes to /admin/settings/broadcasts', () => {
    expect(card?.path).toBe('/admin/settings/broadcasts');
  });

  it('lives under Operations, not General', () => {
    // General holds values an administrator SETS, which then sit there; a
    // broadcast is work you dispatch and then watch. The distinction is this
    // section's own header, and it is what keeps the card one away from Jobs.
    const owner = ADMIN_SECTIONS.find((section) =>
      section.cards.some((entry) => entry.title === 'Broadcasts'),
    );
    expect(owner?.label).toBe('Operations');
  });

  it('declares the exact permission the API enforces on the broadcast routes', () => {
    // `notifications/broadcasts/broadcasts.controller.ts` — the registry never
    // invents a permission. NOT `system_settings:read`, which would let the
    // hub decide reachability on evidence unrelated to whether the request
    // behind the card will be authorized.
    expect(card?.permission).toBe('broadcasts:read');
    expect(card?.permission).not.toBe('system_settings:read');
  });

  it('is not an alwaysShow escape hatch — the gate must be able to deny it', () => {
    expect(card?.alwaysShow).toBeUndefined();
  });

  it('is routed, not inert', () => {
    expect(card?.disabled).toBeUndefined();
  });

  it('appears for an admin holding broadcasts:read', () => {
    const result = visibleSettingsSections(
      ADMIN_SECTIONS,
      (permission) => permission === 'broadcasts:read',
    );

    expect(titlesOf(result)).toContain('Broadcasts');
  });

  it('appears in none of the three surfaces for a viewer', () => {
    // A viewer holds `user_settings:*` only. One assertion covers the hub, the
    // rail and the title resolver because all three run this same function.
    const viewerPermissions = ['user_settings:read', 'user_settings:write'];
    const result = visibleSettingsSections(ADMIN_SECTIONS, (permission) =>
      viewerPermissions.includes(permission),
    );

    expect(titlesOf(result)).not.toContain('Broadcasts');
  });

  it('resolves its route to its own title, not the hub title', () => {
    expect(
      settingsPageTitle(
        ADMIN_SECTIONS,
        ADMIN_HUB_PATH,
        ADMIN_HUB_TITLE,
        '/admin/settings/broadcasts',
      ),
    ).toBe('Broadcasts');
  });

  it('is not confusable with the General → Notifications card', () => {
    // Both exist, at different paths, behind different permissions. The
    // failure this guards against is a later edit collapsing one into the
    // other — a "Broadcasts" tab on the notifications route, or a card whose
    // path quietly points at the kill switch.
    const notifications = ADMIN_SECTIONS.flatMap((section) => section.cards).find(
      (entry) => entry.title === 'Notifications',
    );

    expect(notifications?.path).toBe('/admin/settings/notifications');
    expect(card?.path).not.toBe(notifications?.path);
    expect(card?.permission).not.toBe(notifications?.permission);
  });
});

/**
 * Issue #376, epic #372. The `Storage` page is a registry CARD in the
 * **General** group — `CLAUDE.md`'s mandatory settings-UI rules 1 and 3 stated
 * as assertions, and rule 2 by construction (it is not a tab on Email, on Web
 * Push, or on anything else).
 *
 * The route/permission agreement with `App.tsx` is asserted generically for
 * every card in `destinations.test.ts`; what is pinned here is this card's own
 * identity, that its permission is neither of the two pairs that look like they
 * would do, and that the gate genuinely denies.
 */
describe('the Storage card (#376)', () => {
  const card = ADMIN_SECTIONS.flatMap((section) => section.cards).find(
    (entry) => entry.title === 'Storage',
  );

  it('is declared in ADMIN_SECTIONS', () => {
    expect(card).toBeDefined();
  });

  it('routes to /admin/settings/storage', () => {
    expect(card?.path).toBe('/admin/settings/storage');
  });

  it('lives under General, not Operations', () => {
    // General holds configuration an administrator SETS, which then sits
    // there — the bucket, the endpoint, the key pair. Operations is the
    // RUNNING system: work in flight, the machines executing it, the copies of
    // the data taken while it ran. Storage belongs beside Email and Web Push.
    const owner = ADMIN_SECTIONS.find((section) =>
      section.cards.some((entry) => entry.title === 'Storage'),
    );
    expect(owner?.label).toBe('General');
  });

  it('is not an alwaysShow escape hatch — the gate must be able to deny it', () => {
    expect(card?.alwaysShow).toBeUndefined();
  });

  it('is routed, not inert', () => {
    expect(card?.disabled).toBeUndefined();
  });

  it('declares the exact permission the API enforces on the storage-config routes', () => {
    // Read off the API workspace rather than restated, so a rename on either
    // side fails here instead of in production. This is the mechanical half of
    // CLAUDE.md Settings UI Pattern rule 3.
    const API_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../api/src');
    const rolesConstants = readFileSync(
      resolve(API_SRC, 'common/constants/roles.constants.ts'),
      'utf8',
    );
    const storageConfigController = readFileSync(
      resolve(API_SRC, 'storage/config/storage-config.controller.ts'),
      'utf8',
    );

    expect(card?.permission).toBe('storage_config:read');
    expect(rolesConstants).toContain("STORAGE_CONFIG_READ: 'storage_config:read'");
    expect(rolesConstants).toContain("STORAGE_CONFIG_WRITE: 'storage_config:write'");
    expect(storageConfigController).toContain('PERMISSIONS.STORAGE_CONFIG_READ');
    expect(storageConfigController).toContain('PERMISSIONS.STORAGE_CONFIG_WRITE');
  });

  it('mirrors neither system_settings:read nor storage:read', () => {
    // `system_settings:read` would gate a credential-bearing screen on evidence
    // unrelated to whether the request behind the card will be authorized.
    // `storage:read` is the closer-looking mistake and the worse one: that pair
    // gates OBJECT ACCESS and is seeded to Viewer and Contributor, so mirroring
    // it would put this page in front of the entire user base.
    expect(card?.permission).not.toBe('system_settings:read');
    expect(card?.permission).not.toBe('storage:read');
    expect(card?.permission).not.toBe('storage_config:write');
  });

  it('appears for an admin holding storage_config:read', () => {
    const result = visibleSettingsSections(
      ADMIN_SECTIONS,
      (permission) => permission === 'storage_config:read',
    );

    expect(titlesOf(result)).toContain('Storage');
  });

  it('is invisible to a user holding only storage:read, however many objects they may read', () => {
    const result = visibleSettingsSections(
      ADMIN_SECTIONS,
      (permission) => permission === 'storage:read',
    );

    expect(titlesOf(result)).not.toContain('Storage');
  });

  it('appears in none of the three surfaces for a viewer', () => {
    // A viewer holds `user_settings:*` and `storage:*`. One assertion covers
    // the hub, the rail and the title resolver because all three run this same
    // function.
    const viewerPermissions = [
      'user_settings:read',
      'user_settings:write',
      'storage:read',
      'storage:write',
      'storage:delete',
    ];
    const result = visibleSettingsSections(ADMIN_SECTIONS, (permission) =>
      viewerPermissions.includes(permission),
    );

    expect(titlesOf(result)).not.toContain('Storage');
  });

  it('resolves its route to its own title, not the hub title', () => {
    expect(
      settingsPageTitle(
        ADMIN_SECTIONS,
        ADMIN_HUB_PATH,
        ADMIN_HUB_TITLE,
        '/admin/settings/storage',
      ),
    ).toBe('Storage');
  });
});

/**
 * Issue #401, epic #397. The `About` page is a registry CARD in the
 * **Operations** group — `CLAUDE.md`'s mandatory settings-UI rules 1 and 3
 * stated as assertions, and rule 2 by construction (it is not a tab on Jobs, on
 * Worker Nodes, or on anything else).
 *
 * The route/permission agreement with `App.tsx` is asserted generically for
 * every card in `destinations.test.ts`; what is pinned here is this card's own
 * identity, its group, and that its permission is the literal string the About
 * controller enforces rather than a new one invented for it.
 */
describe('the About card (#401)', () => {
  const card = ADMIN_SECTIONS.flatMap((section) => section.cards).find(
    (entry) => entry.title === 'About',
  );

  it('is declared in ADMIN_SECTIONS', () => {
    expect(card).toBeDefined();
  });

  it('routes to /admin/settings/about', () => {
    expect(card?.path).toBe('/admin/settings/about');
  });

  it('lives under Operations, not General', () => {
    // General holds configuration an administrator SETS, which then sits there.
    // Nothing on the About page is settable — the endpoint behind it is a
    // single GET. It is a read-only view of the RUNNING system, which is the
    // question Jobs, Worker Nodes and Database Backup each answer on their own
    // axis; this one answers the most basic of them.
    const owner = ADMIN_SECTIONS.find((section) =>
      section.cards.some((entry) => entry.title === 'About'),
    );
    expect(owner?.label).toBe('Operations');
  });

  it('is not an alwaysShow escape hatch — the gate must be able to deny it', () => {
    expect(card?.alwaysShow).toBeUndefined();
  });

  it('is routed, not inert', () => {
    expect(card?.disabled).toBeUndefined();
  });

  it('declares the exact permission about.controller.ts enforces, and invents none', () => {
    // Read off the API workspace rather than restated, so a rename on either
    // side fails here instead of in production. This is the mechanical half of
    // CLAUDE.md Settings UI Pattern rule 3, and the controller's own header
    // names this test's sibling as the other half of the contract.
    const API_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../api/src');
    const rolesConstants = readFileSync(
      resolve(API_SRC, 'common/constants/roles.constants.ts'),
      'utf8',
    );
    const aboutController = readFileSync(resolve(API_SRC, 'about/about.controller.ts'), 'utf8');

    expect(card?.permission).toBe('system_settings:read');
    expect(rolesConstants).toContain("SYSTEM_SETTINGS_READ: 'system_settings:read'");
    // Both spellings are asserted because the controller carries both on
    // purpose — the reference it decorates with, and the literal its header
    // names as half of this cross-app contract.
    expect(aboutController).toContain('PERMISSIONS.SYSTEM_SETTINGS_READ');
    expect(aboutController).toContain('system_settings:read');
  });

  it('does not invent an about:read permission of its own', () => {
    // The controller argues this at length: the split pairs elsewhere in this
    // registry (`push:*`, `broadcasts:*`, `nodes:*`, `storage_config:*`) each
    // turn on a DISTINCT blast radius — key material, a send to every user, a
    // fleet, a credential-bearing screen. A read-only report has none of that,
    // and a new permission would have to be seeded, granted and explained to
    // buy nothing.
    expect(card?.permission).not.toBe('about:read');
    expect(card?.permission).not.toBe('system_settings:write');
  });

  it('appears for an admin holding system_settings:read', () => {
    const result = visibleSettingsSections(
      ADMIN_SECTIONS,
      (permission) => permission === 'system_settings:read',
    );

    expect(titlesOf(result)).toContain('About');
  });

  it('appears in none of the three surfaces for a viewer', () => {
    // One assertion covers the hub, the rail and the title resolver because
    // all three run this same function.
    const viewerPermissions = ['user_settings:read', 'user_settings:write', 'storage:read'];
    const result = visibleSettingsSections(ADMIN_SECTIONS, (permission) =>
      viewerPermissions.includes(permission),
    );

    expect(titlesOf(result)).not.toContain('About');
  });

  it('resolves its route to its own title, not the hub title', () => {
    expect(
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin/settings/about'),
    ).toBe('About');
  });
});

describe('settingsPageTitle', () => {
  it('resolves an exact card path to its title', () => {
    expect(settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin/settings/users')).toBe(
      'Users & Allowlist',
    );
  });

  it('gives the longest matching prefix the win on a nested child path', () => {
    expect(
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin/settings/users/123'),
    ).toBe('Users & Allowlist');
  });

  it('respects segment boundaries: a path that only starts with a card path falls back to the hub title', () => {
    // Per the function's own doc comment, `/admin/settings/users-archive` must
    // NOT resolve to "Users & Allowlist" — but it IS still under the hub
    // (`/admin/settings/...`), so the correct answer is the hub title, not
    // null. A bare `startsWith` on the card path is the exact bug
    // `destinations.ts`'s `owns()` was written to kill, reintroduced here.
    expect(
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin/settings/users-archive'),
    ).toBe(ADMIN_HUB_TITLE);
  });

  it('returns the hub title for the hub path itself', () => {
    expect(settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, ADMIN_HUB_PATH)).toBe(
      ADMIN_HUB_TITLE,
    );
  });

  it('returns the hub title for a child path under the hub that no card owns', () => {
    expect(
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin/settings/whatever-not-a-card-path'),
    ).toBe(ADMIN_HUB_TITLE);
  });

  describe('returns null for a path not under hubPath at all', () => {
    it('the app root', () => {
      expect(settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/')).toBeNull();
    });

    it('a sibling under /admin that is not the settings hub', () => {
      expect(settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin')).toBeNull();
    });

    it('cross-registry: the admin registry does not claim a user-settings path', () => {
      // /settings/profile belongs to the OTHER hub. Without the hubPath guard,
      // nothing here would stop a coincidental card-path collision from
      // resolving a title that belongs to the wrong surface.
      expect(settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/settings/profile')).toBeNull();
    });

    it('cross-registry: the user registry does not claim an admin-settings path', () => {
      expect(
        settingsPageTitle(USER_SETTINGS_SECTIONS, USER_HUB_PATH, USER_HUB_TITLE, '/admin/settings/users'),
      ).toBeNull();
    });
  });
});

/**
 * Issue #266, epic #254 — the `Operations` group.
 *
 * Three things are worth asserting here that nothing else can:
 *
 *  1. THE GROUP IS ADDITIVE. `General` and `Access` keep their cards, their
 *     order and their gates; a third section that quietly reordered or
 *     absorbed a sibling would look fine on the hub and be wrong in the rail.
 *  2. THE TWO UNBUILT CARDS ARE NON-NAVIGABLE, not 404-linking. Both consumers
 *     key on the same two fields (`SettingsHub` renders an inert "Coming soon"
 *     card with no action area; `NavigationRail` skips the row), so `path`
 *     being absent AND `disabled` being true is the contract, not a detail.
 *  3. THE PERMISSIONS ARE THE API'S OWN STRINGS — checked against the API's
 *     constants file on disk rather than against a copy, per CLAUDE.md's
 *     Settings UI Pattern rule 3. `Database Backup` in particular must NOT
 *     mirror `system_settings:read`: the API reserves a dedicated
 *     `db_backup:*` triple precisely so backup access can be granted without
 *     handing over the settings document.
 */
describe('the Operations group (#266)', () => {
  const operations = ADMIN_SECTIONS.find((section) => section.label === 'Operations');
  const cardsByTitle = new Map(
    ADMIN_SECTIONS.flatMap((section) => section.cards).map((card) => [card.title, card]),
  );

  it('is a third group, and the first two are untouched', () => {
    // `AI` (#425) is APPENDED as a fourth group after it — see the AI suite —
    // and `Observability` (#537) as a fifth after that.
    expect(ADMIN_SECTIONS.map((section) => section.label)).toEqual([
      'General',
      'Access',
      'Operations',
      'AI',
      'Observability',
    ]);
  });

  it('registers all four of the epic’s cards at once, and #319 then #401 each append one', () => {
    // Declared together on purpose: the hub is under visual-regression testing
    // at `maxDiffPixels: 4`, so every change to the card grid needs baselines
    // regenerated in a pinned container. Four cards across four issues would
    // be four regenerations and four chances to land a stale baseline.
    //
    // `Broadcasts` (#325, epic #319) is APPENDED rather than inserted, and the
    // order is asserted rather than left to chance: the hub, the rail and the
    // drill-down list all render this array in declaration order, so an
    // insertion would move four existing cards for a reader who has learnt
    // where they are — and would reflow the grid further than the one added
    // card requires.
    //
    // `About` (#401, epic #397) is appended for the same reason and under the
    // same rule. It belongs in Operations rather than General on this section
    // header's own test: General holds values an administrator SETS, and
    // nothing on the About page is settable — it is a read-only view of the
    // running system, the same kind of question its four neighbours answer.
    expect(operations?.cards.map((card) => card.title)).toEqual([
      'Jobs',
      'Job Insights',
      'Worker Nodes',
      'Database Backup',
      'Broadcasts',
      'About',
    ]);
  });

  it('routes every page that has shipped', () => {
    expect(cardsByTitle.get('Jobs')?.path).toBe('/admin/settings/jobs');
    expect(cardsByTitle.get('Job Insights')?.path).toBe('/admin/settings/jobs/insights');
    // #271 flipped this one from inert to routed. The path is the route
    // `App.tsx` declares, byte for byte — a card pointing anywhere else would
    // send the click to the `*` catch-all and land on the home page.
    expect(cardsByTitle.get('Worker Nodes')?.path).toBe('/admin/settings/workers');
    // #287 flipped the last one, for the same reason and with the same rule:
    // the path is the route `App.tsx` declares, byte for byte.
    expect(cardsByTitle.get('Database Backup')?.path).toBe('/admin/settings/db-backup');
    // #401 shipped routed from the start — it was never declared ahead of its
    // page, so there was no inert state to flip.
    expect(cardsByTitle.get('About')?.path).toBe('/admin/settings/about');
  });

  it('has no inert card left — every page the group declared has shipped', () => {
    // #287 flipped the last one. The `disabled: true` + no-`path` contract
    // still matters and is asserted below for whatever is declared ahead of its
    // page NEXT; today the group is fully routed, which is the state it was
    // declared in advance to reach.
    for (const card of operations?.cards ?? []) {
      expect(card.disabled, `${card.title} must not be inert`).toBeUndefined();
      expect(card.path, `${card.title} must declare a route`).toBeTruthy();
    }
  });

  it('keeps the two fields coupled for any card declared ahead of its page', () => {
    // The rail skips on either field and the hub renders an inert card on
    // either, so a card that has one without the other is a card the two
    // consumers disagree about: `disabled` with a `path` is a rail row that
    // vanishes, and a `path` with no page sends a click to `App.tsx`'s `*`
    // catch-all and lands the operator on the home page with no explanation.
    for (const card of ADMIN_SECTIONS.flatMap((section) => section.cards)) {
      if (card.disabled) {
        expect(card.path, `${card.title} is inert and must declare no route`).toBeUndefined();
      }
    }
  });

  it('leaves the shipped cards navigable', () => {
    for (const title of ['Jobs', 'Job Insights', 'Worker Nodes', 'Database Backup', 'About']) {
      expect(cardsByTitle.get(title)?.disabled).toBeUndefined();
    }
  });

  it('gates every card on a permission, with no alwaysShow escape hatch', () => {
    for (const card of operations?.cards ?? []) {
      expect(card.permission, `${card.title} must declare a permission`).toBeTruthy();
      expect(card.alwaysShow, `${card.title} must be deniable`).toBeUndefined();
    }
  });

  describe('the permissions are literally the strings the API enforces', () => {
    // Read off the API workspace rather than restated, so a rename on either
    // side fails here instead of in production. This is the mechanical half of
    // CLAUDE.md Settings UI Pattern rule 3.
    const API_SRC = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../api/src',
    );
    const rolesConstants = readFileSync(
      resolve(API_SRC, 'common/constants/roles.constants.ts'),
      'utf8',
    );
    const jobsController = readFileSync(
      resolve(API_SRC, 'jobs/job-admin.controller.ts'),
      'utf8',
    );
    const nodesAdminController = readFileSync(
      resolve(API_SRC, 'nodes/nodes-admin.controller.ts'),
      'utf8',
    );
    const broadcastsController = readFileSync(
      resolve(API_SRC, 'notifications/broadcasts/broadcasts.controller.ts'),
      'utf8',
    );
    const dbBackupController = readFileSync(
      resolve(API_SRC, 'db-backup/db-backup.controller.ts'),
      'utf8',
    );

    it('binds both Jobs cards to jobs:read, which job-admin.controller.ts enforces on its reads', () => {
      expect(cardsByTitle.get('Jobs')?.permission).toBe('jobs:read');
      expect(cardsByTitle.get('Job Insights')?.permission).toBe('jobs:read');
      expect(rolesConstants).toContain("JOBS_READ: 'jobs:read'");
      expect(jobsController).toContain('PERMISSIONS.JOBS_READ');
    });

    it('binds Worker Nodes to nodes:read, never to jobs:read', () => {
      // `roles.constants.ts` splits the two deliberately: a Workers card gated
      // on `jobs:read` would advertise a permission the nodes controller never
      // checks, so the hub would decide reachability on unrelated evidence.
      expect(cardsByTitle.get('Worker Nodes')?.permission).toBe('nodes:read');
      expect(cardsByTitle.get('Worker Nodes')?.permission).not.toBe('jobs:read');
      expect(rolesConstants).toContain("NODES_READ: 'nodes:read'");
      // And the controller really does enforce it — the mechanical half of
      // CLAUDE.md Settings UI Pattern rule 3, now that the card is routed and
      // the string gates a page somebody can actually open (#271).
      expect(nodesAdminController).toContain('PERMISSIONS.NODES_READ');
    });

    it('binds Broadcasts to broadcasts:read, which broadcasts.controller.ts enforces on its reads', () => {
      // #325, epic #319. The dedicated pair exists so composing an
      // announcement to every user can be granted — or withheld — without
      // handing over the settings document, and mirroring
      // `system_settings:read` here would quietly undo that.
      expect(cardsByTitle.get('Broadcasts')?.permission).toBe('broadcasts:read');
      expect(cardsByTitle.get('Broadcasts')?.permission).not.toBe('system_settings:read');
      expect(rolesConstants).toContain("BROADCASTS_READ: 'broadcasts:read'");
      expect(rolesConstants).toContain("BROADCASTS_WRITE: 'broadcasts:write'");
      // And the controller really does enforce it — the mechanical half of
      // CLAUDE.md Settings UI Pattern rule 3.
      expect(broadcastsController).toContain('PERMISSIONS.BROADCASTS_READ');
      expect(broadcastsController).toContain('PERMISSIONS.BROADCASTS_WRITE');
    });

    it('binds Database Backup to the dedicated db_backup:read, never to system_settings:read', () => {
      const card = cardsByTitle.get('Database Backup');
      expect(card?.permission).toBe('db_backup:read');
      expect(card?.permission).not.toBe('system_settings:read');
      expect(rolesConstants).toContain("DB_BACKUP_READ: 'db_backup:read'");
      // And the controller really does enforce it — the mechanical half of
      // CLAUDE.md Settings UI Pattern rule 3, now that the card is routed and
      // the string gates a page somebody can actually open (#287).
      expect(dbBackupController).toContain('PERMISSIONS.DB_BACKUP_READ');
      // The THIRD permission is what the split is for: restoring is deliberately
      // not `db_backup:write`, so it can be withheld from someone who may
      // schedule backups but must not be able to replace the database. The card
      // must NOT mirror it — a reachability gate on `restore` would hide the
      // history from the read-only admin the page is most useful to.
      expect(rolesConstants).toContain("DB_BACKUP_RESTORE: 'db_backup:restore'");
      expect(dbBackupController).toContain('PERMISSIONS.DB_BACKUP_RESTORE');
      expect(card?.permission).not.toBe('db_backup:restore');
    });
  });

  describe('the shared gate, which the hub, the rail and the AppBar all run', () => {
    it('shows an operator holding only jobs:read exactly the two Jobs cards', () => {
      const result = visibleSettingsSections(
        ADMIN_SECTIONS,
        (permission) => permission === 'jobs:read',
      );

      expect(result.map((section) => section.label)).toEqual(['Operations']);
      expect(titlesOf(result)).toEqual(['Jobs', 'Job Insights']);
    });

    it('drops Operations entirely for a viewer, in all three surfaces at once', () => {
      const viewerPermissions = ['user_settings:read', 'user_settings:write'];
      const result = visibleSettingsSections(ADMIN_SECTIONS, (permission) =>
        viewerPermissions.includes(permission),
      );

      expect(result.find((section) => section.label === 'Operations')).toBeUndefined();
    });

    it('does not disturb what a system_settings/users admin already saw', () => {
      // The regression an added section invites: General and Access must still
      // resolve to exactly the cards they did before.
      //
      // OPERATIONS NOW RESOLVES FOR THIS HOLDER TOO, and that is correct rather
      // than drift. `About` (#401, epic #397) is the first Operations card
      // gated on `system_settings:read` — not because it reaches across into
      // another surface's permission, but because that is the literal string
      // `about/about.controller.ts` enforces (Settings UI Pattern rule 3: the
      // card mirrors a permission, it never invents one). So a
      // `system_settings:read` admin who holds none of `jobs:read`,
      // `nodes:read`, `db_backup:read` or `broadcasts:read` now sees an
      // Operations section containing exactly one card. What this test still
      // pins is the part that must not move: General and Access resolve to
      // EXACTLY the cards they did before, in order.
      const result = visibleSettingsSections(ADMIN_SECTIONS, (permission) =>
        ['system_settings:read', 'system_settings:write', 'users:read'].includes(permission),
      );

      expect(result.map((section) => section.label)).toEqual([
        'General',
        'Access',
        'Operations',
      ]);
      expect(titlesOf(result)).toEqual([
        'Email',
        'Notifications',
        'Maintenance',
        'Users & Allowlist',
        'About',
      ]);
    });

    it('shows every Operations card to whoever holds its permission', () => {
      const result = visibleSettingsSections(ADMIN_SECTIONS, () => true);

      expect(titlesOf(result)).toContain('Worker Nodes');
      expect(titlesOf(result)).toContain('Database Backup');
    });

    it('shows Database Backup to a db_backup:read holder and to nobody else', () => {
      // The whole reason the API reserves a dedicated triple: backup access is
      // grantable without the settings document, so the card must not appear
      // for a `system_settings:read` admin who was never given it.
      const withBackup = visibleSettingsSections(
        ADMIN_SECTIONS,
        (permission) => permission === 'db_backup:read',
      );
      expect(titlesOf(withBackup)).toEqual(['Database Backup']);

      const settingsOnly = visibleSettingsSections(
        ADMIN_SECTIONS,
        (permission) => permission === 'system_settings:read',
      );
      expect(titlesOf(settingsOnly)).not.toContain('Database Backup');
    });

    it('matches Operations cards by title in the hub search', () => {
      const result = visibleSettingsSections(ADMIN_SECTIONS, () => true, 'insights');

      expect(titlesOf(result)).toEqual(['Job Insights']);
    });
  });

  describe('the AppBar title resolver, on a NESTED card route', () => {
    const titleFor = (pathname: string) =>
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, pathname);

    it('resolves the parent route to Jobs', () => {
      expect(titleFor('/admin/settings/jobs')).toBe('Jobs');
    });

    it('gives the LONGEST prefix the win, so the nested route is not titled "Jobs"', () => {
      // The exact case the longest-prefix rule exists for: `/admin/settings/jobs`
      // is a genuine prefix of the insights path, so a first-match resolver
      // would title this page after its sibling.
      expect(titleFor('/admin/settings/jobs/insights')).toBe('Job Insights');
    });

    it('keeps the win on a child of the nested route', () => {
      expect(titleFor('/admin/settings/jobs/insights/anything')).toBe('Job Insights');
    });

    it('respects segment boundaries around the jobs path', () => {
      expect(titleFor('/admin/settings/jobs-archive')).toBe(ADMIN_HUB_TITLE);
    });

    it('resolves the backup route to Database Backup (#287)', () => {
      expect(titleFor('/admin/settings/db-backup')).toBe('Database Backup');
    });

    it('falls back to the hub title for paths no card claims', () => {
      // Neither of these is any card's `path` — the two pages live at
      // `/admin/settings/workers` and `/admin/settings/db-backup` — so nothing
      // claims them, which is the same answer the hub gives and not a title for
      // a page that does not exist.
      expect(titleFor('/admin/settings/nodes')).toBe(ADMIN_HUB_TITLE);
      expect(titleFor('/admin/settings/backup')).toBe(ADMIN_HUB_TITLE);
      // And the segment-boundary rule holds around the new path too.
      expect(titleFor('/admin/settings/db-backup-archive')).toBe(ADMIN_HUB_TITLE);
    });
  });
});

/**
 * Issue #425, epic #419 — the feature axis of the registry, and the AI cards.
 */
describe('visibleSettingsSections — feature gating (#425)', () => {
  function featureFixture(): SettingsSectionDef[] {
    return [
      {
        label: 'Mixed',
        cards: [
          { title: 'Plain', description: 'no gate', Icon, path: '/f/plain' },
          { title: 'Featured', description: 'ai only', Icon, path: '/f/featured', feature: 'ai' },
          {
            title: 'Forced',
            description: 'alwaysShow does not beat a feature',
            Icon,
            path: '/f/forced',
            alwaysShow: true,
            feature: 'ai',
          },
        ],
      },
      {
        label: 'Only Featured',
        cards: [{ title: 'Lonely', description: 'ai only', Icon, path: '/f/lonely', feature: 'ai' }],
      },
    ];
  }

  it('hides feature cards when no feature map is passed (backwards compatible, fail closed)', () => {
    const result = visibleSettingsSections(featureFixture(), () => true);
    expect(titlesOf(result)).toEqual(['Plain']);
  });

  it('drops a section emptied by the feature gate', () => {
    const result = visibleSettingsSections(featureFixture(), () => true, '', { ai: false });
    expect(result.map((section) => section.label)).toEqual(['Mixed']);
  });

  it('shows feature cards when the feature is on', () => {
    const result = visibleSettingsSections(featureFixture(), () => true, '', { ai: true });
    expect(titlesOf(result)).toEqual(['Plain', 'Featured', 'Forced', 'Lonely']);
  });
});

describe('settingsPageTitle — feature gating (#425)', () => {
  it('titles AI Models by longest prefix only while AI is on', () => {
    const path = '/admin/settings/ai/models';
    expect(settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, path, { ai: true })).toBe(
      'AI Models',
    );
    // Off: the card does not exist, so its parent route owns the title.
    expect(settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, path)).toBe('AI');
  });

  it('titles the AI page whether or not AI is on', () => {
    for (const features of [{}, { ai: true }]) {
      expect(
        settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin/settings/ai', features),
      ).toBe('AI');
    }
  });

  it('falls back to the user hub title for /settings/ai while AI is off', () => {
    expect(settingsPageTitle(USER_SETTINGS_SECTIONS, USER_HUB_PATH, USER_HUB_TITLE, '/settings/ai')).toBe(
      USER_HUB_TITLE,
    );
    expect(
      settingsPageTitle(USER_SETTINGS_SECTIONS, USER_HUB_PATH, USER_HUB_TITLE, '/settings/ai', { ai: true }),
    ).toBe('AI Keys');
  });
});

describe('the AI group (#425)', () => {
  const aiSection = ADMIN_SECTIONS.find((section) => section.label === 'AI');
  const cards = new Map((aiSection?.cards ?? []).map((card) => [card.title, card]));

  it('is APPENDED after Operations, leaving every earlier card in place', () => {
    // It was the last group until `Observability` (#537) was appended after it.
    expect(ADMIN_SECTIONS[3]).toBe(aiSection);
    expect(ADMIN_SECTIONS.slice(4).map((section) => section.label)).toEqual(['Observability']);
    // `AI Usage` (#444) is appended after `AI Models`, never inserted.
    expect(aiSection?.cards.map((card) => card.title)).toEqual(['AI', 'AI Models', 'AI Usage']);
  });

  it('gates both cards on ai_config:read — the admin AI controller’s read permission', () => {
    expect(cards.get('AI')?.permission).toBe('ai_config:read');
    expect(cards.get('AI Models')?.permission).toBe('ai_config:read');
  });

  it('gates AI Usage (#444) on ai_config:read, feature-gated, nested under the AI route', () => {
    expect(cards.get('AI Usage')).toMatchObject({
      path: '/admin/settings/ai/usage',
      permission: 'ai_config:read',
      feature: 'ai',
    });
  });

  it('hides AI Usage while AI is off, and titles its route by longest prefix only while on', () => {
    const titles = (features: { ai?: boolean }) =>
      visibleSettingsSections(ADMIN_SECTIONS, () => true, '', features).flatMap((section) =>
        section.cards.map((card) => card.title),
      );
    expect(titles({ ai: false })).not.toContain('AI Usage');
    expect(titles({ ai: true })).toContain('AI Usage');

    const path = '/admin/settings/ai/usage';
    expect(settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, path, { ai: true })).toBe(
      'AI Usage',
    );
    expect(settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, path)).toBe('AI');
  });

  it('never feature-gates the AI card — it is where AI is switched on', () => {
    expect(cards.get('AI')?.feature).toBeUndefined();
    expect(cards.get('AI')?.path).toBe('/admin/settings/ai');
  });

  it('feature-gates AI Models and nests it under the AI route', () => {
    expect(cards.get('AI Models')?.feature).toBe('ai');
    expect(cards.get('AI Models')?.path).toBe('/admin/settings/ai/models');
  });

  it('shows neither card to an admin without ai_config:read — the pre-AI hub is unchanged', () => {
    const preAi = ['system_settings:read', 'users:read', 'jobs:read', 'nodes:read'];
    const result = visibleSettingsSections(
      ADMIN_SECTIONS,
      (permission) => preAi.includes(permission),
      '',
      { ai: true },
    );
    expect(result.map((section) => section.label)).not.toContain('AI');
  });

  it('declares AI Keys in the user Security group on ai:use, feature-gated', () => {
    const security = USER_SETTINGS_SECTIONS.find((section) => section.label === 'Security');
    const aiKeys = security?.cards.find((card) => card.title === 'AI Keys');
    expect(aiKeys).toMatchObject({ path: '/settings/ai', permission: 'ai:use', feature: 'ai' });
  });
});

/**
 * Issue #537, epic #528 — the Observability group: `Telemetry` (the policy
 * page, where telemetry is switched on) and `Telemetry Explorer` (feature-gated
 * on `telemetry`). Permissions are read off the API workspace on disk, the
 * mechanical half of CLAUDE.md Settings UI Pattern rule 3.
 */
describe('the Observability group (#537)', () => {
  const API_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../api/src');
  const rolesConstants = readFileSync(resolve(API_SRC, 'common/constants/roles.constants.ts'), 'utf8');
  const observability = ADMIN_SECTIONS.find((section) => section.label === 'Observability');
  const cards = new Map((observability?.cards ?? []).map((card) => [card.title, card]));
  const telemetry = cards.get('Telemetry');
  const explorer = cards.get('Telemetry Explorer');

  const titles = (hasPermission: (permission: string) => boolean, features = {}) =>
    titlesOf(visibleSettingsSections(ADMIN_SECTIONS, hasPermission, '', features));

  it('is APPENDED as the last group, with its cards in declaration order', () => {
    expect(ADMIN_SECTIONS[ADMIN_SECTIONS.length - 1]).toBe(observability);
    // `Telemetry Dashboard` (#578) was appended after the Explorer.
    expect(observability?.cards.map((card) => card.title)).toEqual([
      'Telemetry',
      'Telemetry Explorer',
      'Telemetry Dashboard',
    ]);
  });

  describe('the Telemetry card', () => {
    it('is declared and routed to /admin/settings/telemetry', () => {
      expect(telemetry).toBeDefined();
      expect(telemetry?.path).toBe('/admin/settings/telemetry');
      expect(telemetry?.disabled).toBeUndefined();
      expect(telemetry?.alwaysShow).toBeUndefined();
    });

    it('carries no feature — it is where telemetry is switched on', () => {
      expect(telemetry?.feature).toBeUndefined();
    });

    it('declares the exact permission telemetry-admin.controller.ts enforces on its reads', () => {
      const controller = readFileSync(
        resolve(API_SRC, 'telemetry/telemetry-admin.controller.ts'),
        'utf8',
      );
      expect(telemetry?.permission).toBe('telemetry:read');
      expect(rolesConstants).toContain("TELEMETRY_READ: 'telemetry:read'");
      expect(controller).toContain('@Auth({ permissions: [PERMISSIONS.TELEMETRY_READ] })');
    });
  });

  describe('the Telemetry Explorer card', () => {
    it('is declared, routed and nested under the Telemetry route', () => {
      expect(explorer).toBeDefined();
      expect(explorer?.path).toBe('/admin/settings/telemetry/explorer');
      expect(explorer?.disabled).toBeUndefined();
      expect(explorer?.alwaysShow).toBeUndefined();
    });

    it("is feature-gated on 'telemetry', never on 'ai'", () => {
      expect(explorer?.feature).toBe('telemetry');
    });

    it('declares telemetry:query, the explorer controller permission', () => {
      expect(explorer?.permission).toBe('telemetry:query');
      expect(rolesConstants).toContain("TELEMETRY_QUERY: 'telemetry:query'");
      // The explorer controller lands in #535, built in parallel with this
      // page. Until it exists in the tree, the roles constant above is the
      // anchor; once it does, it must enforce the same constant.
      const controllerPath = resolve(API_SRC, 'telemetry/telemetry-explorer.controller.ts');
      if (existsSync(controllerPath)) {
        expect(readFileSync(controllerPath, 'utf8')).toContain('PERMISSIONS.TELEMETRY_QUERY');
      }
    });
  });

  describe('the Telemetry Dashboard card (#578)', () => {
    const dashboard = cards.get('Telemetry Dashboard');
    const allCards = ADMIN_SECTIONS.flatMap((section) => section.cards);

    it('is the LAST card of the last group — appended, not inserted', () => {
      expect(allCards[allCards.length - 1]).toBe(dashboard);
      expect(dashboard?.disabled).toBeUndefined();
      expect(dashboard?.alwaysShow).toBeUndefined();
    });

    it('declares a unique path nested under the Telemetry route', () => {
      expect(dashboard?.path).toBe('/admin/settings/telemetry/dashboard');
      expect(allCards.filter((card) => card.path === dashboard?.path)).toHaveLength(1);
    });

    it("declares telemetry:query, the dashboard controller's permission, and the telemetry feature", () => {
      expect(dashboard?.permission).toBe('telemetry:query');
      expect(dashboard?.feature).toBe('telemetry');
      const controller = readFileSync(
        resolve(API_SRC, 'telemetry/dashboard/telemetry-dashboard.controller.ts'),
        'utf8',
      );
      const guards = controller.match(/@Auth\(\{[^)]*\}\)/g) ?? [];
      expect(guards).toHaveLength(5);
      for (const guard of guards) expect(guard).toBe('@Auth({ permissions: [PERMISSIONS.TELEMETRY_QUERY] })');
    });

    it('is hidden while telemetry is off and titles its route by longest prefix', () => {
      expect(titles(() => true, { telemetry: false })).not.toContain('Telemetry Dashboard');
      expect(titles(() => true, { telemetry: true })).toContain('Telemetry Dashboard');
      expect(
        settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin/settings/telemetry/dashboard', {
          telemetry: true,
        }),
      ).toBe('Telemetry Dashboard');
    });
  });

  it('shows both cards to an admin holding the telemetry permissions while telemetry is on', () => {
    const result = titles(() => true, { ai: true, telemetry: true });
    expect(result).toContain('Telemetry');
    expect(result).toContain('Telemetry Explorer');
  });

  it('hides the Explorer while telemetry is off, but keeps the Telemetry card', () => {
    const off = titles(() => true, { ai: true, telemetry: false });
    expect(off).toContain('Telemetry');
    expect(off).not.toContain('Telemetry Explorer');
    // No feature map at all fails closed the same way.
    expect(titles(() => true)).not.toContain('Telemetry Explorer');
  });

  it('shows the Explorer only to a telemetry:query holder', () => {
    const readOnly = titles((permission) => permission === 'telemetry:read', { telemetry: true });
    expect(readOnly).toEqual(['Telemetry']);
    const queryOnly = titles((permission) => permission === 'telemetry:query', { telemetry: true });
    expect(queryOnly).toEqual(['Telemetry Explorer', 'Telemetry Dashboard']);
  });

  it('drops the whole group for a viewer', () => {
    const viewer = ['user_settings:read', 'user_settings:write', 'ai:use'];
    const result = visibleSettingsSections(
      ADMIN_SECTIONS,
      (permission) => viewer.includes(permission),
      '',
      { ai: true, telemetry: true },
    );
    expect(result.map((section) => section.label)).not.toContain('Observability');
  });

  it('titles the Explorer route by longest prefix only while telemetry is on', () => {
    const path = '/admin/settings/telemetry/explorer';
    expect(
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, path, { telemetry: true }),
    ).toBe('Telemetry Explorer');
    expect(settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, path)).toBe('Telemetry');
    expect(
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin/settings/telemetry'),
    ).toBe('Telemetry');
  });
});
