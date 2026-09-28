import {
  ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  DEFAULT_SYSTEM_SETTINGS as SEEDED_SYSTEM_SETTINGS,
} from '../../prisma/seed-data';
import { PERMISSIONS as PERMISSION_CONSTANTS } from '../../src/common/constants/roles.constants';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { systemSettingsSchema } from '../../src/common/schemas/settings.schema';

// =============================================================================
// Seed data guard (#256, epic #254)
// =============================================================================
//
// WHAT THIS CAN AND CANNOT CHECK. `prisma/seed.ts` needs a real Postgres, so
// its behaviour is proven by CI's smoke job, which runs `npm run prisma:seed`
// against a live database — twice on a re-run of an existing environment, which
// is the actual idempotency evidence. Every write in that script is an `upsert`
// keyed on a natural unique (`role.name`, `permission.name`,
// `rolePermission.roleId_permissionId`, `systemSettings.key`), so re-running it
// updates rows rather than inserting duplicates.
//
// What no database can tell you is whether the DATA is self-consistent, and
// that is what this file asserts, against `prisma/seed-data.ts` — split out of
// the script for exactly this purpose, since the script itself connects to a
// database and runs `main()` at import time.
//
// The failure this most directly prevents: a permission added to
// `PERMISSIONS` in `roles.constants.ts` (which is what `@Auth()` decorators
// name) but not to the seed, so every route guarded by it 403s for everyone in
// a freshly seeded deployment, with nothing in the logs to explain why.
// =============================================================================

