import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import {
  decryptSecret,
  encryptSecret,
  userCredentialPurpose,
} from '../common/crypto/secret-cipher';
import {
  assertCredentialAddress,
  assertCredentialOwner,
  assertCredentialPurpose,
  deriveHint,
  isBlankSecret,
} from '../credentials/credential-internals';
import { PrismaService } from '../prisma/prisma.service';
import type {
  UserCredentialInfo,
  UserCredentialMeta,
} from './interfaces/user-credential-info.interface';

// =============================================================================
// UserCredentialsService — a user's OWN encrypted credentials (issue #387)
// =============================================================================
//
// The per-user sibling of `CredentialsService`. That store holds secrets the
// DEPLOYMENT owns, addressed by `(purpose, name)`; this one holds secrets a
// USER owns (bring-your-own-key), addressed by `(userId, purpose, name)`, in
// its own `user_credentials` table. `credentials` is untouched.
//
// `userId` IS THE FIRST PARAMETER OF EVERY METHOD, and every query is scoped
// by it. There is no id-addressed read and no cross-user listing, so no code
// path here can reach another user's row.
//
// THE SAME TWO INVARIANTS AS `CredentialsService` — read its header:
//
//   1. NO PLAINTEXT EGRESS. `getSecret` (plaintext, server-side only) and
//      `describe`/`list` (`UserCredentialInfo`, which has no field able to
//      carry a secret) are different methods returning different types.
//      Nothing here interpolates a secret into a log line or an error.
//
//   2. BLANK PRESERVES. A blank secret on write keeps the stored ciphertext;
//      erasing is `deleteSecret`. A blank secret with nothing stored is a 400.
//
// PLUS ONE THE SYSTEM STORE DOES NOT NEED — AN OWNER-BOUND CIPHER DOMAIN. A
// row is encrypted under `user:<userId>:<purpose>` (`userCredentialPurpose`),
// not `<purpose>`. The table's address alone would let a SQL write (or a bug
// copying rows) move user A's ciphertext into user B's row, and B's reads
// would then decrypt A's key; binding the owner into the sub-key makes that
// row fail GCM authentication instead. Hint derivation, blank detection and
// address validation are the SAME functions `CredentialsService` uses
// (`credentials/credential-internals.ts`), not copies.
//
// NO AUDIT EVENTS, mirroring `CredentialsService`, which writes none: this is
// a store, not a feature surface. The feature that exposes it (with its own
// actor and request context) audits the act; this layer logs the address.
//
// NO CONTROLLER, ON PURPOSE — the same reasoning as `CredentialsModule`.
// =============================================================================

/**
 * Columns making up a `UserCredentialInfo`, as a Prisma `select`. Typed as
 * `Record<keyof UserCredentialInfo, true>` so adding `secret: true` here fails
 * to compile (excess property), and the ciphertext never leaves Postgres on a
 * presentation read.
 */
const USER_CREDENTIAL_INFO_SELECT: Record<keyof UserCredentialInfo, true> = {
  purpose: true,
  name: true,
  hint: true,
  label: true,
  createdAt: true,
  updatedAt: true,
};

