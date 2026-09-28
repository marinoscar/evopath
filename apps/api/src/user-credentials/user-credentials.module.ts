import { Module } from '@nestjs/common';

import { CredentialsModule } from '../credentials/credentials.module';
import { PrismaModule } from '../prisma/prisma.module';
import {
  USER_CREDENTIAL_PURPOSE_REGISTRY,
  UserCredentialResolver,
} from './user-credential.resolver';
import { USER_CREDENTIAL_PURPOSES } from './user-credential-purposes';
import { UserCredentialsService } from './user-credentials.service';

// =============================================================================
// UserCredentialsModule (issue #387)
// =============================================================================
//
// NO CONTROLLER and NOT @Global(), for exactly the reasons `CredentialsModule`
// gives: both exported providers can yield plaintext, so every consumer must
// be a visible `imports: [UserCredentialsModule]` line in a diff, and any HTTP
// surface is added by the feature that needs it, in its own module.
//
// The purpose registry is provided under a token rather than imported by the
// resolver directly, so tests (and, if ever needed, a fork) can supply their
// own list without editing the production one.
// =============================================================================

@Module({
  imports: [PrismaModule, CredentialsModule],
  providers: [
    UserCredentialsService,
    UserCredentialResolver,
    { provide: USER_CREDENTIAL_PURPOSE_REGISTRY, useValue: USER_CREDENTIAL_PURPOSES },
  ],
  exports: [UserCredentialsService, UserCredentialResolver],
})
export class UserCredentialsModule {}
