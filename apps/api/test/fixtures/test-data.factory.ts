import { randomUUID } from 'crypto';

/**
 * Test data factories for creating mock entities
 * These create in-memory objects without database calls
 *
 * NOTE: These factories return plain objects that match Prisma types.
 * They intentionally don't import Prisma types directly to avoid
 * strict type checking issues in tests.
 */

// ============================================================================
// Roles and Permissions
// ============================================================================

export const mockPermissions = {
  systemSettingsRead: {
    id: randomUUID(),
    name: 'system_settings:read',
    description: 'Read system settings',
  },
  systemSettingsWrite: {
    id: randomUUID(),
    name: 'system_settings:write',
    description: 'Modify system settings',
  },
  userSettingsRead: {
    id: randomUUID(),
    name: 'user_settings:read',
    description: 'Read user settings',
  },
  userSettingsWrite: {
    id: randomUUID(),
    name: 'user_settings:write',
    description: 'Modify user settings',
  },
  usersRead: {
    id: randomUUID(),
    name: 'users:read',
    description: 'Read user data',
  },
  usersWrite: {
    id: randomUUID(),
    name: 'users:write',
    description: 'Modify user data',
  },
  rbacManage: {
    id: randomUUID(),
    name: 'rbac:manage',
    description: 'Manage roles and permissions',
  },
  allowlistRead: {
    id: randomUUID(),
    name: 'allowlist:read',
    description: 'Read allowlist',
  },
  allowlistWrite: {
    id: randomUUID(),
    name: 'allowlist:write',
    description: 'Modify allowlist',
  },
  // The background queue's admin surface (#264, epic #254). Seeded to Admin
  // only in `prisma/seed-data.ts`, and mirrored that way below.
  jobsRead: {
    id: randomUUID(),
    name: 'jobs:read',
    description: 'View queued, running and completed jobs',
  },
  jobsWrite: {
    id: randomUUID(),
    name: 'jobs:write',
    description: 'Enqueue, retry and cancel jobs',
  },
  // The worker fleet (#267, epic #254). Split from `jobs:*` deliberately —
  // see `common/constants/roles.constants.ts` — and, like the queue's pair,
  // seeded to Admin ONLY in `prisma/seed-data.ts`. Mirrored that way below so
  // an integration test that expects a viewer to be refused a node surface is
  // testing the real grant and not a fixture that happened to be generous.
  nodesRead: {
    id: randomUUID(),
    name: 'nodes:read',
    description: 'View worker nodes and their health',
  },
  nodesWrite: {
    id: randomUUID(),
    name: 'nodes:write',
    description: 'Register, drain and remove worker nodes',
  },
  // Admin notification broadcasts (#320/#324, epic #319). Seeded to Admin ONLY
  // in `prisma/seed-data.ts` and mirrored that way below: a broadcast reaches
  // every active user in the deployment, so an integration test that expects a
  // viewer to be refused these routes must be testing the real grant rather
  // than a fixture that happened to be generous.
  broadcastsRead: {
    id: randomUUID(),
    name: 'broadcasts:read',
    description: 'View notification broadcasts and their delivery history',
  },
  broadcastsWrite: {
    id: randomUUID(),
    name: 'broadcasts:write',
    description: 'Compose, schedule, cancel and send notification broadcasts',
  },
  // Database backup (#283, epic #254). Seeded to Admin ONLY in
  // `prisma/seed-data.ts`, and mirrored that way below — a fixture that were
  // more generous than the seed would make an integration test asserting that a
  // viewer is refused pass for the wrong reason.
  //
  // `db_backup:restore` gates the two routes that replace the production
  // database (#286) and nothing else; it is seeded to Admin like the other two.
  // A spec that needs the OPPOSITE — an Admin who may schedule backups but must
  // NOT be able to restore — narrows this fixture per request rather than
  // weakening it here, because the fixture's job is to mirror the seed.
  dbBackupRead: {
    id: randomUUID(),
    name: 'db_backup:read',
    description: 'View backup schedule, history and status',
  },
  dbBackupWrite: {
    id: randomUUID(),
    name: 'db_backup:write',
    description: 'Configure the backup schedule and run a backup',
  },
  dbBackupRestore: {
    id: randomUUID(),
    name: 'db_backup:restore',
    description: 'Restore the database from a backup',
  },
  // Runtime-configurable Web Push (VAPID) admin UI (#355). Seeded to Admin
  // ONLY in `prisma/seed-data.ts`, and mirrored that way below — split from
  // `system_settings:*` deliberately (see `common/constants/roles.constants.ts`),
  // so a fixture that granted it more broadly than the seed would make an
  // integration test asserting a viewer is refused pass for the wrong reason.
  pushRead: {
    id: randomUUID(),
    name: 'push:read',
    description: 'View the Web Push (VAPID) configuration',
  },
  pushWrite: {
    id: randomUUID(),
    name: 'push:write',
    description: 'Generate, rotate, enable/disable and remove the Web Push key pair',
  },
  // Object-storage CONFIGURATION (#375, epic #372). Seeded to Admin ONLY in
  // `prisma/seed-data.ts`, and mirrored that way below.
  //
  // ⚠ NOT the same thing as `storage:read`/`storage:write`, which gate object
  // ACCESS and which Viewer and Contributor genuinely hold. This pair decides
  // WHICH object store the deployment uses and under whose key, and a fixture
  // that handed it to a viewer would make an integration test asserting a
  // viewer is refused pass for the wrong reason.
  storageConfigRead: {
    id: randomUUID(),
    name: 'storage_config:read',
    description: 'View the object-storage configuration',
  },
  storageConfigWrite: {
    id: randomUUID(),
    name: 'storage_config:write',
    description: 'Change, test and provision the object-storage configuration',
  },
  // Object-storage object ACCESS (#516). Mirrored from `prisma/seed-data.ts`
  // exactly: Admin holds all three; Contributor holds read + write; Viewer
  // holds read only. `storage:delete_any` is Admin-only — a fixture that gave
  // it to a viewer or contributor would make an integration test asserting
  // either is refused pass for the wrong reason.
  storageRead: {
    id: randomUUID(),
    name: 'storage:read',
    description: 'Read object metadata, get download URLs',
  },
  storageWrite: {
    id: randomUUID(),
    name: 'storage:write',
    description: 'Upload, update metadata',
  },
  storageDeleteAny: {
    id: randomUUID(),
    name: 'storage:delete_any',
    description: 'Admin: delete any object',
  },
  // AI platform (#423, #428, epic #419; #499), mirrored from
  // `prisma/seed-data.ts`: `ai_config:*` is Admin-only; `ai:use` is held by
  // Admin and Contributor but deliberately NOT Viewer (#499) — see
  // `rolePermissionsMap.viewer` below and `prisma/seed-data.ts`'s comment on
  // the same grant for the full reasoning.
  aiConfigRead: {
    id: randomUUID(),
    name: 'ai_config:read',
    description: 'View the AI platform configuration',
  },
  aiConfigWrite: {
    id: randomUUID(),
    name: 'ai_config:write',
    description: 'Change the AI platform configuration, keys and model catalog',
  },
  aiUse: {
    id: randomUUID(),
    name: 'ai:use',
    description: 'Use AI features',
  },
  // Telemetry (epic #528, story #533), mirrored from `prisma/seed-data.ts`:
  // all three are Admin-only, matching `db_backup:*`/`ai_config:*` above — a
  // fixture that were more generous than the seed would make an integration
  // test asserting a viewer is refused pass for the wrong reason.
  telemetryRead: {
    id: randomUUID(),
    name: 'telemetry:read',
    description: 'View telemetry settings and status',
  },
  telemetryWrite: {
    id: randomUUID(),
    name: 'telemetry:write',
    description: 'Change telemetry settings',
  },
  telemetryQuery: {
    id: randomUUID(),
    name: 'telemetry:query',
    description: 'Run SQL, export and use the AI assistant against telemetry',
  },
};

