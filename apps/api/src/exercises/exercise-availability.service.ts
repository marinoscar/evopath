import { Injectable } from '@nestjs/common';

import { GymsService } from '../gyms/gyms.service';
import { PrismaService } from '../prisma/prisma.service';

// =============================================================================
// ExerciseAvailabilityService — which exercises a gym supports (E4.1)
// =============================================================================
//
// An exercise's requirement rows form GROUPS (rows sharing `groupIndex`). A
// group is satisfied when the gym has ANY listed equipment type, or any gym
// equipment whose type provides ANY listed capability. The exercise is
// available when EVERY group is satisfied; no rows means it needs nothing.
//
// `forGym` loads a gym's inventory once (its equipment type ids, then the union
// of those types' capability ids: one query each, after the owner check), and
// every exercise is evaluated against it in memory with the pure functions
// below. Availability is derived on read and never stored.
// =============================================================================

/** One requirement row: exactly one of the two ids is set. */
export interface RequirementRow {
  groupIndex: number;
  equipmentTypeId: string | null;
  capabilityId: string | null;
}

/** What a gym has: the ids may be given as arrays or sets. */
export interface GymInventory {
  equipmentTypeIds: Iterable<string>;
  capabilityIds: Iterable<string>;
}

/** A gym inventory as sets, what `forGym` returns. */
export interface ResolvedGymInventory extends GymInventory {
  equipmentTypeIds: ReadonlySet<string>;
  capabilityIds: ReadonlySet<string>;
}

function normalize(inventory: GymInventory): ResolvedGymInventory {
  return {
    equipmentTypeIds:
      inventory.equipmentTypeIds instanceof Set ? inventory.equipmentTypeIds : new Set(inventory.equipmentTypeIds),
    capabilityIds: inventory.capabilityIds instanceof Set ? inventory.capabilityIds : new Set(inventory.capabilityIds),
  };
}

function rowSatisfied(row: RequirementRow, inventory: ResolvedGymInventory): boolean {
  if (row.equipmentTypeId !== null) return inventory.equipmentTypeIds.has(row.equipmentTypeId);
  if (row.capabilityId !== null) return inventory.capabilityIds.has(row.capabilityId);
  return false;
}

/** The requirement rows grouped by `groupIndex`, lowest index first. */
export function groupRequirements<T extends RequirementRow>(requirements: readonly T[]): T[][] {
  const groups = new Map<number, T[]>();
  for (const row of requirements) {
    const group = groups.get(row.groupIndex);
    if (group) group.push(row);
    else groups.set(row.groupIndex, [row]);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, rows]) => rows);
}

/**
 * The rows of the first (lowest `groupIndex`) group the inventory does not
 * satisfy, or `null` when every group is satisfied.
 */
export function firstUnsatisfiedGroup<T extends RequirementRow>(
  requirements: readonly T[],
  inventory: GymInventory,
): T[] | null {
  const have = normalize(inventory);
  for (const group of groupRequirements(requirements)) {
    if (!group.some((row) => rowSatisfied(row, have))) {
      return group;
    }
  }
  return null;
}

/** Whether a gym with `inventory` satisfies every requirement group. */
export function isAvailable(requirements: readonly RequirementRow[], inventory: GymInventory): boolean {
  return firstUnsatisfiedGroup(requirements, inventory) === null;
}

/** A requirement row with the display name of its equipment type or capability. */
export interface NamedRequirementRow extends RequirementRow {
  name: string;
}

export interface Availability {
  available: boolean;
  /** Names of the first unsatisfied group's options; empty when available. */
  missing: string[];
}

/** `available` plus `missing`: the human names of the first unsatisfied group's options. */
export function evaluateAvailability(requirements: readonly NamedRequirementRow[], inventory: GymInventory): Availability {
  const unsatisfied = firstUnsatisfiedGroup(requirements, inventory);
  if (unsatisfied === null) {
    return { available: true, missing: [] };
  }
  return { available: false, missing: [...new Set(unsatisfied.map((row) => row.name))] };
}

@Injectable()
export class ExerciseAvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gyms: GymsService,
  ) {}

  /**
   * The caller's gym inventory: its equipment type ids and the union of those
   * types' capability ids. Another user's gym (or no gym) is a 404.
   */
  async forGym(userId: string, gymId: string): Promise<ResolvedGymInventory> {
    await this.gyms.findOwned(userId, gymId);

    const equipment = await this.prisma.gymEquipment.findMany({
      where: { gymId, gym: { userId } },
      select: { equipmentTypeId: true },
      distinct: ['equipmentTypeId'],
    });
    const equipmentTypeIds = new Set(equipment.map((row) => row.equipmentTypeId));

    if (equipmentTypeIds.size === 0) {
      return { equipmentTypeIds, capabilityIds: new Set() };
    }

    const capabilities = await this.prisma.equipmentTypeCapability.findMany({
      where: { equipmentTypeId: { in: [...equipmentTypeIds] } },
      select: { capabilityId: true },
      distinct: ['capabilityId'],
    });

    return { equipmentTypeIds, capabilityIds: new Set(capabilities.map((row) => row.capabilityId)) };
  }
}
