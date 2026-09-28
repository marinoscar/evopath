import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { StorageObjectStatus, type Prisma } from '@prisma/client';

import { CredentialsService } from '../../credentials/credentials.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import type { SystemStorageValue } from '../../common/schemas/settings.schema';
import {
  STORAGE_CREDENTIAL_LABEL,
  STORAGE_CREDENTIAL_NAME,
  STORAGE_CREDENTIAL_PURPOSE,
} from '../storage-credential.constants';
import { resolveStorageConfig } from './storage-config';
import { StorageConfigService } from './storage-config.service';
import { displayEndpoint } from './storage-probe.support';
import type { StorageConfigResponse } from './dto/storage-config-response.dto';
import {
  STORAGE_SWITCH_CONFIRMATION,
  type UpdateStorageConfigInput,
} from './dto/update-storage-config.dto';

// =============================================================================
// StorageConfigAdminService — read and write the storage configuration (#375)
// =============================================================================
//
// The two halves of a storage configuration, joined for an ADMINISTRATOR rather
// than for a client that is about to move bytes:
//
//     system_settings.global -> `storage` namespace   (seven non-secret fields)
//   + credentials(storage, default)                   (masked, never decrypted)
//   -> what `GET /api/admin/storage-config` renders
//
// `StorageConfigService` is the other consumer of the same two halves, and the
// split is deliberate: THAT service exists to hand a plaintext secret to an S3
// client on a hot path and caches accordingly; THIS one exists to render a form
// and must never see the secret at all. Nothing in this file calls
// `CredentialsService.getSecret`; it calls `describe`, which returns
// `CredentialInfo`, a type with no field capable of carrying secret material.
// `test/settings/email-settings.integration.spec.ts` asserts the equivalent
// property for SMTP and `storage-config.integration.spec.ts` asserts it here.
//
// -----------------------------------------------------------------------------
// WHY THE WRITE GOES THROUGH `SystemSettingsService.patchSettings`
// -----------------------------------------------------------------------------
//
// Because `storage` is a NAMESPACE INSIDE the single `global` settings row, not
// a row of its own like `email` or `webPush`. That row also carries
// `notifications`, `jobs`, `nodes`, `databaseBackup`, `maintenance` and any key
// a fork has added and this build does not know about — and #130's whole
// argument is that a write which does not carry those forward silently destroys
// them. `patchSettings` already implements the namespace-by-namespace merge, the
// unknown-key preservation, the degrade-a-damaged-row rule and the `If-Match`
// check. A second, hand-rolled upsert here would be a second chance to get every
// one of those wrong, on the row that configures the whole deployment.
//
// ⚠ THE CONSEQUENCE, STATED PLAINLY: `version` IS THE VERSION OF THE WHOLE
// `global` ROW. An `If-Match` sent by this page can therefore lose to somebody
// saving an unrelated system setting. That is honest rather than over-broad —
// they really did both write the same row, and the loser's remedy (reload, look
// at what is there now, save again) is the right one. The alternative, a version
// scoped to the `storage` key, does not exist in the data model and inventing one
// would mean two writers to one row believing they had independent tokens.
//
// -----------------------------------------------------------------------------
// WHY A CREDENTIAL ROTATION IS NOT A `$transaction` WITH THE SETTINGS WRITE
// -----------------------------------------------------------------------------
//
// It cannot be: the settings row and the credential row are written by two
// services through two code paths, and `CredentialsService` deliberately owns
// its own encryption and its own upsert. So there is an ordering to choose, and
// unlike push/SMTP — where an orphaned credential is inert — NEITHER ORDER IS
// SAFE here, because the access key id lives in the settings half and its secret
// in the credential half. A half-applied save leaves a key id from one pair
// beside a secret from another, whichever way round it is done.
//
// What is available instead is making the FAILURE THAT ACTUALLY HAPPENS happen
// first. The realistic failure is not a crashed process; it is an `If-Match`
// conflict, and that one is knowable before anything is written. So the version
// is checked HERE, up front, before the credential is touched — and then again
// inside `patchSettings`, against the same row. Without the first check a losing
// racer would already have rotated the deployment's secret out from under the
// winner by the time it learned it had lost.
// =============================================================================