export const mockRoles = {
  admin: {
    id: randomUUID(),
    name: 'admin',
    description: 'Full system access',
  },
  contributor: {
    id: randomUUID(),
    name: 'contributor',
    description: 'Standard user capabilities',
  },
  viewer: {
    id: randomUUID(),
    name: 'viewer',
    description: 'Read-only access',
  },
};

// ============================================================================
// User Factory
// ============================================================================

export interface CreateMockUserOptions {
  id?: string;
  email?: string;
  displayName?: string | null;
  providerDisplayName?: string | null;
  profileImageUrl?: string | null;
  providerProfileImageUrl?: string | null;
  isActive?: boolean;
  roleName?: 'admin' | 'contributor' | 'viewer';
  createdAt?: Date;
  updatedAt?: Date;
}

export function createMockUser(options: CreateMockUserOptions = {}): any {
  const timestamp = Date.now();
  const {
    id = randomUUID(),
    email = `test-${timestamp}@example.com`,
    displayName = null,
    providerDisplayName = 'Test User',
    profileImageUrl = null,
    providerProfileImageUrl = 'https://example.com/photo.jpg',
    isActive = true,
    createdAt = new Date(),
    updatedAt = new Date(),
  } = options;

  return {
    id,
    email,
    displayName,
    providerDisplayName,
    profileImageUrl,
    providerProfileImageUrl,
    isActive,
    createdAt,
    updatedAt,
  };
}

