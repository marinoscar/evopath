import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { PatService } from '../pat/pat.service';
import { DeviceCodeStatus, Prisma } from '@prisma/client';
import { DeviceTokenType } from './dto/device-code-request.dto';
import { DeviceTokenResponseDto } from './dto/device-token-response.dto';
// Every failure of the token endpoint goes through this factory, never through
// a bare `new BadRequestException({ error: … })`. Thrown directly, that body is
// flattened by the global exception filter into a generic 400 and the RFC code
// is destroyed — which is exactly what #153 was. The factory brands the
// exception so the filter sends `{ error, error_description }` verbatim.
import { deviceTokenError } from './exceptions/device-token-error.exception';

/**
 * Service for handling Device Authorization Flow (RFC 8628)
 */
@Injectable()
export class DeviceAuthService {
  private readonly logger = new Logger(DeviceAuthService.name);

  // Characters for user code generation (unambiguous)
  private readonly USER_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  // Tracking last poll times for rate limiting
  private readonly pollTimestamps = new Map<string, number>();

  // Prefix stamped onto every token this flow mints, so a row in the web UI's
  // Access Tokens list is immediately identifiable as device-flow-issued
  // rather than hand-created (#141). Kept in one constant because it is
  // budgeted against PAT_NAME_MAX_LENGTH below.
  private readonly PAT_NAME_PREFIX = 'Device: ';

  // `createPatSchema` caps a PAT name at 100 characters. We call PatService
  // DIRECTLY here, so that zod schema never runs on our input and cannot
  // protect us — an over-long `deviceName` would reach Postgres unchecked.
  // Enforcing the same ceiling ourselves keeps device-issued tokens
  // indistinguishable from UI-created ones as far as the column is concerned.
  private readonly PAT_NAME_MAX_LENGTH = 100;

