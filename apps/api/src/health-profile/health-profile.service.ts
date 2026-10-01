import { ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, type HealthProfile as HealthProfileRow } from '@prisma/client';

import { emitHealthDataChanged } from '../measurements/health-data-events';
import { PrismaService } from '../prisma/prisma.service';
import {
  HEALTH_PROFILE_FIELDS,
  type HealthProfile,
  type HealthProfileField,
  type HealthProfileInput,
  type LabUnits,
  type SexAtBirth,
  type UnitSystem,
} from './dto/health-profile.dto';
import { formatDateOnly, parseDateOnly } from './health-profile.validation';

// =============================================================================
// HealthProfileService — one health profile per user (E2.1, #47)
// =============================================================================
//
// Every query is keyed by the caller's JWT user id; there is no route or
// method taking another user's id, so no code path can reach someone else's
// row.
//
// ⚠ NEVER LOG VALUES. Health data (date of birth, sex, height, time zone) and
// the free-text bio never reach a log line, an exception message or an audit
// row. The audit row names the fields that changed, nothing more.
// =============================================================================

export const HEALTH_PROFILE_AUDIT_ACTION = 'health_profile:update';
export const HEALTH_PROFILE_AUDIT_TARGET = 'health_profile';

/** What `GET` answers for a user who has never saved a profile. */
const EMPTY_PROFILE: HealthProfile = {
  dateOfBirth: null,
  sexAtBirth: null,
  heightMm: null,
  unitSystem: 'metric',
  timeZone: null,
  bio: null,
  labUnits: 'conventional',
  version: 0,
  updatedAt: null,
};

/** The profile fields the AI health summary's digest reads (H8, #192). */
const SUMMARY_PROFILE_FIELDS = ['dateOfBirth', 'sexAtBirth'] as const;

@Injectable()
export class HealthProfileService {
  private readonly logger = new Logger(HealthProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Optional so a hand-built service (tests) needs none; Nest always injects it.
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  /** The caller's profile, or the empty profile (`version: 0`) when none is stored. */
  async get(userId: string): Promise<HealthProfile> {
    const row = await this.prisma.healthProfile.findUnique({ where: { userId } });

    return row ? toProfile(row) : { ...EMPTY_PROFILE };
  }

  /**
   * The caller's IANA time zone, or null when unset. E2.4 uses it to decide
   * which calendar day a measurement belongs to.
   */
  async getTimeZone(userId: string): Promise<string | null> {
    const row = await this.prisma.healthProfile.findUnique({
      where: { userId },
      select: { timeZone: true },
    });

    return row?.timeZone ?? null;
  }

  /**
   * Full replace. `expectedVersion` (from `If-Match`) must equal the stored
   * version, or 0 when nothing is stored yet; otherwise 409.
   *
   * The version check is enforced by the WRITE, not only by the read before
   * it: an update is conditional on the version it read, and a concurrent
   * first save loses on the `user_id` unique index. Either way the loser gets
   * 409 rather than silently overwriting the winner.
   */
  async put(
    userId: string,
    input: HealthProfileInput,
    expectedVersion?: number,
  ): Promise<HealthProfile> {
    const data = toColumns(input);

    let previous: HealthProfile;
    let saved: HealthProfileRow;

    try {
      [previous, saved] = await this.prisma.$transaction(async (tx) => {
        const current = await tx.healthProfile.findUnique({ where: { userId } });
        const currentVersion = current?.version ?? 0;

        if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
          throw versionConflict(expectedVersion, currentVersion);
        }

        if (!current) {
          const created = await tx.healthProfile.create({
            data: { userId, ...data, version: 1 },
          });

          return [{ ...EMPTY_PROFILE }, created] as const;
        }

        const { count } = await tx.healthProfile.updateMany({
          where: { userId, version: current.version },
          data: { ...data, version: { increment: 1 } },
        });

        if (count === 0) {
          throw versionConflict(expectedVersion ?? current.version, null);
        }

        const updated = await tx.healthProfile.findUniqueOrThrow({ where: { userId } });

        return [toProfile(current), updated] as const;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // A concurrent first save created the row between our read and our
        // insert.
        throw versionConflict(expectedVersion ?? 0, null);
      }

      throw error;
    }

    const profile = toProfile(saved);
    const changed = changedFields(previous, profile);

    if (changed.length > 0) {
      await this.audit(userId, changed);
    }

    // Only the fields the AI health summary's digest reads (age, sex) matter to it.
    if (changed.some((field) => (SUMMARY_PROFILE_FIELDS as readonly string[]).includes(field))) {
      emitHealthDataChanged(this.events, this.logger, { userId, source: 'health_profile' });
    }

    return profile;
  }

  /** Best-effort: the save has committed, so an audit failure must not fail the request. */
  private async audit(userId: string, fields: HealthProfileField[]): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: userId,
          action: HEALTH_PROFILE_AUDIT_ACTION,
          targetType: HEALTH_PROFILE_AUDIT_TARGET,
          targetId: userId,
          meta: { fields } as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      // Field names only; never a value, never the bio.
      this.logger.error(
        `Could not audit ${HEALTH_PROFILE_AUDIT_ACTION} for user ${userId} ` +
          `(fields: ${fields.join(', ')}): ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

function versionConflict(expected: number, found: number | null): ConflictException {
  return new ConflictException(
    found === null
      ? `Health profile version mismatch. Expected ${expected}; the profile changed concurrently`
      : `Health profile version mismatch. Expected ${expected}, found ${found}`,
  );
}

function toColumns(input: HealthProfileInput) {
  return {
    dateOfBirth: input.dateOfBirth === null ? null : parseDateOnly(input.dateOfBirth),
    sexAtBirth: input.sexAtBirth,
    heightMm: input.heightMm,
    unitSystem: input.unitSystem,
    timeZone: input.timeZone,
    bio: input.bio,
    // Omitted = keep the stored preference (the column default on create).
    ...(input.labUnits !== undefined ? { labUnits: input.labUnits } : {}),
  };
}

function toProfile(row: HealthProfileRow): HealthProfile {
  return {
    dateOfBirth: row.dateOfBirth ? formatDateOnly(row.dateOfBirth) : null,
    sexAtBirth: row.sexAtBirth as SexAtBirth | null,
    heightMm: row.heightMm,
    unitSystem: row.unitSystem as UnitSystem,
    timeZone: row.timeZone,
    bio: row.bio,
    labUnits: row.labUnits === 'si' ? 'si' : ('conventional' satisfies LabUnits),
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Names of the stored fields whose value differs between two profiles. */
export function changedFields(
  before: HealthProfile,
  after: HealthProfile,
): HealthProfileField[] {
  return HEALTH_PROFILE_FIELDS.filter((field) => before[field] !== after[field]);
}
