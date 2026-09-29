import { Injectable } from '@nestjs/common';

import { PERMISSIONS } from '../../common/constants/roles.constants';
import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// AiConfigWriterLookup — "is this user an AI administrator?" (issue #593)
// =============================================================================
//
// Rule 2 of `AiKeyResolver` (docs/specs/ai-platform.md §2.2): a user who holds
// `ai_config:write` — the permission that stores the org key in the first
// place — is served by that org key for their OWN calls under either key
// policy. This answers the "holds it" half, read from the database (user_roles
// -> roles -> role_permissions -> permissions, the shape `auth.service.ts`
// loads), never from a JWT claim, so a revoked role stops the fallback on the
// next call.
//
// One `count`, and `AiKeyResolver` asks it only when the user has no key of
// their own for the provider.
// =============================================================================

@Injectable()
export class AiConfigWriterLookup {
  constructor(private readonly prisma: PrismaService) {}

  /** Whether `userId` holds `ai_config:write` through any of their roles. */
  async holdsAiConfigWrite(userId: string): Promise<boolean> {
    const count = await this.prisma.userRole.count({
      where: {
        userId,
        role: {
          rolePermissions: {
            some: { permission: { name: PERMISSIONS.AI_CONFIG_WRITE } },
          },
        },
      },
    });

    return count > 0;
  }
}
