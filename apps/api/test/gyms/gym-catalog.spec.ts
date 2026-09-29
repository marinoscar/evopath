import {
  CAPABILITY_CATALOG,
  EQUIPMENT_CATALOG,
  EQUIPMENT_CATEGORIES,
  MOVEMENT_PATTERNS,
  MUSCLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
} from '../../prisma/seed-data';
import { PERMISSIONS as PERMISSION_CONSTANTS } from '../../src/common/constants/roles.constants';

// Pure guard over the seeded gym catalogs (E3.2). Needs no database.
describe('gym catalogs (seed data)', () => {
  const capSlugs = new Set(CAPABILITY_CATALOG.map((c) => c.slug));
  const links = (slug: string) =>
    EQUIPMENT_CATALOG.find((e) => e.slug === slug)?.capabilities ?? [];

  it('has 50 capabilities and at least 40 equipment types', () => {
    expect(CAPABILITY_CATALOG).toHaveLength(50);
    expect(EQUIPMENT_CATALOG.length).toBeGreaterThanOrEqual(40);
  });

  it('has unique slugs in both catalogs', () => {
    expect(capSlugs.size).toBe(CAPABILITY_CATALOG.length);
    expect(new Set(EQUIPMENT_CATALOG.map((e) => e.slug)).size).toBe(
      EQUIPMENT_CATALOG.length,
    );
  });

  it('uses only valid movement patterns and muscles', () => {
    for (const cap of CAPABILITY_CATALOG) {
      expect(MOVEMENT_PATTERNS).toContain(cap.movementPattern);
      expect(cap.primaryMuscles.length).toBeGreaterThan(0);
      for (const m of cap.primaryMuscles) expect(MUSCLES).toContain(m);
    }
  });

  it('uses valid categories and 2-4 aliases per equipment type', () => {
    for (const e of EQUIPMENT_CATALOG) {
      expect(EQUIPMENT_CATEGORIES).toContain(e.category);
      expect(e.aliases.length).toBeGreaterThanOrEqual(2);
      expect(e.aliases.length).toBeLessThanOrEqual(4);
    }
  });

  it('resolves every capability reference (typo guard)', () => {
    for (const e of EQUIPMENT_CATALOG) {
      for (const slug of e.capabilities) {
        expect({ equipment: e.slug, slug, known: capSlugs.has(slug) }).toEqual({
          equipment: e.slug,
          slug,
          known: true,
        });
      }
      expect(new Set(e.capabilities).size).toBe(e.capabilities.length);
    }
  });

  it('carries the slugs the reference examples need', () => {
    const slugs = EQUIPMENT_CATALOG.map((e) => e.slug);
    expect(slugs).toEqual(
      expect.arrayContaining([
        'elliptical',
        'stationary_bike',
        'leg_curl_machine',
        'functional_trainer',
        'lat_pulldown',
      ]),
    );
    expect(capSlugs.has('leg_curl')).toBe(true);
  });

  it('links leg_curl_machine to exactly leg_curl', () => {
    expect(links('leg_curl_machine')).toEqual(['leg_curl']);
  });

  it('links functional_trainer to the cable movements', () => {
    expect(links('functional_trainer')).toEqual(
      expect.arrayContaining([
        'cable_row',
        'cable_fly',
        'lat_pulldown',
        'triceps_extension',
        'biceps_curl',
        'lateral_raise',
        'face_pull',
      ]),
    );
  });

  it('gives weight_plates and medicine_ball no capabilities', () => {
    expect(links('weight_plates')).toEqual([]);
    expect(links('medicine_ball')).toEqual([]);
  });

  it('grants gyms:read and gyms:write to every seeded role', () => {
    expect(PERMISSIONS.map((p) => p.name)).toEqual(
      expect.arrayContaining(['gyms:read', 'gyms:write']),
    );
    expect(PERMISSION_CONSTANTS.GYMS_READ).toBe('gyms:read');
    expect(PERMISSION_CONSTANTS.GYMS_WRITE).toBe('gyms:write');
    for (const role of ROLES.map((r) => r.name)) {
      expect(ROLE_PERMISSIONS[role]).toEqual(
        expect.arrayContaining(['gyms:read', 'gyms:write']),
      );
    }
  });
});
