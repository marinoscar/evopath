import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, type DraftItem } from '@prisma/client';
import { z } from 'zod';

import { PERMISSIONS } from '../../common/constants/roles.constants';
import type {
  IntakeApplyArgs,
  IntakeKind,
  IntakeKindPermissions,
  IntakeValueSource,
} from '../../intake/intake-kind.interface';
import { IntakeKindRegistry } from '../../intake/intake-kind.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { customSlug } from '../equipment-types.service';
import {
  CUSTOM_SLUG_PREFIX,
  EQUIPMENT_TYPE_CAPABILITIES_MAX,
  EQUIPMENT_TYPE_NAME_MAX,
  GYM_REFUSALS,
  MAX_CUSTOM_EQUIPMENT_TYPES_PER_USER,
  MAX_PHOTOS_PER_GYM,
} from '../gyms.constants';
import { GymsService } from '../gyms.service';
import { gymNotFound, refuse } from '../gym-views';
import { EQUIPMENT_ITEM_KIND } from '../scan/equipment-scan.mapper';
import { EquipmentVocabularyService, knownCapabilitySlugs, type EquipmentVocabulary } from '../scan/equipment-vocabulary';
import {
  gymEquipmentValueSchema,
  normalizeEquipmentValue,
  resolveCatalogType,
  type GymEquipmentValue,
  type ResolvedEquipmentType,
} from './gym-equipment.value';

// =============================================================================
// The `gym_equipment` intake kind (E3.4): "Scan gym"
// =============================================================================
//
// Context `{ gymId }`: the caller's gym (another user's is a 404). The analyzer
// is `ai.equipment.scan`; each draft is one piece of equipment
// (`gym-equipment.value.ts`). The intake's subject is the gym, so
// `GET /intakes?kind=gym_equipment&subjectId=<gymId>` finds an unfinished scan.
//
// APPLY (inside the intake module's transaction; every write through `tx`):
//
//   1. every intake photo becomes a `GymPhoto` of the gym (an object already
//      attached as a gym photo is skipped; past the gym's 100-photo cap the
//      rest are skipped and counted in `photosSkipped`);
//   2. each accepted item's type is resolved: a catalog slug (or the caller's
//      custom slug) is that row; a `null` slug is the caller's custom type with
//      the same name (case-insensitive), else a new custom type (category
//      `cardio` when a capability is cardio, else `accessories`), created once
//      per name per apply;
//   3. a gym row with the same `(type, lower(brand), lower(model))` (nulls
//      equal) is LEFT UNTOUCHED and counted `merged`; otherwise a row is
//      created with the item's provenance (`origin`, `confidence`,
//      `userVerified`, and `originalAiValue` only when the AI value was edited);
//   4. the equipment row is linked to the gym photos of its `sourcePhotoIds`.
//
// Result: `{ gymId, created, merged, photosAttached, photosSkipped }`.
//
// PERMISSIONS. `requiredPermissions` adds `gyms:read` / `gyms:write` to the
// intake routes' `intakes:*` (a 403 `MISSING_KIND_PERMISSIONS` otherwise).
// =============================================================================

export const GYM_EQUIPMENT_INTAKE_KIND = 'gym_equipment';
export const EQUIPMENT_SCAN_JOB_TYPE = 'ai.equipment.scan';
export const GYM_EQUIPMENT_INTAKE_MAX_PHOTOS = 48;
export const GYM_INTAKE_SUBJECT_TYPE = 'gym';

const contextSchema = z.object({ gymId: z.string().uuid() }).strict();
export type GymEquipmentIntakeContext = z.infer<typeof contextSchema>;

/** What an edited AI item's `originalAiValue` becomes on the gym row. */
export interface ScanOriginalAiValue {
  equipmentTypeId: string | null;
  equipmentTypeSlug: string | null;
  name: string;
  quantity: number;
  brand: string | null;
  model: string | null;
  notes: string | null;
}

export interface GymEquipmentApplyResult {
  gymId: string;
  created: number;
  merged: number;
  photosAttached: number;
  photosSkipped: number;
}

const CARDIO_PATTERN = 'cardio';
const DEFAULT_CUSTOM_CATEGORY = 'accessories';

function lowerOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function invalidSlug(slug: string): BadRequestException {
  return new BadRequestException({
    message: 'Validation failed',
    details: { issues: [{ path: 'value.equipmentTypeSlug', message: `Unknown equipment type "${slug}"` }] },
  });
}

@Injectable()
export class GymEquipmentIntakeKind
  implements IntakeKind<GymEquipmentIntakeContext, GymEquipmentValue>, OnModuleInit
{
  // PERMANENT once photo_intakes rows carry it.
  readonly kind = GYM_EQUIPMENT_INTAKE_KIND;
  readonly contextSchema = contextSchema;
  readonly valueSchema = gymEquipmentValueSchema;
  readonly analyzeJobType = EQUIPMENT_SCAN_JOB_TYPE;
  readonly aiFeature = 'gym_scan' as const;
  readonly maxPhotos = GYM_EQUIPMENT_INTAKE_MAX_PHOTOS;
  readonly itemKinds = [EQUIPMENT_ITEM_KIND] as const;
  /**
   * `apply` writes the gym's equipment and photos, which the gym routes guard
   * with `gyms:*`; an intake must not be a side door around them.
   */
  readonly requiredPermissions: IntakeKindPermissions = {
    read: [PERMISSIONS.GYMS_READ],
    write: [PERMISSIONS.GYMS_WRITE],
  };

  constructor(
    private readonly registry: IntakeKindRegistry,
    private readonly gyms: GymsService,
    private readonly vocabulary: EquipmentVocabularyService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async assertContext(userId: string, context: GymEquipmentIntakeContext): Promise<void> {
    await this.gyms.findOwned(userId, context.gymId);
  }

  subjectOf(context: GymEquipmentIntakeContext): { subjectType: string; subjectId: string } {
    return { subjectType: GYM_INTAKE_SUBJECT_TYPE, subjectId: context.gymId };
  }

  /**
   * Re-derives the catalog fields. An unknown slug is a 400 for a user's add
   * or edit; for an analyzer item (`source: 'analyzer'`, e.g. a catalog row
   * removed mid-scan) it never throws: the item is kept as a named "other"
   * (slug `null`), so the review still shows it and the user decides.
   */
  async normalizeValue(
    value: GymEquipmentValue,
    context: GymEquipmentIntakeContext,
    source: IntakeValueSource,
  ): Promise<GymEquipmentValue> {
    const vocab = await this.vocabulary.load();
    const slug = value.equipmentTypeSlug;

    if (slug === null) {
      return normalizeEquipmentValue(value, vocab, null);
    }

    const resolved = resolveCatalogType(vocab, slug) ?? (await this.customTypeOfGymOwner(context.gymId, slug));

    if (resolved) {
      return normalizeEquipmentValue(value, vocab, resolved);
    }

    if (source === 'user') {
      throw invalidSlug(slug);
    }

    return normalizeEquipmentValue(
      {
        ...value,
        equipmentTypeSlug: null,
        name: (value.name || slug).slice(0, EQUIPMENT_TYPE_NAME_MAX),
        // The null-slug cap, so the stored value still passes `valueSchema`.
        capabilitySlugs: value.capabilitySlugs.slice(0, EQUIPMENT_TYPE_CAPABILITIES_MAX),
      },
      vocab,
      null,
    );
  }

  async apply({ tx, userId, intake, context, accepted }: IntakeApplyArgs<GymEquipmentIntakeContext>): Promise<GymEquipmentApplyResult> {
    const gym = await tx.gym.findFirst({ where: { id: context.gymId, userId }, select: { id: true } });

    if (!gym) {
      throw gymNotFound();
    }

    const gymId = gym.id;
    const vocab = await this.vocabulary.load();
    const { photosAttached, photosSkipped, photoIdByObject } = await this.attachPhotos(tx, gymId, intake.id);

    const types = new TypeResolver(tx, userId, vocab);
    let created = 0;
    let merged = 0;

    for (const item of accepted) {
      const value = this.parseStored(item);
      const equipmentTypeId = await types.resolve(value);
      const existing = await this.findSame(tx, gymId, equipmentTypeId, value);
      let gymEquipmentId: string;

      if (existing) {
        gymEquipmentId = existing;
        merged += 1;
      } else {
        const row = await tx.gymEquipment.create({
          data: {
            gymId,
            equipmentTypeId,
            quantity: value.quantity,
            brand: value.brand,
            model: value.model,
            notes: value.notes,
            origin: item.origin === 'ai' ? 'ai' : 'manual',
            confidence: item.origin === 'ai' ? item.confidence : null,
            userVerified: item.userVerified,
            originalAiValue: await this.originalAiValue(item, types),
          },
          select: { id: true },
        });
        gymEquipmentId = row.id;
        created += 1;
      }

      const links = [...new Set(item.sourcePhotoIds)]
        .map((storageObjectId) => photoIdByObject.get(storageObjectId))
        .filter((id): id is string => id !== undefined);

      if (links.length > 0) {
        await tx.gymEquipmentPhoto.createMany({
          data: links.map((gymPhotoId) => ({ gymEquipmentId, gymPhotoId })),
          skipDuplicates: true,
        });
      }
    }

    return { gymId, created, merged, photosAttached, photosSkipped };
  }

  // ---------------------------------------------------------------------------

  /** A stored value, re-read with the schema (it was validated when stored). */
  private parseStored(item: DraftItem): GymEquipmentValue {
    const parsed = gymEquipmentValueSchema.safeParse(item.value);

    if (!parsed.success) {
      throw new BadRequestException({
        message: 'An accepted item has an invalid value; edit it before applying',
        details: { itemId: item.id },
      });
    }

    return parsed.data;
  }

  /**
   * Every intake photo as a gym photo. `skipDuplicates` (ON CONFLICT DO
   * NOTHING on the unique storage object) keeps a concurrent attach from
   * aborting the transaction. Returns the storage object -> gym photo map
   * for THIS gym.
   */
  private async attachPhotos(tx: Prisma.TransactionClient, gymId: string, intakeId: string) {
    const photos = await tx.photoIntakePhoto.findMany({
      where: { intakeId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { storageObjectId: true },
    });
    const objectIds = photos.map((photo) => photo.storageObjectId);

    const already = await tx.gymPhoto.findMany({
      where: { storageObjectId: { in: objectIds } },
      select: { storageObjectId: true },
    });
    const attachedAnywhere = new Set(already.map((row) => row.storageObjectId));
    const toAttach = objectIds.filter((id) => !attachedAnywhere.has(id));

    const current = await tx.gymPhoto.count({ where: { gymId } });
    const room = Math.max(0, MAX_PHOTOS_PER_GYM - current);
    const attaching = toAttach.slice(0, room);

    const result =
      attaching.length > 0
        ? await tx.gymPhoto.createMany({
            data: attaching.map((storageObjectId) => ({ gymId, storageObjectId })),
            skipDuplicates: true,
          })
        : { count: 0 };

    const inGym = await tx.gymPhoto.findMany({
      where: { gymId, storageObjectId: { in: objectIds } },
      select: { id: true, storageObjectId: true },
    });

    return {
      photosAttached: result.count,
      photosSkipped: toAttach.length - attaching.length,
      photoIdByObject: new Map(inGym.map((row) => [row.storageObjectId, row.id] as const)),
    };
  }

  /** The gym's row with the same type, brand and model (case-insensitive, nulls equal). */
  private async findSame(
    tx: Prisma.TransactionClient,
    gymId: string,
    equipmentTypeId: string,
    value: GymEquipmentValue,
  ): Promise<string | null> {
    const rows = await tx.gymEquipment.findMany({
      where: { gymId, equipmentTypeId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, brand: true, model: true },
    });
    const brand = lowerOrNull(value.brand);
    const model = lowerOrNull(value.model);

    return rows.find((row) => lowerOrNull(row.brand) === brand && lowerOrNull(row.model) === model)?.id ?? null;
  }

  /** The AI's value before the user's first edit, as the gym row keeps it; `null` when never edited. */
  private async originalAiValue(
    item: DraftItem,
    types: TypeResolver,
  ): Promise<Prisma.InputJsonValue | typeof Prisma.DbNull> {
    if (item.origin !== 'ai' || item.originalAiValue === null || item.originalAiValue === undefined) {
      return Prisma.DbNull;
    }

    const parsed = gymEquipmentValueSchema.safeParse(item.originalAiValue);

    if (!parsed.success) {
      return Prisma.DbNull;
    }

    const original = parsed.data;
    const snapshot: ScanOriginalAiValue = {
      equipmentTypeId: await types.lookup(original),
      equipmentTypeSlug: original.equipmentTypeSlug,
      name: original.name,
      quantity: original.quantity,
      brand: original.brand,
      model: original.model,
      notes: original.notes,
    };

    return snapshot as unknown as Prisma.InputJsonValue;
  }

  /** A custom slug of the gym owner's, for a user's edit that picked their own type. */
  private async customTypeOfGymOwner(gymId: string, slug: string): Promise<ResolvedEquipmentType | null> {
    if (!slug.startsWith(CUSTOM_SLUG_PREFIX)) {
      return null;
    }

    const gym = await this.prisma.gym.findUnique({ where: { id: gymId }, select: { userId: true } });

    if (!gym) {
      return null;
    }

    const type = await this.prisma.equipmentType.findFirst({
      where: { slug, ownerUserId: gym.userId },
      select: { name: true, capabilities: { select: { capability: { select: { slug: true } } } } },
    });

    return type
      ? { name: type.name, capabilitySlugs: type.capabilities.map((link) => link.capability.slug) }
      : null;
  }
}

/**
 * Resolves item values to `equipment_types` ids inside one apply, creating
 * at most one custom type per (case-insensitive) name.
 */
class TypeResolver {
  private readonly bySlug = new Map<string, string | null>();
  private readonly byName = new Map<string, string>();

  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly userId: string,
    private readonly vocab: EquipmentVocabulary,
  ) {}

  /** The type id for a value, creating a custom type for an unknown name. */
  async resolve(value: GymEquipmentValue): Promise<string> {
    const found = await this.lookup(value);

    if (found) {
      return found;
    }

    return this.createCustom(value);
  }

  /** The type id for a value without creating anything, or null. */
  async lookup(value: GymEquipmentValue): Promise<string | null> {
    if (value.equipmentTypeSlug) {
      const bySlug = await this.slugId(value.equipmentTypeSlug);
      if (bySlug) return bySlug;
    }

    return this.customByName(value.name);
  }

  private async slugId(slug: string): Promise<string | null> {
    if (!this.bySlug.has(slug)) {
      const row = await this.tx.equipmentType.findFirst({
        where: { slug, OR: [{ ownerUserId: null }, { ownerUserId: this.userId }] },
        select: { id: true },
      });
      this.bySlug.set(slug, row?.id ?? null);
    }

    return this.bySlug.get(slug) ?? null;
  }

  private async customByName(name: string): Promise<string | null> {
    const key = name.trim().toLowerCase();

    if (!key) return null;

    const cached = this.byName.get(key);
    if (cached) return cached;

    const row = await this.tx.equipmentType.findFirst({
      where: { ownerUserId: this.userId, name: { equals: name.trim(), mode: 'insensitive' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });

    if (row) this.byName.set(key, row.id);

    return row?.id ?? null;
  }

  private async createCustom(value: GymEquipmentValue): Promise<string> {
    const name = value.name.trim();
    const count = await this.tx.equipmentType.count({ where: { ownerUserId: this.userId } });

    if (count >= MAX_CUSTOM_EQUIPMENT_TYPES_PER_USER) {
      throw refuse(
        400,
        GYM_REFUSALS.EQUIPMENT_TYPE_LIMIT,
        `You can have at most ${MAX_CUSTOM_EQUIPMENT_TYPES_PER_USER} custom equipment types`,
        { max: MAX_CUSTOM_EQUIPMENT_TYPES_PER_USER },
      );
    }

    const slugs = knownCapabilitySlugs(this.vocab, value.capabilitySlugs).slice(0, EQUIPMENT_TYPE_CAPABILITIES_MAX);
    const capabilities = slugs.length
      ? await this.tx.capability.findMany({ where: { slug: { in: slugs } }, select: { id: true, movementPattern: true } })
      : [];
    const category = capabilities.some((c) => c.movementPattern === CARDIO_PATTERN) ? 'cardio' : DEFAULT_CUSTOM_CATEGORY;

    const row = await this.tx.equipmentType.create({
      data: {
        slug: customSlug(),
        name,
        category,
        ownerUserId: this.userId,
        capabilities: { create: capabilities.map((c) => ({ capabilityId: c.id })) },
      },
      select: { id: true },
    });

    this.byName.set(name.toLowerCase(), row.id);

    return row.id;
  }
}
