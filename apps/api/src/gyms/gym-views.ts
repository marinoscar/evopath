import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Capability, type Gym } from '@prisma/client';

import type { CapabilityRefData, CapabilityViewData, EquipmentTypeViewData } from './dto/equipment-type.dto';
import type { GymEquipmentViewData } from './dto/gym-equipment.dto';
import type { GymPhotoViewData } from './dto/gym-photo.dto';
import type { GymViewData } from './dto/gym.dto';

// =============================================================================
// Gyms (E3.3) — Prisma includes, row-to-view mappers and error helpers
// =============================================================================

const CAPABILITY_REF_INCLUDE = {
  capabilities: {
    include: { capability: { select: { id: true, slug: true, name: true, sortOrder: true } } },
  },
} satisfies Prisma.EquipmentTypeInclude;

export const EQUIPMENT_TYPE_INCLUDE = CAPABILITY_REF_INCLUDE;
export type EquipmentTypeWithCapabilities = Prisma.EquipmentTypeGetPayload<{ include: typeof EQUIPMENT_TYPE_INCLUDE }>;

export const GYM_EQUIPMENT_INCLUDE = {
  equipmentType: { include: CAPABILITY_REF_INCLUDE },
} satisfies Prisma.GymEquipmentInclude;
export type GymEquipmentWithType = Prisma.GymEquipmentGetPayload<{ include: typeof GYM_EQUIPMENT_INCLUDE }>;

export const GYM_PHOTO_INCLUDE = {
  equipment: { select: { gymEquipmentId: true } },
} satisfies Prisma.GymPhotoInclude;
export type GymPhotoWithLinks = Prisma.GymPhotoGetPayload<{ include: typeof GYM_PHOTO_INCLUDE }>;

/** Equipment and photos in a stable oldest-first order. */
export const OLDEST_FIRST = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

function capabilityRefs(type: EquipmentTypeWithCapabilities): CapabilityRefData[] {
  return [...type.capabilities]
    .sort((a, b) => a.capability.sortOrder - b.capability.sortOrder || a.capability.name.localeCompare(b.capability.name))
    .map(({ capability }) => ({ id: capability.id, slug: capability.slug, name: capability.name }));
}

export function toGymView(gym: Gym): GymViewData {
  return {
    id: gym.id,
    name: gym.name,
    type: gym.type,
    description: gym.description,
    notes: gym.notes,
    latitude: gym.latitude,
    longitude: gym.longitude,
    isDefault: gym.isDefault,
    isTemporary: gym.isTemporary,
    createdAt: gym.createdAt.toISOString(),
    updatedAt: gym.updatedAt.toISOString(),
  };
}

export function toEquipmentTypeView(type: EquipmentTypeWithCapabilities): EquipmentTypeViewData {
  return {
    id: type.id,
    slug: type.slug,
    name: type.name,
    category: type.category as EquipmentTypeViewData['category'],
    aliases: type.aliases,
    description: type.description,
    isCustom: type.ownerUserId !== null,
    capabilities: capabilityRefs(type),
  };
}

export function toGymEquipmentView(row: GymEquipmentWithType): GymEquipmentViewData {
  return {
    id: row.id,
    gymId: row.gymId,
    equipmentTypeId: row.equipmentTypeId,
    equipmentType: {
      id: row.equipmentType.id,
      slug: row.equipmentType.slug,
      name: row.equipmentType.name,
      category: row.equipmentType.category as GymEquipmentViewData['equipmentType']['category'],
      isCustom: row.equipmentType.ownerUserId !== null,
      capabilities: capabilityRefs(row.equipmentType),
    },
    quantity: row.quantity,
    brand: row.brand,
    model: row.model,
    notes: row.notes,
    origin: row.origin as GymEquipmentViewData['origin'],
    confidence: (row.confidence ?? null) as GymEquipmentViewData['confidence'],
    userVerified: row.userVerified,
    originalAiValue: row.originalAiValue ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toGymPhotoView(photo: GymPhotoWithLinks): GymPhotoViewData {
  return {
    id: photo.id,
    gymId: photo.gymId,
    storageObjectId: photo.storageObjectId,
    caption: photo.caption,
    takenAt: photo.takenAt ? photo.takenAt.toISOString() : null,
    equipmentIds: photo.equipment.map((link) => link.gymEquipmentId).sort(),
    createdAt: photo.createdAt.toISOString(),
  };
}

export function toCapabilityView(capability: Capability): CapabilityViewData {
  return {
    id: capability.id,
    slug: capability.slug,
    name: capability.name,
    movementPattern: capability.movementPattern,
    primaryMuscles: capability.primaryMuscles,
    description: capability.description,
  };
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export function gymNotFound(): NotFoundException {
  return new NotFoundException('Gym not found');
}

export function equipmentNotFound(): NotFoundException {
  return new NotFoundException('Equipment not found');
}

export function equipmentTypeNotFound(): NotFoundException {
  return new NotFoundException('Equipment type not found');
}

export function photoNotFound(): NotFoundException {
  return new NotFoundException('Photo not found');
}

/** A refusal with a machine-readable `details.reason`. */
export function refuse(
  status: 400 | 409,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): BadRequestException | ConflictException {
  const body = { message, details: { reason, ...extra } };
  return status === 400 ? new BadRequestException(body) : new ConflictException(body);
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}
