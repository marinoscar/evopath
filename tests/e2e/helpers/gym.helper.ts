import type { AuthedApi } from './api.helper';

/**
 * Gym setup through the real API for the workout specs (E4.7).
 *
 * Equipment is named by catalog slug (`prisma/seed-data.ts`), not by id, so a
 * spec reads as what the gym has: `['adjustable_dumbbells', 'adjustable_bench']`.
 */

interface EquipmentTypeBody {
  id: string;
  slug: string;
  name: string;
}

export interface CreatedGym {
  id: string;
  name: string;
}

/** The catalog type with this slug; throws when the stack is not seeded. */
async function equipmentTypeBySlug(api: AuthedApi, slug: string): Promise<EquipmentTypeBody> {
  const types = await api.get<EquipmentTypeBody[]>('/api/equipment-types?limit=200');
  const type = types.find((candidate) => candidate.slug === slug);
  if (!type) throw new Error(`No equipment type with slug ${slug}; migrate and seed the stack first.`);
  return type;
}

/**
 * Create a `home` gym holding one of each named equipment type. The first gym
 * a user creates becomes their default, which is what a new workout picks.
 */
export async function createGymWithEquipment(
  api: AuthedApi,
  name: string,
  equipmentSlugs: readonly string[],
): Promise<CreatedGym> {
  const gym = await api.post<{ id: string; name: string }>('/api/gyms', { name, type: 'home' });
  for (const slug of equipmentSlugs) {
    const type = await equipmentTypeBySlug(api, slug);
    await api.post(`/api/gyms/${gym.id}/equipment`, { equipmentTypeId: type.id, quantity: 1 });
  }
  return { id: gym.id, name: gym.name };
}

/** The dumbbell-and-bench home gym most workout tests train in. */
export async function createDumbbellGym(api: AuthedApi, name = 'Garage Gym'): Promise<CreatedGym> {
  return createGymWithEquipment(api, name, ['adjustable_dumbbells', 'adjustable_bench']);
}