describe('seed data', () => {
  describe('permissions', () => {
    it('declares each permission exactly once', () => {
      // Duplicates would not break the upsert — the second one would simply
      // update the first — but they are always a copy-paste that meant to say
      // something else.
      const names = PERMISSIONS.map((permission) => permission.name);
      const duplicated = names.filter(
        (name, index) => names.indexOf(name) !== index,
      );

      expect(duplicated).toEqual([]);
    });

    it('gives every permission a description', () => {
      const undescribed = PERMISSIONS.filter(
        (permission) => !permission.description?.trim(),
      ).map((permission) => permission.name);

      expect(undescribed).toEqual([]);
    });

    it('seeds every permission the API actually enforces', () => {
      // `roles.constants.ts` is the list the guards read; this file is the list
      // the database gets. A permission in the first and not the second is a
      // route nobody can reach.
      const seeded = new Set<string>(
        PERMISSIONS.map((permission) => permission.name),
      );
      const missing = Object.values(PERMISSION_CONSTANTS).filter(
        (permission) => !seeded.has(permission),
      );

      expect(missing).toEqual([]);
    });

    it('seeds the operations permissions this epic introduces (#256)', () => {
      const seeded = new Set<string>(
        PERMISSIONS.map((permission) => permission.name),
      );

      for (const permission of [
        'jobs:read',
        'jobs:write',
        'nodes:read',
        'nodes:write',
        'db_backup:read',
        'db_backup:write',
        'db_backup:restore',
      ]) {
        expect(seeded.has(permission)).toBe(true);
      }
    });

    it('seeds the broadcasts permissions this epic introduces (#320)', () => {
      const seeded = new Set<string>(
        PERMISSIONS.map((permission) => permission.name),
      );

      for (const permission of ['broadcasts:read', 'broadcasts:write']) {
        expect(seeded.has(permission)).toBe(true);
      }
    });
  });

  describe('role-permission mappings', () => {
    it('names only roles that are seeded', () => {
      const roles = new Set<string>(ROLES.map((role) => role.name));
      const unknown = Object.keys(ROLE_PERMISSIONS).filter(
        (role) => !roles.has(role),
      );

      expect(unknown).toEqual([]);
    });

    it('names only permissions that are seeded', () => {
      // `seedRolePermissions` skips a permission it cannot find, silently. A
      // typo here therefore costs a grant with no error anywhere.
      const seeded = new Set<string>(
        PERMISSIONS.map((permission) => permission.name),
      );
      const unknown = Object.entries(ROLE_PERMISSIONS).flatMap(
        ([role, permissions]) =>
          permissions
            .filter((permission) => !seeded.has(permission))
            .map((permission) => `${role}: ${permission}`),
      );

      expect(unknown).toEqual([]);
    });

    it('grants each permission to a role at most once', () => {
      // The upsert makes a repeat harmless; it still means the list was edited
      // by someone who could not see what was already in it.
      const duplicated = Object.entries(ROLE_PERMISSIONS).flatMap(
        ([role, permissions]) =>
          permissions
            .filter(
              (permission, index) =>
                permissions.indexOf(permission) !== index,
            )
            .map((permission) => `${role}: ${permission}`),
      );

      expect(duplicated).toEqual([]);
    });

    it('grants the operations permissions to Admin and to nobody else (#256)', () => {
      const operations = [
        'jobs:read',
        'jobs:write',
        'nodes:read',
        'nodes:write',
        'db_backup:read',
        'db_backup:write',
        'db_backup:restore',
      ];

      for (const permission of operations) {
        expect(ROLE_PERMISSIONS.admin).toContain(permission);
      }

      // Including the READ halves. The queue, the fleet and the backup history
      // are operational surfaces; a later issue can widen one of them with an
      // argument for that surface, and widening is the direction that costs
      // nothing (these are rows, not a migration).
      const leaked = Object.entries(ROLE_PERMISSIONS)
        .filter(([role]) => role !== 'admin')
        .flatMap(([role, permissions]) =>
          permissions
            .filter((permission) => operations.includes(permission))
            .map((permission) => `${role}: ${permission}`),
        );

      expect(leaked).toEqual([]);
    });

    it('grants the storage-config permissions to Admin and to nobody else (#375)', () => {
      const storageConfig = ['storage_config:read', 'storage_config:write'];

      for (const permission of storageConfig) {
        expect(ROLE_PERMISSIONS.admin).toContain(permission);
      }

      const leaked = Object.entries(ROLE_PERMISSIONS)
        .filter(([role]) => role !== 'admin')
        .flatMap(([role, permissions]) =>
          permissions
            .filter((permission) => storageConfig.includes(permission))
            .map((permission) => `${role}: ${permission}`),
        );

      expect(leaked).toEqual([]);
    });

    it('⚠ keeps storage_config:* distinct from storage:*, which every role holds (#375)', () => {
      // The two are one character apart and mean completely different things:
      // `storage:*` gates OBJECT ACCESS (Viewer holds `storage:read`), while
      // `storage_config:*` decides which object store the deployment uses and
      // under whose credential. Folding them together would put a
      // credential-bearing configuration screen in front of the whole user base.
      expect(ROLE_PERMISSIONS.viewer).toContain('storage:read');
      expect(ROLE_PERMISSIONS.viewer).not.toContain('storage_config:read');
      expect(ROLE_PERMISSIONS.contributor).toContain('storage:write');
      expect(ROLE_PERMISSIONS.contributor).not.toContain('storage_config:write');
    });

    it('grants the broadcasts permissions to Admin and to nobody else (#320)', () => {
      const broadcasts = ['broadcasts:read', 'broadcasts:write'];

      for (const permission of broadcasts) {
        expect(ROLE_PERMISSIONS.admin).toContain(permission);
      }

      const leaked = Object.entries(ROLE_PERMISSIONS)
        .filter(([role]) => role !== 'admin')
        .flatMap(([role, permissions]) =>
          permissions
            .filter((permission) => broadcasts.includes(permission))
            .map((permission) => `${role}: ${permission}`),
        );

      expect(leaked).toEqual([]);
    });

    it('grants ai_config:* to Admin only, and ai:use to Admin and Contributor but NOT Viewer (#423, #499)', () => {
      // `ai_config:*` is the deployment-wide policy — same "narrow,
      // operational surface" posture as `storage_config:*`, `push:*`,
      // `broadcasts:*` and `nodes:*` above: Admin only, including the read
      // half.
      const aiConfig = ['ai_config:read', 'ai_config:write'];

      for (const permission of aiConfig) {
        expect(ROLE_PERMISSIONS.admin).toContain(permission);
      }

      const leakedConfig = Object.entries(ROLE_PERMISSIONS)
        .filter(([role]) => role !== 'admin')
        .flatMap(([role, permissions]) =>
          permissions
            .filter((permission) => aiConfig.includes(permission))
            .map((permission) => `${role}: ${permission}`),
        );

      expect(leakedConfig).toEqual([]);

      // `ai:use` is the opposite axis — may this caller invoke AI with their
      // OWN key. Admin and Contributor hold it; Viewer deliberately does NOT
      // (#499) — Viewer is the DEFAULT role every new signup lands in, and
      // under `byok_with_org_fallback` a default grant would let a brand-new
      // account spend the deployment's own org key with no administrator
      // having decided that.
      expect(ROLE_PERMISSIONS.admin).toContain('ai:use');
      expect(ROLE_PERMISSIONS.contributor).toContain('ai:use');
      expect(ROLE_PERMISSIONS.viewer).not.toContain('ai:use');
    });

    it('⚠ keeps ai_config:* distinct from ai:use, and withholds ai:use from Viewer (#423, #499)', () => {
      // One character apart in spirit (a colon vs. an underscore) and mean
      // completely different things — the same distinction
      // `storage_config:*` vs. `storage:*` draws two tests above.
      // `ai_config:*` decides whether AI is enabled for the whole deployment
      // and under which policy; `ai:use` decides whether one caller, with
      // their own key, may call it at all.
      expect(ROLE_PERMISSIONS.viewer).not.toContain('ai:use');
      expect(ROLE_PERMISSIONS.viewer).not.toContain('ai_config:read');
      expect(ROLE_PERMISSIONS.contributor).toContain('ai:use');
      expect(ROLE_PERMISSIONS.contributor).not.toContain('ai_config:write');
    });

    it('grants the telemetry permissions to Admin only (epic #528, story #533)', () => {
      const telemetry = ['telemetry:read', 'telemetry:write', 'telemetry:query'];

      for (const permission of telemetry) {
        expect(ROLE_PERMISSIONS.admin).toContain(permission);
      }

      const leaked = Object.entries(ROLE_PERMISSIONS)
        .filter(([role]) => role !== 'admin')
        .flatMap(([role, permissions]) =>
          permissions
            .filter((permission) => telemetry.includes(permission))
            .map((permission) => `${role}: ${permission}`),
        );

      expect(leaked).toEqual([]);
    });
  });

  describe('seeded system settings', () => {
    /**
     * The seed cannot import `DEFAULT_SYSTEM_SETTINGS` from `src/` — it runs
     * under ts-node outside the Nest build — so the two are a deliberate
     * duplicate, and a duplicate nobody checks is a duplicate that drifts. The
     * consequence of drift is mild but real: `readKnownSettings` degrades a
     * missing block to the API's defaults, so a seeded row that disagrees means
     * a fresh deployment's stored value and its effective value differ until the
     * first write, and an admin reading the row directly sees something the
     * application does not believe.
     */
    it('matches the API defaults exactly', () => {
      expect(SEEDED_SYSTEM_SETTINGS).toEqual(DEFAULT_SYSTEM_SETTINGS);
    });

    it('is a value the API would accept', () => {
      expect(() =>
        systemSettingsSchema.parse(SEEDED_SYSTEM_SETTINGS),
      ).not.toThrow();
    });
  });
});