/**
 * A stand-in for the stored secret, used ONLY to ask `resolveStorageConfig`
 * whether a credential is present.
 *
 * ⚠ WHY THIS EXISTS AND WHY IT IS SAFE. `resolveStorageConfig` is the single
 * definition of "configured", and it needs the secret for exactly two things:
 * deciding whether `secretAccessKey` belongs in the missing-field list, and
 * copying it into the resolved config. This path needs the first answer and MUST
 * NOT obtain the second — an admin read has no business decrypting a credential
 * (see `CredentialsService.getSecret`'s contract, and `StorageConfigService`'s
 * startup warm, which declines the same read for the same reason).
 *
 * So presence is signalled with a value that is not the secret, and the resolved
 * `config` is discarded unread — only `configured` and `missing` are used. The
 * alternative was to re-derive "is the secret missing?" here, which is a second
 * copy of a rule that has exactly one definition today.
 *
 * REJECTED: `''`. It reads as "present but empty" to a human and as "absent" to
 * `resolveStorageConfig`, which is the kind of near-miss that survives review.
 */
const CREDENTIAL_PRESENCE_PROBE = '[credential present]';

/** What the switch gate counts, and reports in its 409. */
export interface StorageLocationUsage {
  /** Rows in `storage_objects` that still name the old location. */
  storageObjects: number;
  /** Rows in `database_backup_runs` that still name the old location. */
  databaseBackupRuns: number;
  /** Convenience: `storageObjects + databaseBackupRuns`. */
  total: number;
}