// ============================================================================
// User Identity Factory
// ============================================================================

export interface CreateMockUserIdentityOptions {
  id?: string;
  userId: string;
  provider?: string;
  providerSubject?: string;
  providerEmail?: string | null;
  createdAt?: Date;
}

export function createMockUserIdentity(
  options: CreateMockUserIdentityOptions,
): any {
  const timestamp = Date.now();
  const {
    id = randomUUID(),
    userId,
    provider = 'google',
    providerSubject = `google-${timestamp}`,
    providerEmail = `test-${timestamp}@example.com`,
    createdAt = new Date(),
  } = options;

  return {
    id,
    userId,
    provider,
    providerSubject,
    providerEmail,
    createdAt,
  };
}

// ============================================================================
// User Role Factory
// ============================================================================

export interface CreateMockUserRoleOptions {
  userId: string;
  roleId: string;
}

export function createMockUserRole(options: CreateMockUserRoleOptions): any {
  const { userId, roleId } = options;

  // UserRole has composite primary key [userId, roleId], no id field
  return {
    userId,
    roleId,
  };
}

// ============================================================================
// User Settings Factory
// ============================================================================

export interface CreateMockUserSettingsOptions {
  id?: string;
  userId: string;
  value?: any;
  version?: number;
  updatedAt?: Date;
}

export function createMockUserSettings(
  options: CreateMockUserSettingsOptions,
): any {
  const {
    id = randomUUID(),
    userId,
    value = {
      theme: 'system',
      profile: {
        displayName: null,
        imageSource: 'provider',
        imageObjectId: null,
      },
      updatedAt: new Date().toISOString(),
      version: 1,
    },
    version = 1,
    updatedAt = new Date(),
  } = options;

  return {
    id,
    userId,
    value,
    version,
    updatedAt,
  };
}

// ============================================================================
// System Settings Factory
// ============================================================================

export interface CreateMockSystemSettingsOptions {
  id?: string;
  key?: string;
  value?: any;
  version?: number;
  updatedByUserId?: string | null;
  updatedAt?: Date;
}

export function createMockSystemSettings(
  options: CreateMockSystemSettingsOptions = {},
): any {
  const {
    id = randomUUID(),
    key = 'default',
    value = {
      notifications: { browserEnabled: true, disabledEvents: [] },
      jobs: {
        history: { retentionDays: 30, purgeEnabled: true },
        stuckThresholdMinutes: 30,
      },
      nodes: {
        staleHeartbeatSeconds: 90,
        offlineStaleMultiplier: 4,
        offlineRetentionDays: 30,
        jobSecretBrokerEnabled: false,
      },
    },
    version = 1,
    updatedByUserId = null,
    updatedAt = new Date(),
  } = options;

  return {
    id,
    key,
    value,
    version,
    updatedByUserId,
    updatedAt,
  };
}

// ============================================================================
// Allowed Email Factory
// ============================================================================

export interface CreateMockAllowedEmailOptions {
  id?: string;
  email: string;
  notes?: string | null;
  addedById?: string | null;
  claimedById?: string | null;
  claimedAt?: Date | null;
  addedAt?: Date;
}

export function createMockAllowedEmail(
  options: CreateMockAllowedEmailOptions,
): any {
  const {
    id = randomUUID(),
    email,
    notes = null,
    addedById = null,
    claimedById = null,
    claimedAt = null,
    addedAt = new Date(),
  } = options;

  return {
    id,
    email: email.toLowerCase(),
    notes,
    addedById,
    claimedById,
    claimedAt,
    addedAt,
  };
}

// ============================================================================
// Audit Event Factory
// ============================================================================

export interface CreateMockAuditEventOptions {
  id?: string;
  actorUserId?: string | null;
  action: string;
  targetId: string;
  targetType: string;
  meta?: any;
  createdAt?: Date;
}