  // Shown when `deviceName` is missing, not a string, or sanitises away to
  // nothing. Never leave the name empty: `createPatSchema` requires min(1), and
  // more importantly an unlabelled row in the Access Tokens page is a token a
  // user cannot confidently revoke.
  private readonly PAT_NAME_FALLBACK = 'Unnamed device';

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    // PatModule is @Global and registered in AppModule, so this resolves
    // without DeviceAuthModule importing it — the same way JwtAuthGuard already
    // depends on PatService. Importing it here as well would be harmless but
    // redundant.
    private readonly patService: PatService,
  ) {}

  /**
   * Generate a new device code pair
   */
  async generateDeviceCode(clientInfo?: Record<string, any>) {
    const expiryMinutes = this.configService.get<number>(
      'deviceAuth.expiryMinutes',
      15,
    );
    const pollInterval = this.configService.get<number>(
      'deviceAuth.pollInterval',
      5,
    );
    const appUrl = this.configService.get<string>('appUrl');

    // Generate device code (secure random string)
    const deviceCode = randomBytes(32).toString('hex');
    const deviceCodeHash = this.hashToken(deviceCode);

    // Generate user code (human-readable)
    const userCode = this.generateUserCode();

    // Calculate expiration
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + expiryMinutes);

    // Store in database
    await this.prisma.deviceCode.create({
      data: {
        deviceCode: deviceCodeHash,
        userCode,
        status: DeviceCodeStatus.pending,
        clientInfo: clientInfo || {},
        scopes: [], // Future extension for scoped permissions
        expiresAt,
      },
    });

    this.logger.log(`Generated device code with user code: ${userCode}`);

    // Build response
    const verificationUri = `${appUrl}/activate`;
    const verificationUriComplete = `${verificationUri}?code=${userCode}`;

    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete,
      expiresIn: expiryMinutes * 60, // Convert to seconds
      interval: pollInterval,
    };
  }

  /**
   * Poll for device authorization status
   */
  async pollForToken(deviceCode: string) {
    const deviceCodeHash = this.hashToken(deviceCode);
    const pollInterval = this.configService.get<number>(
      'deviceAuth.pollInterval',
      5,
    );

    // Check rate limiting
    const lastPoll = this.pollTimestamps.get(deviceCodeHash);
    const now = Date.now();

    if (lastPoll && now - lastPoll < pollInterval * 1000) {
      throw deviceTokenError(
        'slow_down',
        'Polling too frequently. Please slow down.',
      );
    }

    // Update last poll timestamp
    this.pollTimestamps.set(deviceCodeHash, now);

    // Find device code
    const record = await this.prisma.deviceCode.findUnique({
      where: { deviceCode: deviceCodeHash },
      include: {
        user: {
          include: {
            userRoles: {
              include: {
                role: true,
              },
            },
          },
        },
      },
    });

    if (!record) {
      throw deviceTokenError('invalid_grant', 'Invalid device code');
    }

    // Check if expired
    if (record.expiresAt < new Date()) {
      await this.prisma.deviceCode.update({
        where: { id: record.id },
        data: { status: DeviceCodeStatus.expired },
      });

      throw deviceTokenError('expired_token', 'The device code has expired');
    }

    // Check status
    switch (record.status) {
      case DeviceCodeStatus.pending:
        throw deviceTokenError(
          'authorization_pending',
          'User has not yet authorized this device',
        );

      case DeviceCodeStatus.denied:
        throw deviceTokenError(
          'access_denied',
          'User denied the authorization request',
        );

      case DeviceCodeStatus.expired:
        throw deviceTokenError('expired_token', 'The device code has expired');

      case DeviceCodeStatus.approved: {
        if (!record.user) {
          throw deviceTokenError(
            'invalid_grant',
            'User information not found',
          );
        }

        // A device that asked for a PAT gets one MINTED RIGHT HERE, at poll
        // time — not at approval time. See issuePatCredential() for why that
        // ordering is the security-relevant part of #141.
        if (this.readTokenType(record.clientInfo) === 'pat') {
          return await this.issuePatCredential(
            record.id,
            record.user.id,
            record.user.email,
            record.clientInfo,
            deviceCodeHash,
          );
        }

        // ------------------------------------------------------------------
        // Session path. The response shape is unchanged from before #141 and
        // #518; what #518 changed is that the credential is now TIED to this
        // device code, so revoking the device session reaches it:
        //   - the access token carries a `did` claim that
        //     `AuthService.validateJwtPayload` re-checks on every request;
        //   - the refresh token row carries `deviceCodeId`, which revocation
        //     revokes and rotation carries forward.
        // ------------------------------------------------------------------
        const tokenExpiryDays = this.configService.get<number>(
          'deviceAuth.tokenExpiryDays',
          7,
        );
        const collectedAt = new Date();
        const credentialExpiresAt = new Date(
          collectedAt.getTime() + tokenExpiryDays * 24 * 60 * 60 * 1000,
        );

        // Claim the code atomically BEFORE minting, exactly as the PAT path
        // does. This is also where the session is recorded as collected, so a
        // `did`-bearing token can never exist for a row that
        // `validateJwtPayload` would not recognise as live. If minting then
        // fails the device must re-authorize: failing closed, as below.
        const claim = await this.prisma.deviceCode.updateMany({
          where: {
            id: record.id,
            status: DeviceCodeStatus.approved,
            revokedAt: null,
          },
          data: {
            status: DeviceCodeStatus.expired,
            collectedAt,
            credentialExpiresAt,
          },
        });

        if (claim.count !== 1) {
          throw deviceTokenError(
            'invalid_grant',
            'This device code has already been used',
          );
        }

        const tokens = await this.authService.generateFullTokens(record.user, {
          accessTtlMinutes: tokenExpiryDays * 24 * 60,
          refreshTtlDays: tokenExpiryDays,
          deviceCodeId: record.id,
        });

        // Clean up poll timestamp
        this.pollTimestamps.delete(deviceCodeHash);

        this.logger.log(
          `Device authorized successfully for user: ${record.user.email}`,
        );

        return {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken!,
          tokenType: 'Bearer',
          expiresIn: tokens.expiresIn,
        };
      }

      default:
        throw deviceTokenError(
          'invalid_request',
          'Unknown device code status',
        );
    }
  }

  /**
   * Get activation info for the frontend
   */
  async getActivationInfo(userCode?: string) {
    const appUrl = this.configService.get<string>('appUrl');
    const verificationUri = `${appUrl}/activate`;

    if (!userCode) {
      return { verificationUri };
    }

    // Normalize user code
    const normalizedCode = userCode.toUpperCase().replace(/\s/g, '');

    // Find device code by user code
    const record = await this.prisma.deviceCode.findUnique({
      where: { userCode: normalizedCode },
    });

    if (!record) {
      throw new NotFoundException('Invalid user code');
    }

    // Check if expired
    if (record.expiresAt < new Date()) {
      throw new BadRequestException('This code has expired');
    }

    // Check if already processed
    if (
      record.status === DeviceCodeStatus.approved ||
      record.status === DeviceCodeStatus.denied
    ) {
      throw new BadRequestException('This code has already been processed');
    }

    return {
      verificationUri,
      userCode: record.userCode,
      clientInfo: record.clientInfo as Record<string, any> | undefined,
      expiresAt: record.expiresAt.toISOString(),
    };
  }

  /**
   * Authorize or deny a device
   */
  async authorizeDevice(userId: string, userCode: string, approve: boolean) {
    // Normalize user code
    const normalizedCode = userCode.toUpperCase().replace(/\s/g, '');

    // Find device code
    const record = await this.prisma.deviceCode.findUnique({
      where: { userCode: normalizedCode },
    });

    if (!record) {
      throw new NotFoundException('Invalid user code');
    }

    // Check if expired
    if (record.expiresAt < new Date()) {
      throw new BadRequestException('This code has expired');
    }

    // Check if already processed
    if (
      record.status === DeviceCodeStatus.approved ||
      record.status === DeviceCodeStatus.denied
    ) {
      throw new BadRequestException('This code has already been processed');
    }

    // Update status
    const newStatus = approve
      ? DeviceCodeStatus.approved
      : DeviceCodeStatus.denied;

    await this.prisma.deviceCode.update({
      where: { id: record.id },
      data: {
        status: newStatus,
        userId: approve ? userId : null,
      },
    });

    const action = approve ? 'approved' : 'denied';
    this.logger.log(
      `Device ${action} by user ${userId} with code: ${normalizedCode}`,
    );

    return {
      success: true,
      message: approve
        ? 'Device authorized successfully'
        : 'Device authorization denied',
    };
  }

  /**
   * Get the user's live device sessions (issue #518): approved requests the
   * device has not collected yet, plus collected sessions whose credential has
   * not expired. Revoked sessions are never listed.
   */
  async getUserDeviceSessions(
    userId: string,
    page: number = 1,
    limit: number = 10,
  ) {
    const skip = (page - 1) * limit;
    const where: Prisma.DeviceCodeWhereInput = {
      userId,
      revokedAt: null,
      OR: [
        // Approved, waiting for the device to poll.
        { status: DeviceCodeStatus.approved, collectedAt: null },
        // Collected, and the credential it received is still valid.
        {
          collectedAt: { not: null },
          credentialExpiresAt: { gt: new Date() },
        },
      ],
    };

    const [sessions, total] = await Promise.all([
      this.prisma.deviceCode.findMany({
        where,
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take: limit,
      }),
      this.prisma.deviceCode.count({ where }),
    ]);

    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        userCode: session.userCode,
        status: session.status,
        clientInfo: session.clientInfo as Record<string, any> | undefined,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        collectedAt: session.collectedAt?.toISOString() ?? null,
        credentialExpiresAt: session.credentialExpiresAt?.toISOString() ?? null,
        // What the device collected: decided by the same `clientInfo` read the
        // token endpoint used, so it stays right even if the PAT row is gone.
        credentialType: session.collectedAt
          ? this.readTokenType(session.clientInfo)
          : null,
      })),
      total,
      page,
      limit,
    };
  }

  /**
   * Revoke a device session (issue #518).
   *
   * Revokes the session AND whatever credential it issued, in one transaction:
   *   - an uncollected request is also denied, so the device's next poll gets
   *     `access_denied`;
   *   - a collected PAT is revoked (conditionally, so a PAT the user already
   *     revoked on the Access Tokens page is not an error);
   *   - every live refresh token minted from this session is revoked, and the
   *     access token's `did` claim stops validating the moment `revokedAt` is
   *     set (see `AuthService.validateJwtPayload`).
   * Repeating the call is harmless: nothing live remains to revoke.
   */
  async revokeDeviceSession(userId: string, sessionId: string) {
    const session = await this.prisma.deviceCode.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    // Verify ownership
    if (session.userId !== userId) {
      throw new NotFoundException('Session not found');
    }

    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.deviceCode.update({
        where: { id: sessionId },
        data: {
          revokedAt: session.revokedAt ?? now,
          ...(session.collectedAt === null
            ? { status: DeviceCodeStatus.denied }
            : {}),
        },
      });

      if (session.patId) {
        // NOT PatService.revokeToken: that 404s on an already-revoked PAT,
        // which would fail this whole revocation for no reason.
        await tx.personalAccessToken.updateMany({
          where: { id: session.patId, userId, revokedAt: null },
          data: { revokedAt: now },
        });
      }

      await tx.refreshToken.updateMany({
        where: { deviceCodeId: sessionId, revokedAt: null },
        data: { revokedAt: now },
      });
    });

    this.logger.log(`Device session revoked: ${sessionId} by user: ${userId}`);

    return {
      success: true,
      message: 'Device session revoked successfully',
    };
  }

  /**
   * Clean up expired device codes (scheduled task)
   *
   * A COLLECTED row is the anchor its credential is revoked and validated
   * through (issue #518): a `did` access token whose row is gone stops
   * validating. So a collected row is kept until its `credentialExpiresAt`
   * has passed, revoked or not. Uncollected codes go as before.
   */
  async cleanupExpiredCodes(): Promise<number> {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const result = await this.prisma.deviceCode.deleteMany({
      where: {
        OR: [
          // Never collected: past the code's own expiry.
          { collectedAt: null, expiresAt: { lt: now } },
          // Never collected, marked expired more than a day ago.
          {
            collectedAt: null,
            status: DeviceCodeStatus.expired,
            updatedAt: { lt: oneDayAgo },
          },
          // Collected: once the credential it issued has expired.
          { collectedAt: { not: null }, credentialExpiresAt: { lt: now } },
          // Claimed but the credential was never recorded (minting failed
          // after the claim) — nothing to anchor, reap after a day.
          {
            collectedAt: { not: null },
            credentialExpiresAt: null,
            updatedAt: { lt: oneDayAgo },
          },
        ],
      },
    });

    this.logger.log(`Cleaned up ${result.count} expired device codes`);
    return result.count;
  }

  /**
   * Read the credential kind a device asked for out of its stored `clientInfo`.
   *
   * `clientInfo` is a JSONB column, so what comes back is `Prisma.JsonValue` —
   * it is NOT guaranteed to still match ClientInfoSchema. Rows written before
   * #141 have no `tokenType` at all, and the column is writable by anything
   * with database access. Anything that is not literally `'pat'` therefore
   * means `'session'`: the fallback is the SAFE direction (a short-lived,
   * refreshable credential), so a corrupt or legacy row degrades to the old
   * behaviour rather than silently minting a 90-day token.
   */
  private readTokenType(clientInfo: Prisma.JsonValue | null): DeviceTokenType {
    if (
      clientInfo &&
      typeof clientInfo === 'object' &&
      !Array.isArray(clientInfo) &&
      (clientInfo as Record<string, unknown>).tokenType === 'pat'
    ) {
      return 'pat';
    }

    return 'session';
  }

  /**
   * Mint a personal access token for an approved device and hand it back once.
   *
   * ---------------------------------------------------------------------------
   * WHERE THE RAW TOKEN LIVES BETWEEN APPROVAL AND COLLECTION (#141)
   * ---------------------------------------------------------------------------
   * Nowhere. That is the whole point, and it is why this runs on the POLL and
   * not on the approval.
   *
   * The tempting shape is: the user clicks Approve, we mint the PAT there, and
   * we stash the raw token on the `device_codes` row (`client_info` is JSONB
   * and would take it happily) until the device's next poll collects it. That
   * would be a serious regression. `PatService.createToken` returns the raw
   * token EXACTLY ONCE and stores only a SHA-256 hash, precisely so that a
   * database backup, a replica, a `SELECT *` in a support tool, a query log, or
   * an SQL-injection read yields no usable credential. Writing the raw token
   * into another table — even briefly, even in a row we delete afterwards —
   * reintroduces the plaintext-credential-at-rest problem the PAT design
   * already solved, in a table that is publicly writable at one end (anyone can
   * `POST /auth/device/code`) and swept by a cleanup task rather than by
   * careful deletion. Worse, the window is not short: RFC 8628 polling is
   * best-effort, so the plaintext would sit there for the full device-code
   * lifetime if the CLI is slow, backgrounded, or simply killed after the user
   * approves.
   *
   * So approval records INTENT ONLY — `status = approved` plus `userId`, which
   * is exactly what it already recorded — and the credential is created here,
   * in the request that will return it. The raw token exists in this process's
   * memory and in the HTTPS response body, and never touches persistent
   * storage. This also mirrors what the session path has always done (tokens
   * generated at poll time, not at approve time), so there is one rule for both
   * credential kinds.
   *
   * Consequences, accepted deliberately:
   *   - Approve-then-never-poll creates NO token. Good: no orphaned long-lived
   *     credential exists for a CLI that died, and nothing needs reaping.
   *   - The token cannot be re-fetched. A device that loses the response must
   *     re-run the flow. Correct for a write-once secret.
   * ---------------------------------------------------------------------------
   */
  private async issuePatCredential(
    deviceCodeId: string,
    userId: string,
    userEmail: string,
    clientInfo: Prisma.JsonValue | null,
    deviceCodeHash: string,
  ): Promise<DeviceTokenResponseDto> {
    // Claim the device code ATOMICALLY, before minting anything.
    //
    // (Until #518 the session path minted first and marked used afterwards;
    // it now claims first too, because its credential is linked to this row.)
    // A duplicated PAT is the sharpest version of the problem: two
    // concurrent polls on the same device code would leave two independently
    // valid, months-long credentials on the account, and revoking the one the
    // user can see in the Access Tokens page would not revoke the other. The
    // in-memory `pollTimestamps` rate limiter cannot prevent this — it is
    // per-process, so it does nothing across replicas, and its own
    // check-then-set races too.
    //
    // `updateMany` with `status: approved` in the WHERE clause makes the
    // transition a single conditional UPDATE: exactly one caller sees
    // count === 1, everyone else sees 0 and is refused.
    //
    // The claim also records the collection (#518); the PAT id and expiry are
    // linked right after minting, below.
    const claim = await this.prisma.deviceCode.updateMany({
      where: {
        id: deviceCodeId,
        status: DeviceCodeStatus.approved,
        revokedAt: null,
      },
      data: { status: DeviceCodeStatus.expired, collectedAt: new Date() },
    });

    if (claim.count !== 1) {
      throw deviceTokenError(
        'invalid_grant',
        'This device code has already been used',
      );
    }

    // Note the ordering: the code is consumed BEFORE the token is minted, so if
    // createToken throws, the device must re-authorize. Failing closed is the
    // right direction — the alternative leaves a still-claimable approval
    // behind, which is a standing invitation to mint a long-lived credential.
    const expiryDays = this.resolvePatExpiryDays();
    const name = this.buildPatName(clientInfo);

    const pat = await this.patService.createToken(userId, {
      name,
      durationValue: expiryDays,
      durationUnit: 'days',
    });

    // Link the PAT to its device session (#518) so revoking the session
    // revokes the PAT. Conditional on the session not having been revoked in
    // the window since the claim: if it was, the user has already said "not
    // this device", so the PAT just minted is revoked on the spot and nothing
    // is handed out. A failed link fails closed the same way — an unlinked PAT
    // is one the sessions page could never revoke.
    let linked = false;
    try {
      const link = await this.prisma.deviceCode.updateMany({
        where: { id: deviceCodeId, revokedAt: null },
        data: {
          patId: pat.id,
          credentialExpiresAt: new Date(pat.expiresAt),
        },
      });
      linked = link.count === 1;
    } finally {
      if (!linked) {
        await this.prisma.personalAccessToken.updateMany({
          where: { id: pat.id, userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    }

    if (!linked) {
      throw deviceTokenError(
        'access_denied',
        'The device session was revoked',
      );
    }

    // Clean up poll timestamp (mirrors the session path)
    this.pollTimestamps.delete(deviceCodeHash);

    // Log the id and the SANITISED name — never `pat.token`, which is the
    // credential itself, and never the raw `deviceName`, which is
    // attacker-supplied and would otherwise carry newlines into the log stream.
    this.logger.log(
      `Device authorized for user ${userEmail}; issued PAT "${name}" (${pat.id}) valid ${expiryDays} day(s)`,
    );

    return {
      // A PAT is presented as `Authorization: Bearer pat_...`; JwtAuthGuard
      // recognises the `pat_` prefix and validates it through
      // PatService.validateToken, setting the same AuthenticatedUser shape on
      // the request that the JWT strategy sets. RolesGuard and PermissionsGuard
      // therefore behave identically — this token authenticates against the
      // ordinary guarded endpoints, which is the risk #141 flagged.
      accessToken: pat.token,
      tokenType: 'Bearer',
      // No `refreshToken`: see DeviceTokenResponseDto.
      expiresIn: Math.max(
        0,
        Math.floor((new Date(pat.expiresAt).getTime() - Date.now()) / 1000),
      ),
      credentialType: 'pat',
      expiresAt: pat.expiresAt,
      tokenId: pat.id,
      tokenName: pat.name,
    };
  }

  /**
   * Resolve the configured PAT lifetime, clamped to what a hand-created PAT is
   * allowed to have.
   *
   * We bypass `createPatSchema` by calling PatService directly, so a fat-fingered
   * `DEVICE_PAT_EXPIRY_DAYS=9000` would otherwise mint a 24-year credential that
   * the web UI would never have permitted — and a non-numeric value would make
   * `expiresAt` an Invalid Date, which lands in the database as a null-ish
   * timestamp and produces a token whose expiry check behaves unpredictably.
   * Clamping keeps device-issued tokens inside the same envelope as UI-issued
   * ones, and makes misconfiguration loud rather than dangerous.
   */
  private resolvePatExpiryDays(): number {
    const DEFAULT_DAYS = 90;
    const MIN_DAYS = 1;
    const MAX_DAYS = 999; // matches createPatSchema's durationValue ceiling

    const configured = this.configService.get<number>(
      'deviceAuth.patExpiryDays',
      DEFAULT_DAYS,
    );

    const days = Math.floor(Number(configured));

    if (!Number.isFinite(days) || days < MIN_DAYS || days > MAX_DAYS) {
      this.logger.warn(
        `Invalid deviceAuth.patExpiryDays (${String(configured)}); falling back to ${DEFAULT_DAYS} days`,
      );
      return DEFAULT_DAYS;
    }

    return days;
  }

  /**
   * Build the display name for a device-issued PAT from untrusted `clientInfo`.
   *
   * `deviceName` reaches the web UI's Access Tokens list, and it arrives from an
   * UNAUTHENTICATED caller: `POST /auth/device/code` is `@Public()`, so anyone
   * who can reach the API can choose this string, and any user who approves a
   * code then sees it. It also reaches the application log. Treat it as hostile:
   *
   *   - Non-strings (JSONB round-trips objects, numbers, null happily) would
   *     blow up on `.trim()`, turning an approved poll into a 500.
   *   - Empty or whitespace-only names violate `createPatSchema`'s min(1) and,
   *     worse, produce a row a user cannot confidently identify to revoke.
   *   - C0/C1 control characters — newlines above all — forge extra lines in the
   *     Pino log stream and wreck the list rendering.
   *   - Bidi overrides (U+202E and friends) and zero-width characters let a
   *     name render as something other than what is stored, which is exactly
   *     how a user is talked out of revoking the right token.
   *   - Over-long names would exceed the 100-character ceiling the PAT UI
   *     enforces and could push the identifying prefix off the screen.
   *
   * The prefix is applied AFTER sanitising and truncating, so it can never be
   * displaced: however hostile the input, the row still starts with "Device: ".
   */
  private buildPatName(clientInfo: Prisma.JsonValue | null): string {
    const raw =
      clientInfo &&
      typeof clientInfo === 'object' &&
      !Array.isArray(clientInfo)
        ? (clientInfo as Record<string, unknown>).deviceName
        : undefined;

    let name = typeof raw === 'string' ? raw : '';

    name = name
      // Normalise compatibility forms first, so fullwidth/lookalike variants of
      // the characters stripped below cannot survive by disguise.
      .normalize('NFKC')
      // C0 controls, DEL, and C1 controls.
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
      // Zero-width and bidirectional formatting characters: invisible on screen,
      // so they let stored text and displayed text disagree.
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
      // Collapse the runs the substitutions above may have created.
      .replace(/\s+/g, ' ')
      .trim();

    if (name.length === 0) {
      name = this.PAT_NAME_FALLBACK;
    }

    const budget = this.PAT_NAME_MAX_LENGTH - this.PAT_NAME_PREFIX.length;

    if (name.length > budget) {
      // Reserve one character for the ellipsis so the result lands exactly on
      // the ceiling rather than one over it.
      name = `${name.slice(0, budget - 1)}\u2026`;
    }

    return `${this.PAT_NAME_PREFIX}${name}`;
  }

  /**
   * Generate a human-readable user code
   */
  private generateUserCode(): string {
    const chars = this.USER_CODE_CHARS;
    let code = '';

    // Generate 8 random characters
    for (let i = 0; i < 8; i++) {
      const randomIndex = randomBytes(1)[0] % chars.length;
      code += chars[randomIndex];
    }

    // Format as XXXX-XXXX
    return `${code.substring(0, 4)}-${code.substring(4, 8)}`;
  }

  /**
   * Hash token for storage
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