@Injectable()
export class StorageConfigAdminService {
  private readonly logger = new Logger(StorageConfigAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    // `describe` and `setSecret` ONLY. `getSecret` — the plaintext one — is
    // never called from this file. See the class header.
    private readonly credentials: CredentialsService,
    // For `invalidateCache()` after a write, and for nothing else. This service
    // does not resolve configurations; that is what the other one is for.
    private readonly storageConfig: StorageConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Everything `GET /api/admin/storage-config` renders.
   *
   * DOES NOT THROW ON A DAMAGED ROW, matching `PushConfigService
   * .describeForAdmin` and for the same reason: this is the repair path, and a
   * 500 here would take down the one screen capable of fixing the row.
   * `getStoragePolicy` already degrades field by field to
   * `DEFAULT_SYSTEM_SETTINGS.storage` — the unconfigured state — so a corrupt
   * `region` still renders the bucket an operator typed.
   */
  async describeForAdmin(): Promise<StorageConfigResponse> {
    const [policy, row, secretInfo] = await Promise.all([
      // `fresh` is irrelevant here — `getStoragePolicy` is the uncached
      // accessor — but the row read below is what carries `version`, and the
      // two must describe the same write. See `readRow`.
      this.systemSettings.getStoragePolicy(),
      this.readRow(),
      this.credentials.describe(STORAGE_CREDENTIAL_PURPOSE, STORAGE_CREDENTIAL_NAME),
    ]);

    return this.toResponse(policy, row, secretInfo);
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  /**
   * `PUT /api/admin/storage-config` — full replace of the seven settings fields,
   * plus an optional secret rotation.
   *
   * Order of operations, and every step is load-bearing:
   *
   *   1. Read the current row. One read, used for the version check, the switch
   *      gate and nothing else — so the version that is checked and the location
   *      that is compared can never come from two different reads.
   *   2. `If-Match`. Refuse BEFORE anything is written. See the class header for
   *      why this check exists here as well as inside `patchSettings`.
   *   3. The switch gate. A `409` naming the row counts, unless the body carries
   *      the typed confirmation.
   *   4. The credential, if the body carried one. Blank preserves.
   *   5. The settings namespace, through `patchSettings`.
   *   6. ⚠ `invalidateCache()`, SYNCHRONOUSLY, before the audit write.
   *   7. The audit row.
   *
   * Step 6's placement is the same rule `MaintenanceModeService.setMaintenance`
   * follows, for the same reason: between the settings write committing and that
   * call, this instance would still answer storage questions from a value it
   * read up to five seconds ago, and an administrator who saved a corrected
   * bucket and immediately retried an upload would watch it fail against the old
   * one. Anything that awaits in between — an audit row, a notification, a log
   * flush — widens that window for no benefit.
   */
  async replace(
    input: UpdateStorageConfigInput,
    userId: string,
    expectedVersion?: number,
  ): Promise<StorageConfigResponse> {
    const row = await this.readRow();
    const current = await this.systemSettings.getStoragePolicy();
    const currentVersion = row?.version ?? 0;

    if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
      throw new ConflictException(
        `Storage settings version mismatch. Expected ${expectedVersion}, found ${currentVersion}`,
      );
    }

    const next: SystemStorageValue = {
      provider: input.provider,
      bucket: input.bucket,
      region: input.region,
      endpoint: input.endpoint,
      accountId: input.accountId,
      accessKeyId: input.accessKeyId,
      forcePathStyle: input.forcePathStyle,
    };

    await this.assertSwitchAcknowledged(current, next, input.confirmation);

    // BLANK PRESERVES, and the check is here rather than left to `setSecret`
    // because `setSecret` raises a 400 when a blank secret is written to an
    // address that does not exist yet — which is precisely the first save of a
    // half-filled form, the one case that must not be an error. Not calling it
    // at all is the same outcome ("leave the stored secret alone") without the
    // exception, and it keeps a no-op write off the credential row entirely.
    const rotatesSecret = Boolean(input.secretAccessKey);

    if (rotatesSecret) {
      await this.credentials.setSecret(
        STORAGE_CREDENTIAL_PURPOSE,
        STORAGE_CREDENTIAL_NAME,
        input.secretAccessKey,
        { label: STORAGE_CREDENTIAL_LABEL, updatedByUserId: userId },
      );
    }

    // The whole `storage` namespace, every field, so this really is a replace.
    // `patchSettings` merges namespace by namespace, so the seven fields here
    // replace the seven stored ones and every OTHER namespace — and every
    // unknown key a fork has put in this row — is carried forward untouched.
    await this.systemSettings.patchSettings(
      { storage: next },
      userId,
      // Re-checked against the same row, closing the window between step 2 and
      // here. The first check is what keeps a loser from having already rotated
      // the credential; this one is what actually serialises the writers.
      expectedVersion,
    );

    // ⚠ SYNCHRONOUS, AND BEFORE THE AUDIT WRITE. See this method's header.
    this.storageConfig.invalidateCache();

    await this.audit(userId, 'storage_config:replace', {
      settings: next,
      secretRotated: rotatesSecret,
      switchConfirmed: input.confirmation === STORAGE_SWITCH_CONFIRMATION,
    });

    this.logger.log(
      `Storage configuration replaced by user ${userId} ` +
        `(provider=${next.provider} bucket=${next.bucket || '(none)'} ` +
        `secretRotated=${rotatesSecret})`,
    );

    return this.describeForAdmin();
  }

  // ---------------------------------------------------------------------------
  // The switch gate
  // ---------------------------------------------------------------------------

  /**
   * Refuse a save that repoints a deployment whose rows still name the old
   * location, unless the caller typed the word.
   *
   * ── WHAT COUNTS AS A SWITCH ────────────────────────────────────────────────
   *
   * `provider`, `bucket`, or the EFFECTIVE endpoint. Effective rather than the
   * raw `endpoint` field on purpose: an R2 deployment stores an empty `endpoint`
   * and derives its host from `accountId`, so comparing the raw field would let
   * "move to a different Cloudflare account" — which is every bit a relocation —
   * through without a word. `region`, `accessKeyId` and `forcePathStyle` are NOT
   * a switch: they change how the same bytes are reached, not where they are.
   *
   * ── WHY IT IS A `409` AND NOT A SILENT SUCCESS ─────────────────────────────
   *
   * Because SAVING A NEW LOCATION DOES NOT COPY A SINGLE OBJECT, and there is no
   * other moment at which anybody is told. Every `storage_objects` row keeps its
   * `storage_key`, every avatar keeps its URL, every `database_backup_runs` row
   * keeps the archive it points at — and all of them now address a bucket this
   * deployment no longer talks to. Downloads 404, backups become unrestorable,
   * and nothing in the application logs an error, because nothing is broken from
   * the object store's point of view: it simply does not have those keys.
   *
   * The counts are IN the error because "are you sure?" is not a question anyone
   * can answer. "1,284 objects and 30 backups still point at `old-bucket`" is.
   *
   * ── WHY THERE IS NO MIGRATION BEHIND THIS BUTTON ───────────────────────────
   *
   * ⚠ REJECTED, and worth naming so it is not proposed as an obvious follow-up:
   * copying the objects as part of the save. A bucket-to-bucket copy of an
   * unbounded amount of data is, by this repository's own MANDATORY rule, a
   * queue job — not something an HTTP request does. It would also have to be
   * resumable, it would have to reconcile keys that exist in both places, and it
   * would have to decide what happens to uploads that arrive while it runs. That
   * is a feature, not a clause in a settings save, and pretending otherwise is
   * how a "helpful" save becomes a half-copied bucket.
   *
   * ── WHY IT DOES NOT FIRE ON A FIRST CONFIGURATION ──────────────────────────
   *
   * An unconfigured deployment has no old location — `current.bucket` is `''` —
   * so nothing can be stranded, and a confirmation dialog on the very first save
   * is a dialog nobody reads. The gate is likewise silent when the counts are
   * zero: there is nothing to strand.
   */
  private async assertSwitchAcknowledged(
    current: SystemStorageValue,
    next: SystemStorageValue,
    confirmation: string | undefined,
  ): Promise<void> {
    if (confirmation === STORAGE_SWITCH_CONFIRMATION) return;

    // Nothing was ever configured, so nothing can be stranded.
    if (!current.bucket) return;

    const relocated =
      current.provider !== next.provider ||
      current.bucket !== next.bucket ||
      displayEndpoint(current) !== displayEndpoint(next);

    if (!relocated) return;

    const usage = await this.countLocationUsage(current);

    if (usage.total === 0) return;

    throw new ConflictException({
      code: 'STORAGE_LOCATION_IN_USE',
      message:
        `${usage.storageObjects} stored object(s) and ${usage.databaseBackupRuns} database ` +
        `backup(s) still point at ${describeLocation(current)}. Changing the provider, ` +
        `bucket or endpoint does NOT copy them — they will remain where they are and this ` +
        `deployment will no longer be able to read them. Re-send with ` +
        `{"confirmation":"${STORAGE_SWITCH_CONFIRMATION}"} to save anyway.`,
      details: {
        confirmation: STORAGE_SWITCH_CONFIRMATION,
        from: {
          provider: current.provider,
          bucket: current.bucket,
          endpoint: displayEndpoint(current),
        },
        to: {
          provider: next.provider,
          bucket: next.bucket,
          endpoint: displayEndpoint(next),
        },
        storageObjects: usage.storageObjects,
        databaseBackupRuns: usage.databaseBackupRuns,
      },
    });
  }

  /**
   * How many rows still name `location`.
   *
   * ── WHAT IS COUNTED, AND WHY EACH EXCLUSION IS DELIBERATE ──────────────────
   *
   * `storage_objects`: everything except `failed`. A `failed` row is an upload
   * that never completed; there are no bytes at the old location to lose, and
   * counting them would mean a deployment with a pile of old failures could
   * never change buckets without a confirmation it does not need.
   * `pending`/`uploading`/`processing` ARE counted — a multipart upload in
   * flight is pointed at the old bucket and will break mid-transfer.
   *
   * `database_backup_runs`: `pending`, `running` and `completed`. `failed` and
   * `stale` runs are not offered for restore anywhere, so their archives (if any
   * exist at all) are not something a switch can strand.
   *
   * ── WHY `bucket: null` COUNTS AS THE OLD LOCATION ──────────────────────────
   *
   * `storage_objects.bucket` is nullable and rows written before that column
   * existed carry `null`. Those objects are in whatever bucket this deployment
   * was using at the time — which is, by definition, the current one. Treating
   * them as "somewhere else" would make the gate silent for exactly the oldest
   * and least replaceable data in the deployment. `database_backup_runs.bucket`
   * is non-nullable, so it needs no such clause.
   */
  async countLocationUsage(location: SystemStorageValue): Promise<StorageLocationUsage> {
    const [storageObjects, databaseBackupRuns] = await Promise.all([
      this.prisma.storageObject.count({
        where: {
          storageProvider: location.provider,
          OR: [{ bucket: location.bucket }, { bucket: null }],
          status: { not: StorageObjectStatus.failed },
        },
      }),
      this.prisma.databaseBackupRun.count({
        where: {
          storageProvider: location.provider,
          bucket: location.bucket,
          status: { in: ['pending', 'running', 'completed'] },
        },
      }),
    ]);

    return {
      storageObjects,
      databaseBackupRuns,
      total: storageObjects + databaseBackupRuns,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * The `global` settings row's provenance columns, or `null` when it has never
   * been written.
   *
   * ⚠ DELIBERATELY `findUnique`, NOT `SystemSettingsService.getSettings()`,
   * which goes through `loadOrCreateRow` and INSERTS when the row is missing.
   * A read must not materialise a settings row as a side effect of rendering a
   * page — the same rule `getStoragePolicy` and `getNotificationsPolicy` already
   * follow, and the same reason: a fresh install should be able to LOOK at its
   * storage configuration without being written to.
   */
  private async readRow() {
    return this.prisma.systemSettings.findUnique({
      where: { key: 'global' },
      select: {
        version: true,
        updatedAt: true,
        updatedByUser: { select: { id: true, email: true } },
      },
    });
  }

  /** Assemble the admin view. Shared by the read and every write. */
  private toResponse(
    policy: SystemStorageValue,
    row: {
      version: number;
      updatedAt: Date;
      updatedByUser: { id: string; email: string } | null;
    } | null,
    secretInfo: { hint: string | null; updatedAt: Date; updatedByUserId: string | null } | null,
  ): StorageConfigResponse {
    // ⚠ The resolved `config` is DISCARDED UNREAD — only the verdict is used.
    // See CREDENTIAL_PRESENCE_PROBE for why a stand-in is passed in place of the
    // secret, and why this file never decrypts one.
    const resolution = resolveStorageConfig(
      policy,
      secretInfo ? CREDENTIAL_PRESENCE_PROBE : null,
    );

    return {
      ...policy,
      effectiveEndpoint: resolution.configured
        ? (resolution.config.endpoint ?? null)
        : displayEndpoint(policy),
      configured: resolution.configured,
      missing: resolution.configured ? [] : resolution.missing,
      secretStatus: {
        configured: secretInfo !== null,
        hint: secretInfo?.hint ?? null,
        updatedAt: secretInfo?.updatedAt.toISOString() ?? null,
        updatedByUserId: secretInfo?.updatedByUserId ?? null,
      },
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedByUser ?? null,
    };
  }

  /**
   * Record the change.
   *
   * `targetId` is the settings KEY rather than the row id: a first save on a
   * fresh install can audit before anyone has read the row back, and `targetId`
   * is non-nullable. `EmailTestSendService.audit` makes the same choice for the
   * same reason.
   *
   * SAFE TO RECORD IN FULL: `meta.settings` is a `SystemStorageValue`, which
   * carries a compile-time proof (in `settings.schema.ts`) that it has no
   * secret-bearing field. `secretRotated` is a boolean about the secret, never
   * the secret — that distinction is the whole reason it is a boolean.
   */
  private async audit(
    userId: string,
    action: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action,
        targetType: 'system_settings',
        targetId: 'storage',
        meta: meta as unknown as Prisma.InputJsonValue,
      },
    });
  }
}

/** `r2 bucket "media" (acct.r2.cloudflarestorage.com)`, for an error message. */
function describeLocation(policy: SystemStorageValue): string {
  const endpoint = displayEndpoint(policy);

  return (
    `${policy.provider} bucket "${policy.bucket}"` +
    (endpoint ? ` (${endpoint})` : '')
  );
}
