import { BadRequestException, NotFoundException } from '@nestjs/common';

import { seedVocabulary } from '../../../test/fixtures/gym-scan.fixtures';
import { IntakeKindRegistry } from '../../intake/intake-kind.registry';
import { GymEquipmentIntakeKind } from './gym-equipment.intake-kind';
import { gymEquipmentValueSchema } from './gym-equipment.value';

// =============================================================================
// The `gym_equipment` intake kind (E3.4): registration, context, value rules
// =============================================================================
//
// `apply` writes real rows and is proven against Postgres in
// `test/gyms/gym-equipment-scan.db.spec.ts`.
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const GYM = '22222222-2222-4222-8222-222222222222';
const vocab = seedVocabulary();

function setup() {
  const registry = new IntakeKindRegistry();
  const gyms = { findOwned: jest.fn(async () => ({ id: GYM, userId: USER })) };
  const prisma = {
    gym: { findUnique: jest.fn(async () => ({ userId: USER })) },
    equipmentType: { findFirst: jest.fn(async (): Promise<unknown> => null) },
  };
  const kind = new GymEquipmentIntakeKind(
    registry,
    gyms as never,
    { load: async () => vocab } as never,
    prisma as never,
  );
  kind.onModuleInit();
  return { registry, gyms, prisma, kind };
}

const base = {
  equipmentTypeSlug: 'leg_curl_machine',
  name: '',
  quantity: 1,
  quantityUncertain: false,
  brand: null,
  brandEvidence: null,
  model: null,
  configuration: null,
  notes: null,
  capabilitySlugs: [],
  targetMuscles: [],
};