@Injectable()
export class UserCredentialsService {
  private readonly logger = new Logger(UserCredentialsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * SERVER-SIDE ONLY. RETURNS PLAINTEXT. NEVER CALL THIS FROM A CONTROLLER.
   *
   * The only method in this store that yields a decrypted value. Use it at the
   * moment of use and let it go out of scope. For anything a user will see,
   * use {@link describe} or {@link list}.
   *
   * @returns the plaintext, or `null` if this user has no credential here.
   * @throws InternalServerErrorException if the row exists but will not
   *         decrypt — a changed key, a tampered row, or a row that was moved
   *         from another user (the owner-bound sub-key rejects it). Never
   *         reported as "not configured": that would silently fall back to a
   *         deployment key and hide the fault.
   */
  async getSecret(
    userId: string,
    purpose: string,
    name: string,
  ): Promise<string | null> {
    this.assertAddress(userId, purpose, name);

    const row = await this.prisma.userCredential.findUnique({
      where: { userId_purpose_name: { userId, purpose, name } },
      select: { secret: true },
    });

    if (!row) {
      return null;
    }

    try {
      return decryptSecret(row.secret, userCredentialPurpose(userId, purpose));
    } catch {
      // The original error is swallowed rather than chained, exactly as in
      // `CredentialsService.getSecret` — see the reasoning there. The log line
      // names the owner (an id, not a secret); the thrown message, which may
      // reach a response body, names only the address the caller asked for.
      this.logger.error(
        `Failed to decrypt user credential "${purpose}/${name}" for user ${userId}: the payload is corrupt, belongs to another owner, or SECRETS_ENCRYPTION_KEY has changed. The credential must be re-entered.`,
      );

      throw new InternalServerErrorException(
        `Credential "${purpose}/${name}" could not be decrypted. It must be set again.`,
      );
    }
  }

  /**
   * Presentation read for one of this user's credentials. Safe to serialise;
   * the ciphertext is not even fetched.
   *
   * @returns the info, or `null` if nothing is stored at this address.
   */
  async describe(
    userId: string,
    purpose: string,
    name: string,
  ): Promise<UserCredentialInfo | null> {
    this.assertAddress(userId, purpose, name);

    const row = await this.prisma.userCredential.findUnique({
      where: { userId_purpose_name: { userId, purpose, name } },
      select: USER_CREDENTIAL_INFO_SELECT,
    });

    return row ? this.toInfo(row) : null;
  }

  /**
   * Presentation read for this user's credentials — all of them, or only
   * those under `purpose` — ordered by purpose then name so a list is stable.
   *
   * Unlike the system store, `purpose` is optional: the scope that matters
   * here is the OWNER, and "every key I have stored" is a legitimate thing
   * for a user to ask about themselves. There is still no cross-user listing.
   */
  async list(userId: string, purpose?: string): Promise<UserCredentialInfo[]> {
    assertCredentialOwner(userId);
    if (purpose !== undefined) {
      assertCredentialPurpose(purpose);
    }

    const rows = await this.prisma.userCredential.findMany({
      where: purpose === undefined ? { userId } : { userId, purpose },
      select: USER_CREDENTIAL_INFO_SELECT,
      orderBy: [{ purpose: 'asc' }, { name: 'asc' }],
    });

    return rows.map((row) => this.toInfo(row));
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Create or update this user's credential at `(purpose, name)`.
   *
   * BLANK PRESERVES: `undefined`, `null` or `''` for `secret` keeps the stored
   * ciphertext and hint and applies only `meta`. `hint` is derived here from
   * the plaintext; callers do not supply it.
   *
   * @throws BadRequestException on a blank secret with nothing stored yet.
   */
  async setSecret(
    userId: string,
    purpose: string,
    name: string,
    secret: string | null | undefined,
    meta: UserCredentialMeta = {},
  ): Promise<void> {
    this.assertAddress(userId, purpose, name);

    // Only the metadata keys the caller actually passed — `undefined` means
    // "leave it", `null` means "clear it".
    const metaUpdate: Prisma.UserCredentialUpdateInput = {};
    if (meta.label !== undefined) metaUpdate.label = meta.label;

    if (isBlankSecret(secret)) {
      await this.applyMetadataOnly(userId, purpose, name, metaUpdate);
      return;
    }

    const encrypted = encryptSecret(secret, userCredentialPurpose(userId, purpose));
    const hint = deriveHint(secret);

    await this.prisma.userCredential.upsert({
      where: { userId_purpose_name: { userId, purpose, name } },
      create: {
        user: { connect: { id: userId } },
        purpose,
        name,
        secret: encrypted,
        hint,
        label: meta.label ?? null,
      },
      update: {
        secret: encrypted,
        hint,
        ...metaUpdate,
      },
    });

    // Address only — never `secret`, `encrypted` or `hint`.
    this.logger.log(`Stored user credential "${purpose}/${name}" for user ${userId}`);
  }

  /**
   * Remove this user's credential at `(purpose, name)`. The ONLY way to erase
   * one. Idempotent: deleting an absent credential is a no-op.
   */
  async deleteSecret(userId: string, purpose: string, name: string): Promise<void> {
    this.assertAddress(userId, purpose, name);

    const { count } = await this.prisma.userCredential.deleteMany({
      where: { userId, purpose, name },
    });

    if (count > 0) {
      this.logger.log(`Deleted user credential "${purpose}/${name}" for user ${userId}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * The blank-secret branch of {@link setSecret}. The first-write case (blank
   * secret, no row) is an error for exactly the reasons given in
   * `CredentialsService.applyMetadataOnly`.
   */
  private async applyMetadataOnly(
    userId: string,
    purpose: string,
    name: string,
    metaUpdate: Prisma.UserCredentialUpdateInput,
  ): Promise<void> {
    const existing = await this.prisma.userCredential.findUnique({
      where: { userId_purpose_name: { userId, purpose, name } },
      select: { id: true },
    });

    if (!existing) {
      throw new BadRequestException(
        `Cannot create credential "${purpose}/${name}" without a secret. A blank value preserves an existing secret, but there is none stored at this address yet.`,
      );
    }

    // A blank secret and no metadata: leave the row, and `updatedAt`, alone.
    if (Object.keys(metaUpdate).length === 0) {
      return;
    }

    await this.prisma.userCredential.update({
      // `existing.id` came from a lookup scoped by this owner, so updating by
      // id here cannot reach another user's row.
      where: { id: existing.id },
      data: metaUpdate,
    });

    this.logger.log(
      `Updated metadata for user credential "${purpose}/${name}" for user ${userId} (secret preserved)`,
    );
  }

  /** Build a `UserCredentialInfo` field by field — never by spreading a row. */
  private toInfo(row: UserCredentialInfo): UserCredentialInfo {
    return {
      purpose: row.purpose,
      name: row.name,
      hint: row.hint,
      label: row.label,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private assertAddress(userId: string, purpose: string, name: string): void {
    assertCredentialOwner(userId);
    assertCredentialAddress(purpose, name);
  }
}