export function createMockAuditEvent(options: CreateMockAuditEventOptions): any {
  const {
    id = randomUUID(),
    actorUserId = null,
    action,
    targetId,
    targetType,
    meta = {},
    createdAt = new Date(),
  } = options;

  return {
    id,
    actorUserId,
    action,
    targetId,
    targetType,
    meta,
    createdAt,
  };
}

// ============================================================================
// Role Permissions Mapping
// ============================================================================

/**
 * Maps role names to their permissions
 * This mirrors the actual RBAC configuration
 */
export const rolePermissionsMap = {
  admin: [
    mockPermissions.systemSettingsRead,
    mockPermissions.systemSettingsWrite,
    mockPermissions.userSettingsRead,
    mockPermissions.userSettingsWrite,
    mockPermissions.usersRead,
    mockPermissions.usersWrite,
    mockPermissions.rbacManage,
    mockPermissions.allowlistRead,
    mockPermissions.allowlistWrite,
    mockPermissions.jobsRead,
    mockPermissions.jobsWrite,
    mockPermissions.nodesRead,
    mockPermissions.nodesWrite,
    mockPermissions.broadcastsRead,
    mockPermissions.broadcastsWrite,
    mockPermissions.dbBackupRead,
    mockPermissions.dbBackupWrite,
    mockPermissions.dbBackupRestore,
    mockPermissions.pushRead,
    mockPermissions.pushWrite,
    mockPermissions.storageConfigRead,
    mockPermissions.storageConfigWrite,
    mockPermissions.aiConfigRead,
    mockPermissions.aiConfigWrite,
    mockPermissions.aiUse,
    // #516 — Admin holds all three object-ACCESS permissions, including
    // `storage:delete_any` (see the comment on `mockPermissions` above).
    mockPermissions.storageRead,
    mockPermissions.storageWrite,
    mockPermissions.storageDeleteAny,
    mockPermissions.telemetryRead,
    mockPermissions.telemetryWrite,
    mockPermissions.telemetryQuery,
  ],
  contributor: [
    mockPermissions.userSettingsRead,
    mockPermissions.userSettingsWrite,
    mockPermissions.aiUse,
    // #516 — read + write, mirroring `prisma/seed-data.ts`; never `delete_any`.
    mockPermissions.storageRead,
    mockPermissions.storageWrite,
  ],
  // #499 — deliberately NO `aiUse` here, unlike Contributor above. Viewer is
  // the DEFAULT role every new user lands in, so a fixture that granted it
  // AI use more generously than the real seed would make an integration test
  // asserting a viewer is refused an AI route pass for the wrong reason. A
  // test that needs an "everyday, allowed" AI caller uses `roleName:
  // 'contributor'` instead.
  //
  // #516 — read only, mirroring `prisma/seed-data.ts`; never `storage:write`
  // or `storage:delete_any`. A test that needs a caller who may write storage
  // objects uses `roleName: 'contributor'` instead.
  viewer: [
    mockPermissions.userSettingsRead,
    mockPermissions.userSettingsWrite,
    mockPermissions.storageRead,
  ],
};

// ============================================================================
// Complete User with Relations
// ============================================================================

export interface MockUserWithRelations {
  id: string;
  email: string;
  displayName: string | null;
  providerDisplayName: string | null;
  profileImageUrl: string | null;
  providerProfileImageUrl: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  userRoles?: Array<{
    userId: string;
    roleId: string;
    role: {
      id: string;
      name: string;
      description: string | null;
      rolePermissions: Array<{
        roleId: string;
        permissionId: string;
        permission: { id: string; name: string; description: string | null };
      }>;
    };
  }>;
  identities?: any[];
  userSettings?: any;
}

export function createMockUserWithRelations(
  options: CreateMockUserOptions = {},
): MockUserWithRelations {
  const user = createMockUser(options);
  const roleName = options.roleName || 'viewer';
  const role = mockRoles[roleName];

  // Get permissions for this role
  const permissions = rolePermissionsMap[roleName] || [];

  // Build the full nested structure matching AuthenticatedUser type
  const roleWithPermissions = {
    ...role,
    rolePermissions: permissions.map((permission) => ({
      roleId: role.id,
      permissionId: permission.id,
      permission,
    })),
  };

  const userRole = createMockUserRole({
    userId: user.id,
    roleId: role.id,
  });

  const identity = createMockUserIdentity({
    userId: user.id,
    providerEmail: user.email,
  });

  const settings = createMockUserSettings({
    userId: user.id,
  });

  return {
    ...user,
    userRoles: [{ ...userRole, role: roleWithPermissions }],
    identities: [identity],
    userSettings: settings,
  };
}
