export { UserCredentialsModule } from './user-credentials.module';
export { UserCredentialsService } from './user-credentials.service';
export {
  USER_CREDENTIAL_PURPOSE_REGISTRY,
  UserCredentialResolver,
} from './user-credential.resolver';
export type {
  ResolvedCredential,
  ResolvedCredentialSource,
} from './user-credential.resolver';
export {
  DEFAULT_USER_CREDENTIAL_NAME,
  USER_CREDENTIAL_PURPOSES,
  findUserCredentialPurpose,
} from './user-credential-purposes';
export type {
  SystemCredentialAddress,
  UserCredentialPurposeDef,
} from './user-credential-purposes';
export type {
  UserCredentialInfo,
  UserCredentialMeta,
} from './interfaces/user-credential-info.interface';