describe('GymEquipmentIntakeKind', () => {
  it('registers itself as gym_equipment, analyzed by ai.equipment.scan, 48 photos, item kind equipment', () => {
    const { registry, kind } = setup();

    expect(registry.get('gym_equipment')).toBe(kind);
    expect(kind.analyzeJobType).toBe('ai.equipment.scan');
    expect(kind.maxPhotos).toBe(48);
    expect(kind.itemKinds).toEqual(['equipment']);
  });

  it('context is { gymId: uuid } only', () => {
    const { kind } = setup();

    expect(kind.contextSchema.safeParse({ gymId: GYM }).success).toBe(true);
    expect(kind.contextSchema.safeParse({ gymId: 'nope' }).success).toBe(false);
    expect(kind.contextSchema.safeParse({ gymId: GYM, extra: 1 }).success).toBe(false);
    expect(kind.contextSchema.safeParse(undefined).success).toBe(false);
  });

  it("assertContext refuses another user's gym with the gyms module's 404", async () => {
    const { kind, gyms } = setup();
    gyms.findOwned.mockRejectedValueOnce(new NotFoundException('Gym not found'));

    await expect(kind.assertContext(USER, { gymId: GYM })).rejects.toBeInstanceOf(NotFoundException);
    expect(gyms.findOwned).toHaveBeenCalledWith(USER, GYM);
  });

  it('the subject is the gym', () => {
    expect(setup().kind.subjectOf({ gymId: GYM })).toEqual({ subjectType: 'gym', subjectId: GYM });
  });

  describe('valueSchema', () => {
    it.each([
      ['a quantity of 0', { quantity: 0 }],
      ['a quantity of 100', { quantity: 100 }],
      ['a fractional quantity', { quantity: 1.5 }],
      ['a brand over 60', { brand: 'x'.repeat(61) }],
      ['brandEvidence over 200', { brandEvidence: 'x'.repeat(201) }],
      ['a model over 80', { model: 'x'.repeat(81) }],
      ['a configuration over 60', { configuration: 'x'.repeat(61) }],
      ['notes over 1000', { notes: 'x'.repeat(1001) }],
      ['a name over 80', { name: 'x'.repeat(81) }],
      ['an unknown key', { origin: 'ai' }],
      ['no name for an unidentified item', { equipmentTypeSlug: null, name: '  ' }],
      ['more than 12 capabilities for an unidentified item', { equipmentTypeSlug: null, name: 'Sled', capabilitySlugs: Array.from({ length: 13 }, (_, i) => `c${i}`) }],
    ])('rejects %s', (_label, patch) => {
      expect(gymEquipmentValueSchema.safeParse({ ...base, ...patch }).success).toBe(false);
    });

    it('fills defaults and reads blank text as null', () => {
      const parsed = gymEquipmentValueSchema.parse({ equipmentTypeSlug: 'treadmill', quantity: 2, brand: '  ' });

      expect(parsed).toEqual({ ...base, equipmentTypeSlug: 'treadmill', quantity: 2 });
    });
  });

  describe('normalizeValue', () => {
    it('fills the catalog name and recomputes capabilities and muscles from the catalog', async () => {
      const { kind } = setup();
      const value = gymEquipmentValueSchema.parse({ ...base, capabilitySlugs: ['back_squat'], targetMuscles: ['chest'] });

      expect(await kind.normalizeValue(value, { gymId: GYM }, 'user')).toMatchObject({
        name: 'Leg curl machine',
        capabilitySlugs: ['leg_curl'],
        targetMuscles: ['hamstrings'],
      });
    });

    it("keeps a user's own name for a catalog item", async () => {
      const { kind } = setup();
      const value = gymEquipmentValueSchema.parse({ ...base, name: 'Old leg curl' });

      expect((await kind.normalizeValue(value, { gymId: GYM }, 'user')).name).toBe('Old leg curl');
    });

    it('keeps an unidentified item\'s capabilities to the vocabulary, drops full_body next to others', async () => {
      const { kind } = setup();
      const value = gymEquipmentValueSchema.parse({
        ...base,
        equipmentTypeSlug: null,
        name: 'Sled',
        capabilitySlugs: ['made_up', 'steady_state_cardio', 'leg_press'],
      });

      expect(await kind.normalizeValue(value, { gymId: GYM }, 'user')).toMatchObject({
        capabilitySlugs: ['leg_press', 'steady_state_cardio'],
        targetMuscles: ['quads', 'glutes'],
      });
    });

    it("resolves the gym owner's custom slug, and refuses an unknown slug with 400", async () => {
      const { kind, prisma } = setup();
      prisma.equipmentType.findFirst.mockResolvedValueOnce({
        name: 'Sled',
        capabilities: [{ capability: { slug: 'leg_press' } }],
      });

      const custom = gymEquipmentValueSchema.parse({ ...base, equipmentTypeSlug: 'custom-abcd1234' });
      expect(await kind.normalizeValue(custom, { gymId: GYM }, 'user')).toMatchObject({
        name: 'Sled',
        capabilitySlugs: ['leg_press'],
      });
      expect(prisma.equipmentType.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { slug: 'custom-abcd1234', ownerUserId: USER } }),
      );

      const unknown = gymEquipmentValueSchema.parse({ ...base, equipmentTypeSlug: 'hovercraft' });
      await expect(kind.normalizeValue(unknown, { gymId: GYM }, 'user')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('never throws for an analyzer item with an unknown slug: keeps it as a named "other"', async () => {
      const { kind } = setup();
      const stale = gymEquipmentValueSchema.parse({
        ...base,
        equipmentTypeSlug: 'removed_machine',
        name: 'Removed machine',
        capabilitySlugs: Array.from({ length: 15 }, (_, i) => (i === 0 ? 'leg_press' : `cap_${i}`)),
      });

      const normalized = await kind.normalizeValue(stale, { gymId: GYM }, 'analyzer');

      expect(normalized).toMatchObject({
        equipmentTypeSlug: null,
        name: 'Removed machine',
        capabilitySlugs: ['leg_press'],
        targetMuscles: ['quads', 'glutes'],
      });
      // Still a valid stored value (the null-slug rules hold).
      expect(gymEquipmentValueSchema.safeParse(normalized).success).toBe(true);

      const nameless = gymEquipmentValueSchema.parse({ ...base, equipmentTypeSlug: 'hovercraft' });
      expect(await kind.normalizeValue(nameless, { gymId: GYM }, 'analyzer')).toMatchObject({
        equipmentTypeSlug: null,
        name: 'hovercraft',
      });
    });

    it('treats an analyzer catalog item exactly like a user one', async () => {
      const { kind } = setup();
      const value = gymEquipmentValueSchema.parse(base);

      expect(await kind.normalizeValue(value, { gymId: GYM }, 'analyzer')).toEqual(
        await kind.normalizeValue(value, { gymId: GYM }, 'user'),
      );
    });
  });
});
