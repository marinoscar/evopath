import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from '../notifications/notifications.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { GoogleProfile } from './strategies/google.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { AdminBootstrapService } from '../common/services/admin-bootstrap.service';
import { AllowlistService } from '../allowlist/allowlist.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

describe('AuthService', () => {
  let service: AuthService;
  let mockPrisma: MockPrismaService;
  let mockJwtService: jest.Mocked<JwtService>;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockAdminBootstrap: jest.Mocked<AdminBootstrapService>;
  let mockAllowlistService: jest.Mocked<AllowlistService>;
  let mockNotifications: { notify: jest.Mock; notifyAddress: jest.Mock };

  const mockGoogleProfile: GoogleProfile = {
    id: 'google-123',
    email: 'test@example.com',
    displayName: 'Test User',
    picture: 'https://example.com/photo.jpg',
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockJwtService = {
      sign: jest.fn().mockReturnValue('mock-jwt-token'),
      signAsync: jest.fn().mockResolvedValue('mock-jwt-token'),
      verify: jest.fn(),
    } as any;
    mockConfigService = {
      get: jest.fn((key: string) => {
        const config: Record<string, any> = {
          'jwt.accessTtlMinutes': 15,
          'jwt.refreshTtlDays': 14,
          'jwt.secret': 'test-secret',
          'google.clientId': 'test-client-id',
          'google.clientSecret': 'test-client-secret',
        };
        return config[key];
      }),
    } as any;
    mockAdminBootstrap = {
      shouldGrantAdminRole: jest.fn().mockResolvedValue(false),
      assignAdminRole: jest.fn().mockResolvedValue(undefined),
    } as any;
    mockAllowlistService = {
      isEmailAllowed: jest.fn().mockResolvedValue(true),
      markEmailClaimed: jest.fn().mockResolvedValue(undefined),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AdminBootstrapService, useValue: mockAdminBootstrap },
        { provide: AllowlistService, useValue: mockAllowlistService },
        // #128 wired real notification triggers into this service. The
        // dispatcher is mocked here because these tests are about the
        // service's own behaviour, not about delivery — and because `notify`
        // is contracted never to throw, a stub that resolves is a faithful
        // stand-in. The containment property itself (a send failure does not
        // roll back the triggering action) is asserted with a REAL dispatcher
        // and a failing provider in
        // notifications/notification-failure-containment.spec.ts.
        {
          provide: NotificationsService,
          useValue: (mockNotifications = {
            notify: jest.fn().mockResolvedValue(undefined),
            notifyAddress: jest.fn().mockResolvedValue(undefined),
          }),
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handleGoogleLogin', () => {
    it('should create new user when no identity exists', async () => {
      const mockRole = { id: 'role-1', name: 'viewer', rolePermissions: [] };
      const mockUser = {
        id: 'user-1',
        email: mockGoogleProfile.email,
        isActive: true,
        userRoles: [{ role: mockRole }],
      };

      mockPrisma.userIdentity.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.role.findUnique.mockResolvedValue(mockRole as any);
      mockPrisma.$transaction.mockImplementation(async (callback) => {
        return callback(mockPrisma);
      });
      mockPrisma.user.create.mockResolvedValue(mockUser as any);
      mockPrisma.user.update.mockResolvedValue(mockUser as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      const result = await service.handleGoogleLogin(mockGoogleProfile);

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('expiresIn');
      expect(result).toHaveProperty('refreshToken');
      expect(mockJwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user-1',
          email: mockGoogleProfile.email,
          roles: ['viewer'],
        }),
        expect.objectContaining({ expiresIn: expect.any(String) }),
      );
    });

    it('should link identity when user exists by email', async () => {
      const existingUser = {
        id: 'existing-user',
        email: mockGoogleProfile.email,
        isActive: true,
        userRoles: [{ role: { name: 'contributor', rolePermissions: [] } }],
      };

      mockPrisma.userIdentity.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue(existingUser as any);
      mockPrisma.userIdentity.create.mockResolvedValue({} as any);
      mockPrisma.user.update.mockResolvedValue(existingUser as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      const result = await service.handleGoogleLogin(mockGoogleProfile);

      expect(mockPrisma.userIdentity.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'existing-user',
          provider: 'google',
          providerSubject: mockGoogleProfile.id,
        }),
      });
      expect(result.accessToken).toBeDefined();
    });

    it('should return existing user when identity exists', async () => {
      const existingIdentity = {
        user: {
          id: 'existing-user',
          email: mockGoogleProfile.email,
          isActive: true,
          userRoles: [{ role: { name: 'admin', rolePermissions: [] } }],
        },
      };

      mockPrisma.userIdentity.findUnique.mockResolvedValue(existingIdentity as any);
      mockPrisma.user.update.mockResolvedValue(existingIdentity.user as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      const result = await service.handleGoogleLogin(mockGoogleProfile);

      expect(result.accessToken).toBeDefined();
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenException for deactivated user', async () => {
      const deactivatedUser = {
        id: 'deactivated-user',
        email: mockGoogleProfile.email,
        isActive: false,
        userRoles: [{ role: { name: 'viewer', rolePermissions: [] } }],
      };

      mockPrisma.userIdentity.findUnique.mockResolvedValue({
        user: deactivatedUser,
      } as any);
      mockPrisma.user.update.mockResolvedValue(deactivatedUser as any);

      await expect(service.handleGoogleLogin(mockGoogleProfile)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should grant admin role when shouldGrantAdminRole returns true', async () => {
      const mockViewerRole = { id: 'viewer-role', name: 'viewer', rolePermissions: [] };
      const mockAdminRole = { id: 'admin-role', name: 'admin', rolePermissions: [] };
      const mockUserCreated = {
        id: 'new-admin',
        email: 'admin@example.com',
        isActive: true,
        userRoles: [{ role: mockViewerRole }],
      };
      const mockUserWithAdmin = {
        id: 'new-admin',
        email: 'admin@example.com',
        isActive: true,
        userRoles: [{ role: mockViewerRole }, { role: mockAdminRole }],
      };

      mockAdminBootstrap.shouldGrantAdminRole.mockResolvedValue(true);
      mockPrisma.userIdentity.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null) // Check by email in handleGoogleLogin
        .mockResolvedValueOnce(mockUserWithAdmin as any); // Reload after admin assignment in transaction
      mockPrisma.role.findUnique
        .mockResolvedValueOnce(mockViewerRole as any) // Get default role
        .mockResolvedValueOnce(mockAdminRole as any); // Get admin role in transaction
      mockPrisma.$transaction.mockImplementation(async (callback) => callback(mockPrisma));
      mockPrisma.user.create.mockResolvedValue(mockUserCreated as any);
      mockPrisma.userRole.upsert.mockResolvedValue({} as any);
      mockPrisma.user.update.mockResolvedValue(mockUserWithAdmin as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      const adminProfile = { ...mockGoogleProfile, email: 'admin@example.com' };
      const result = await service.handleGoogleLogin(adminProfile);

      expect(mockAdminBootstrap.shouldGrantAdminRole).toHaveBeenCalledWith('admin@example.com');
      // Admin role is now assigned directly in transaction, not via adminBootstrap.assignAdminRole
      expect(mockPrisma.userRole.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId_roleId: {
              userId: 'new-admin',
              roleId: 'admin-role',
            },
          },
        }),
      );
      expect(result.accessToken).toBeDefined();
    });

    it('should update user picture on login if changed', async () => {
      const existingUser = {
        id: 'user-with-old-picture',
        email: mockGoogleProfile.email,
        isActive: true,
        providerProfileImageUrl: 'https://old-url.com/photo.jpg',
        userRoles: [{ role: { name: 'viewer', rolePermissions: [] } }],
      };

      mockPrisma.userIdentity.findUnique.mockResolvedValue({
        user: existingUser,
      } as any);
      mockPrisma.user.update.mockResolvedValue({
        ...existingUser,
        providerProfileImageUrl: mockGoogleProfile.picture,
      } as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      await service.handleGoogleLogin(mockGoogleProfile);

      // Verify that user.update was called with new profile info
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: existingUser.id },
        data: {
          providerDisplayName: mockGoogleProfile.displayName,
          providerProfileImageUrl: mockGoogleProfile.picture,
        },
      });
    });

    it('should throw ForbiddenException when email not in allowlist', async () => {
      mockAllowlistService.isEmailAllowed.mockResolvedValue(false);

      await expect(service.handleGoogleLogin(mockGoogleProfile)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.handleGoogleLogin(mockGoogleProfile)).rejects.toThrow(
        'Your email is not authorized to access this application',
      );
    });

    it('should create user identity linking on first login', async () => {
      const mockRole = { id: 'role-1', name: 'viewer', rolePermissions: [] };
      const mockUser = {
        id: 'new-user-1',
        email: mockGoogleProfile.email,
        isActive: true,
        userRoles: [{ role: mockRole }],
      };

      mockPrisma.userIdentity.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.role.findUnique.mockResolvedValue(mockRole as any);
      mockPrisma.$transaction.mockImplementation(async (callback) => callback(mockPrisma));
      mockPrisma.user.create.mockResolvedValue(mockUser as any);
      mockPrisma.user.update.mockResolvedValue(mockUser as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      await service.handleGoogleLogin(mockGoogleProfile);

      // Verify identity was created in transaction
      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: mockGoogleProfile.email,
            identities: expect.objectContaining({
              create: expect.objectContaining({
                provider: 'google',
                providerSubject: mockGoogleProfile.id,
                providerEmail: mockGoogleProfile.email,
              }),
            }),
          }),
        }),
      );
    });

    it('should assign default role to new users', async () => {
      const mockRole = { id: 'role-1', name: 'viewer', rolePermissions: [] };
      const mockUser = {
        id: 'new-user-2',
        email: mockGoogleProfile.email,
        isActive: true,
        userRoles: [{ role: mockRole }],
      };

      mockPrisma.userIdentity.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.role.findUnique.mockResolvedValue(mockRole as any);
      mockPrisma.$transaction.mockImplementation(async (callback) => callback(mockPrisma));
      mockPrisma.user.create.mockResolvedValue(mockUser as any);
      mockPrisma.user.update.mockResolvedValue(mockUser as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      await service.handleGoogleLogin(mockGoogleProfile);

      // Verify default role was assigned in transaction
      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userRoles: expect.objectContaining({
              create: expect.objectContaining({
                roleId: mockRole.id,
              }),
            }),
          }),
        }),
      );
    });

    it('should create user settings for new users', async () => {
      const mockRole = { id: 'role-1', name: 'viewer', rolePermissions: [] };
      const mockUser = {
        id: 'new-user-3',
        email: mockGoogleProfile.email,
        isActive: true,
        userRoles: [{ role: mockRole }],
      };

      mockPrisma.userIdentity.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.role.findUnique.mockResolvedValue(mockRole as any);
      mockPrisma.$transaction.mockImplementation(async (callback) => callback(mockPrisma));
      mockPrisma.user.create.mockResolvedValue(mockUser as any);
      mockPrisma.user.update.mockResolvedValue(mockUser as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      await service.handleGoogleLogin(mockGoogleProfile);

      // Verify user settings were created in transaction
      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userSettings: expect.objectContaining({
              create: expect.objectContaining({
                value: expect.any(Object),
              }),
            }),
          }),
        }),
      );
    });

    it('should mark email as claimed in allowlist after creating new user', async () => {
      const mockRole = { id: 'role-1', name: 'viewer', rolePermissions: [] };
      const mockUser = {
        id: 'new-user-4',
        email: mockGoogleProfile.email,
        isActive: true,
        userRoles: [{ role: mockRole }],
      };

      mockPrisma.userIdentity.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.role.findUnique.mockResolvedValue(mockRole as any);
      mockPrisma.$transaction.mockImplementation(async (callback) => callback(mockPrisma));
      mockPrisma.user.create.mockResolvedValue(mockUser as any);
      mockPrisma.user.update.mockResolvedValue(mockUser as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      await service.handleGoogleLogin(mockGoogleProfile);

      // Verify allowlist was marked as claimed
      expect(mockAllowlistService.markEmailClaimed).toHaveBeenCalledWith(
        mockGoogleProfile.email.toLowerCase(),
        mockUser.id,
      );
    });

    // =========================================================================
    // `user.welcome` notification (#128, epic #109)
    // =========================================================================
    //
    // The dispatcher itself is mocked here (see the provider comment above),
    // so these tests are about ONE thing: whether `AuthService` calls
    // `notify('user.welcome', ...)` on the right branch and nowhere else. The
    // fire-once guarantee is structural — `userWasCreated` is set on exactly
    // the branch that inserts a new user row — so each scenario below drives a
    // different branch of `handleGoogleLogin` and asserts on the mock.
    // =========================================================================
    describe('user.welcome notification', () => {
      it('fires exactly once when a new user is created', async () => {
        const mockRole = { id: 'role-1', name: 'viewer', rolePermissions: [] };
        const mockUser = {
          id: 'new-user-welcome',
          email: mockGoogleProfile.email,
          isActive: true,
          userRoles: [{ role: mockRole }],
        };

        mockPrisma.userIdentity.findUnique.mockResolvedValue(null);
        mockPrisma.user.findUnique.mockResolvedValue(null);
        mockPrisma.role.findUnique.mockResolvedValue(mockRole as any);
        mockPrisma.$transaction.mockImplementation(async (callback) => callback(mockPrisma));
        mockPrisma.user.create.mockResolvedValue(mockUser as any);
        mockPrisma.user.update.mockResolvedValue(mockUser as any);
        mockPrisma.refreshToken.create.mockResolvedValue({} as any);

        await service.handleGoogleLogin(mockGoogleProfile);

        expect(mockNotifications.notify).toHaveBeenCalledTimes(1);
        expect(mockNotifications.notify).toHaveBeenCalledWith(
          'user.welcome',
          mockUser.id,
          expect.objectContaining({ recipientEmail: mockUser.email }),
        );
      });

      it('does NOT fire on a subsequent login, where the identity resolves to an existing user', async () => {
        const existingIdentity = {
          user: {
            id: 'existing-user',
            email: mockGoogleProfile.email,
            isActive: true,
            userRoles: [{ role: { name: 'admin', rolePermissions: [] } }],
          },
        };

        mockPrisma.userIdentity.findUnique.mockResolvedValue(existingIdentity as any);
        mockPrisma.user.update.mockResolvedValue(existingIdentity.user as any);
        mockPrisma.refreshToken.create.mockResolvedValue({} as any);

        await service.handleGoogleLogin(mockGoogleProfile);

        expect(mockPrisma.user.create).not.toHaveBeenCalled();
        expect(mockNotifications.notify).not.toHaveBeenCalled();
      });

      it('does NOT fire when an existing account links a second provider (identity-linking branch)', async () => {
        const existingUser = {
          id: 'existing-user',
          email: mockGoogleProfile.email,
          isActive: true,
          userRoles: [{ role: { name: 'contributor', rolePermissions: [] } }],
        };

        mockPrisma.userIdentity.findUnique.mockResolvedValue(null);
        mockPrisma.user.findUnique.mockResolvedValue(existingUser as any);
        mockPrisma.userIdentity.create.mockResolvedValue({} as any);
        mockPrisma.user.update.mockResolvedValue(existingUser as any);
        mockPrisma.refreshToken.create.mockResolvedValue({} as any);

        await service.handleGoogleLogin(mockGoogleProfile);

        // The identity WAS created (the linking itself happened)...
        expect(mockPrisma.userIdentity.create).toHaveBeenCalled();
        // ...but no new user row was inserted, so `userWasCreated` stays false
        // and the welcome notification must not fire for an account that
        // already exists and was welcomed when it was made.
        expect(mockPrisma.user.create).not.toHaveBeenCalled();
        expect(mockNotifications.notify).not.toHaveBeenCalled();
      });

      it('does NOT fire when the login is refused after creation (the isActive check)', async () => {
        // A user just inserted by THIS call, but reported inactive — the race
        // the ordering comment in auth.service.ts describes: welcoming
        // somebody to an application they were just refused entry to is a
        // worse message than none. `createNewUser` never produces an inactive
        // row today (it hardcodes `isActive: true`), so this scenario is
        // exercised by constructing it directly: it proves the GATE (the
        // notification is raised only after the isActive check, not inside
        // the creation branch) rather than a naturally-reachable data state.
        const mockRole = { id: 'role-1', name: 'viewer', rolePermissions: [] };
        const inactiveNewUser = {
          id: 'refused-new-user',
          email: mockGoogleProfile.email,
          isActive: false,
          userRoles: [{ role: mockRole }],
        };

        mockPrisma.userIdentity.findUnique.mockResolvedValue(null);
        mockPrisma.user.findUnique.mockResolvedValue(null);
        mockPrisma.role.findUnique.mockResolvedValue(mockRole as any);
        mockPrisma.$transaction.mockImplementation(async (callback) => callback(mockPrisma));
        mockPrisma.user.create.mockResolvedValue(inactiveNewUser as any);
        mockPrisma.user.update.mockResolvedValue(inactiveNewUser as any);

        await expect(service.handleGoogleLogin(mockGoogleProfile)).rejects.toThrow(
          ForbiddenException,
        );

        expect(mockNotifications.notify).not.toHaveBeenCalled();
      });
    });
  });

  describe('validateJwtPayload', () => {
    it('should return user with roles and permissions', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'test@example.com',
        isActive: true,
        userRoles: [
          {
            role: {
              name: 'admin',
              rolePermissions: [
                { permission: { name: 'users:read' } },
                { permission: { name: 'users:write' } },
              ],
            },
          },
        ],
      };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser as any);

      const result = await service.validateJwtPayload({
        sub: 'user-1',
        email: 'test@example.com',
        roles: ['admin'],
      });

      expect(result).toEqual(mockUser);
    });

    it('should return null for non-existent user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const result = await service.validateJwtPayload({
        sub: 'non-existent',
        email: 'test@example.com',
        roles: [],
      });

      expect(result).toBeNull();
    });

    it('should return null for inactive user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        isActive: false,
        userRoles: [],
      } as any);

      const result = await service.validateJwtPayload({
        sub: 'user-1',
        email: 'test@example.com',
        roles: [],
      });

      expect(result).toBeNull();
    });
  });

  describe('validateJwtPayload — device-issued tokens (did claim, #518)', () => {
    const liveUser = {
      id: 'user-1',
      email: 'test@example.com',
      isActive: true,
      userRoles: [],
    };
    const devicePayload = {
      sub: 'user-1',
      email: 'test@example.com',
      roles: [],
      did: 'device-code-1',
    };
    const liveDeviceCode = {
      id: 'device-code-1',
      userId: 'user-1',
      revokedAt: null,
      credentialExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };

    beforeEach(() => {
      mockPrisma.user.findUnique.mockResolvedValue(liveUser as any);
    });

    it('does not look up a device code for a token without did', async () => {
      const result = await service.validateJwtPayload({
        sub: 'user-1',
        email: 'test@example.com',
        roles: [],
      });

      expect(result).toEqual(liveUser);
      expect(mockPrisma.deviceCode.findUnique).not.toHaveBeenCalled();
    });

    it('accepts a token whose device session is live', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue(liveDeviceCode as any);

      const result = await service.validateJwtPayload(devicePayload);

      expect(result).toEqual(liveUser);
      expect(mockPrisma.deviceCode.findUnique).toHaveBeenCalledWith({
        where: { id: 'device-code-1' },
        select: {
          id: true,
          userId: true,
          revokedAt: true,
          credentialExpiresAt: true,
        },
      });
    });

    it('rejects a token whose device session was revoked', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        ...liveDeviceCode,
        revokedAt: new Date(),
      } as any);

      await expect(service.validateJwtPayload(devicePayload)).resolves.toBeNull();
    });

    it('rejects a token whose device credential has expired', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        ...liveDeviceCode,
        credentialExpiresAt: new Date(Date.now() - 1000),
      } as any);

      await expect(service.validateJwtPayload(devicePayload)).resolves.toBeNull();
    });

    it('rejects a token whose device session has no recorded credential expiry', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        ...liveDeviceCode,
        credentialExpiresAt: null,
      } as any);

      await expect(service.validateJwtPayload(devicePayload)).resolves.toBeNull();
    });

    it("rejects a token pointing at another user's device session", async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        ...liveDeviceCode,
        userId: 'other-user',
      } as any);

      await expect(service.validateJwtPayload(devicePayload)).resolves.toBeNull();
    });

    it('rejects a token whose device session no longer exists', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue(null);

      await expect(service.validateJwtPayload(devicePayload)).resolves.toBeNull();
    });

    it('rejects an empty did without a lookup', async () => {
      await expect(
        service.validateJwtPayload({ ...devicePayload, did: '' }),
      ).resolves.toBeNull();
      expect(mockPrisma.deviceCode.findUnique).not.toHaveBeenCalled();
    });

    it('still rejects an inactive user on a live device session', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue(liveDeviceCode as any);
      mockPrisma.user.findUnique.mockResolvedValue({
        ...liveUser,
        isActive: false,
      } as any);

      await expect(service.validateJwtPayload(devicePayload)).resolves.toBeNull();
    });
  });

  describe('generateFullTokens — device session link (#518)', () => {
    const user = {
      id: 'user-1',
      email: 'test@example.com',
      userRoles: [{ role: { name: 'viewer' } }],
    };

    it('stamps did and links the refresh token when deviceCodeId is given', async () => {
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      const result = await service.generateFullTokens(user, {
        accessTtlMinutes: 7 * 24 * 60,
        refreshTtlDays: 7,
        deviceCodeId: 'device-code-1',
      });

      expect(result.expiresIn).toBe(7 * 24 * 60 * 60);
      expect(mockJwtService.sign).toHaveBeenCalledWith(
        { sub: 'user-1', email: 'test@example.com', roles: ['viewer'], did: 'device-code-1' },
        { expiresIn: `${7 * 24 * 60}m` },
      );
      expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          tokenHash: expect.any(String),
          expiresAt: expect.any(Date),
          deviceCodeId: 'device-code-1',
        },
      });
    });

    it('leaves an interactive login payload and refresh row without device fields', async () => {
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      await service.generateFullTokens(user);

      const [payload] = mockJwtService.sign.mock.calls[0];
      expect(payload).toEqual({
        sub: 'user-1',
        email: 'test@example.com',
        roles: ['viewer'],
      });
      const { data } = mockPrisma.refreshToken.create.mock.calls[0][0] as any;
      expect(data).not.toHaveProperty('deviceCodeId');
    });
  });

  describe('getEnabledProviders', () => {
    it('should return google provider when configured', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'google.clientId') return 'test-client-id';
        if (key === 'google.clientSecret') return 'test-client-secret';
        return undefined;
      });

      const providers = await service.getEnabledProviders();

      expect(providers).toContainEqual({
        name: 'google',
        enabled: true,
      });
    });

    it('should return empty array when no providers configured', async () => {
      mockConfigService.get.mockReturnValue(undefined);

      const providers = await service.getEnabledProviders();

      expect(providers).toEqual([]);
    });
  });

  describe('getCurrentUser', () => {
    it('should return user details with computed display name', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'test@example.com',
        displayName: null,
        providerDisplayName: 'Provider Name',
        profileImageUrl: null,
        providerProfileImageUrl: 'https://example.com/photo.jpg',
        isActive: true,
        createdAt: new Date(),
        userRoles: [
          {
            role: {
              name: 'viewer',
              rolePermissions: [{ permission: { name: 'user_settings:read' } }],
            },
          },
        ],
      };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser as any);

      const result = await service.getCurrentUser('user-1');

      expect(result.displayName).toBe('Provider Name');
      expect(result.profileImageUrl).toBe('https://example.com/photo.jpg');
      expect(result.roles).toContainEqual({ name: 'viewer' });
      expect(result.permissions).toContain('user_settings:read');
    });

    it('should prefer user display name over provider', async () => {
      // `users.profile_image_url` is deliberately not consulted (#367) —
      // `profileImageUrl` is resolved from `user_settings.profile` instead
      // (see the dedicated "profileImageUrl resolution (#367)" describe
      // block below), so this test only exercises the display-name
      // preference and leaves settings absent.
      const mockUser = {
        id: 'user-1',
        email: 'test@example.com',
        displayName: 'Custom Name',
        providerDisplayName: 'Provider Name',
        providerProfileImageUrl: 'https://provider.com/photo.jpg',
        isActive: true,
        createdAt: new Date(),
        userRoles: [{ role: { name: 'viewer', rolePermissions: [] } }],
      };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser as any);

      const result = await service.getCurrentUser('user-1');

      expect(result.displayName).toBe('Custom Name');
    });

    it('should throw UnauthorizedException for non-existent user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getCurrentUser('non-existent')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('profileImageUrl resolution (#367)', () => {
    const avatarObjectId = '11111111-1111-4111-8111-111111111111';

    function mockUserWithProfile(profile: unknown) {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        displayName: null,
        providerDisplayName: 'Provider Name',
        providerProfileImageUrl: 'https://provider.example.com/pic.jpg',
        isActive: true,
        createdAt: new Date(),
        userRoles: [],
        userSettings: profile === undefined ? null : { value: { profile } },
      } as any);
    }

    it('resolves to null when imageSource is "none"', async () => {
      mockUserWithProfile({ imageSource: 'none', imageObjectId: null });

      const result = await service.getCurrentUser('user-1');

      expect(result.profileImageUrl).toBeNull();
    });

    it('resolves to the provider picture when imageSource is "provider"', async () => {
      mockUserWithProfile({ imageSource: 'provider', imageObjectId: null });

      const result = await service.getCurrentUser('user-1');

      expect(result.profileImageUrl).toBe(
        'https://provider.example.com/pic.jpg',
      );
    });

    it('resolves to the same-origin avatar URL when imageSource is "upload"', async () => {
      mockUserWithProfile({
        imageSource: 'upload',
        imageObjectId: avatarObjectId,
      });

      const result = await service.getCurrentUser('user-1');

      expect(result.profileImageUrl).toBe(
        `/api/users/user-1/avatar/${avatarObjectId}`,
      );
    });

    it('defaults to "provider" when the user has no settings row at all', async () => {
      mockUserWithProfile(undefined);

      const result = await service.getCurrentUser('user-1');

      expect(result.profileImageUrl).toBe(
        'https://provider.example.com/pic.jpg',
      );
    });

    it('always includes the raw providerProfileImageUrl alongside the resolved one', async () => {
      mockUserWithProfile({ imageSource: 'none', imageObjectId: null });

      const result = await service.getCurrentUser('user-1');

      expect(result.providerProfileImageUrl).toBe(
        'https://provider.example.com/pic.jpg',
      );
    });

    // hasUploadedProfileImage (issue #367 follow-up): true whenever an
    // uploaded picture is stored, regardless of which source is currently
    // selected — that's the whole point of exposing a boolean instead of a
    // URL that only resolved while "upload" was selected.
    it('hasUploadedProfileImage is true when imageObjectId is set and imageSource is "provider"', async () => {
      mockUserWithProfile({
        imageSource: 'provider',
        imageObjectId: avatarObjectId,
      });

      const result = await service.getCurrentUser('user-1');

      expect(result.hasUploadedProfileImage).toBe(true);
    });

    it('hasUploadedProfileImage is true when imageSource is "upload" with an imageObjectId', async () => {
      mockUserWithProfile({
        imageSource: 'upload',
        imageObjectId: avatarObjectId,
      });

      const result = await service.getCurrentUser('user-1');

      expect(result.hasUploadedProfileImage).toBe(true);
    });

    it('hasUploadedProfileImage is true when imageSource is "none" but a leftover imageObjectId is still stored', async () => {
      mockUserWithProfile({
        imageSource: 'none',
        imageObjectId: avatarObjectId,
      });

      const result = await service.getCurrentUser('user-1');

      expect(result.hasUploadedProfileImage).toBe(true);
    });

    it('hasUploadedProfileImage is false when imageObjectId is null', async () => {
      mockUserWithProfile({ imageSource: 'provider', imageObjectId: null });

      const result = await service.getCurrentUser('user-1');

      expect(result.hasUploadedProfileImage).toBe(false);
    });

    it('hasUploadedProfileImage is false when the user has no settings row at all', async () => {
      mockUserWithProfile(undefined);

      const result = await service.getCurrentUser('user-1');

      expect(result.hasUploadedProfileImage).toBe(false);
    });
  });

  describe('refreshAccessToken', () => {
    const mockUser = {
      id: 'user-1',
      email: 'test@example.com',
      isActive: true,
      userRoles: [{ role: { name: 'viewer' } }],
    };

    const mockRefreshToken = {
      id: 'token-1',
      userId: 'user-1',
      tokenHash: 'hashed-token',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
      revokedAt: null,
      createdAt: new Date(),
      user: mockUser,
    };

    it('should return new access and refresh tokens with valid refresh token', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(mockRefreshToken as any);
      mockPrisma.refreshToken.update.mockResolvedValue({} as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      const result = await service.refreshAccessToken('valid-token');

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('expiresIn');
      expect(result).toHaveProperty('refreshToken');
      expect(mockJwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user-1',
          email: mockUser.email,
        }),
        expect.objectContaining({ expiresIn: expect.any(String) }),
      );
    });

    it('should throw UnauthorizedException with expired refresh token', async () => {
      const expiredToken = {
        ...mockRefreshToken,
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day ago
      };

      mockPrisma.refreshToken.findUnique.mockResolvedValue(expiredToken as any);

      await expect(service.refreshAccessToken('expired-token')).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.refreshAccessToken('expired-token')).rejects.toThrow(
        'Refresh token has expired',
      );
    });

    it('should throw UnauthorizedException with revoked refresh token', async () => {
      const revokedToken = {
        ...mockRefreshToken,
        revokedAt: new Date(),
      };

      mockPrisma.refreshToken.findUnique.mockResolvedValue(revokedToken as any);
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 0 } as any);

      await expect(service.refreshAccessToken('revoked-token')).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.refreshAccessToken('revoked-token')).rejects.toThrow(
        'Refresh token has been revoked',
      );

      // Should revoke all user tokens (token reuse detection)
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: {
          userId: mockUser.id,
          revokedAt: null,
        },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('should throw UnauthorizedException with non-existent token', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(service.refreshAccessToken('non-existent-token')).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.refreshAccessToken('non-existent-token')).rejects.toThrow(
        'Invalid refresh token',
      );
    });

    it('should throw UnauthorizedException for inactive user', async () => {
      const inactiveUserToken = {
        ...mockRefreshToken,
        user: { ...mockUser, isActive: false },
      };

      mockPrisma.refreshToken.findUnique.mockResolvedValue(inactiveUserToken as any);

      await expect(service.refreshAccessToken('token')).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.refreshAccessToken('token')).rejects.toThrow(
        'User account is deactivated',
      );
    });

    it('should revoke old token and create new one (token rotation)', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(mockRefreshToken as any);
      mockPrisma.refreshToken.update.mockResolvedValue({} as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      await service.refreshAccessToken('valid-token');

      // Old token should be revoked
      expect(mockPrisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 'token-1' },
        data: { revokedAt: expect.any(Date) },
      });

      // New token should be created
      expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith({
        data: {
          userId: mockUser.id,
          tokenHash: expect.any(String),
          expiresAt: expect.any(Date),
        },
      });
    });

    it('should store token as hash (not plaintext)', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(mockRefreshToken as any);
      mockPrisma.refreshToken.update.mockResolvedValue({} as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);

      const plainToken = 'plain-refresh-token';
      await service.refreshAccessToken(plainToken);

      // Verify token was hashed before looking it up
      expect(mockPrisma.refreshToken.findUnique).toHaveBeenCalledWith({
        where: {
          tokenHash: expect.not.stringContaining(plainToken),
        },
        include: expect.any(Object),
      });
    });
  });

  describe('refreshAccessToken — device chain (#518)', () => {
    const mockUser = {
      id: 'user-1',
      email: 'test@example.com',
      isActive: true,
      userRoles: [{ role: { name: 'viewer' } }],
    };

    function deviceToken(
      deviceCode: Partial<{
        userId: string;
        revokedAt: Date | null;
        credentialExpiresAt: Date | null;
      }> | null = {},
      overrides: Record<string, unknown> = {},
    ) {
      return {
        id: 'token-1',
        userId: 'user-1',
        tokenHash: 'hashed-token',
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        revokedAt: null,
        createdAt: new Date(),
        deviceCodeId: 'device-code-1',
        user: mockUser,
        deviceCode:
          deviceCode === null
            ? null
            : {
                id: 'device-code-1',
                userId: 'user-1',
                revokedAt: null,
                credentialExpiresAt: new Date(
                  Date.now() + 3 * 24 * 60 * 60 * 1000,
                ),
                ...deviceCode,
              },
        ...overrides,
      };
    }

    beforeEach(() => {
      mockPrisma.refreshToken.update.mockResolvedValue({} as any);
      mockPrisma.refreshToken.create.mockResolvedValue({} as any);
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 0 } as any);
    });

    it('carries deviceCodeId onto the new row and did into the new access token', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(deviceToken() as any);

      await service.refreshAccessToken('device-refresh');

      expect(mockPrisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 'token-1' },
        data: { revokedAt: expect.any(Date) },
      });
      expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          tokenHash: expect.any(String),
          expiresAt: expect.any(Date),
          deviceCodeId: 'device-code-1',
        },
      });
      expect(mockJwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'user-1', did: 'device-code-1' }),
        expect.objectContaining({ expiresIn: expect.any(String) }),
      );
    });

    it('never extends the chain past credentialExpiresAt', async () => {
      const credentialExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2h left
      mockPrisma.refreshToken.findUnique.mockResolvedValue(
        deviceToken({ credentialExpiresAt }) as any,
      );

      const result = await service.refreshAccessToken('device-refresh');

      // Refresh row: capped at the device credential's expiry, not +14 days.
      const { data } = mockPrisma.refreshToken.create.mock.calls[0][0] as any;
      expect(data.expiresAt.getTime()).toBe(credentialExpiresAt.getTime());

      // Access token: the device TTL (7 days) capped at the ~2h remaining.
      expect(result.expiresIn).toBeGreaterThan(2 * 60 * 60 - 60);
      expect(result.expiresIn).toBeLessThanOrEqual(2 * 60 * 60);
      const [, signOptions] = mockJwtService.sign.mock.calls[0] as any;
      expect(signOptions.expiresIn).toBe(`${result.expiresIn}s`);
    });

    it('uses the device access TTL when the credential outlives it', async () => {
      mockConfigService.get.mockImplementation((key: string, def?: any) => {
        const config: Record<string, any> = {
          'jwt.accessTtlMinutes': 15,
          'jwt.refreshTtlDays': 14,
          'deviceAuth.tokenExpiryDays': 1,
        };
        return config[key] ?? def;
      });
      mockPrisma.refreshToken.findUnique.mockResolvedValue(
        deviceToken({
          credentialExpiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        }) as any,
      );

      const result = await service.refreshAccessToken('device-refresh');

      expect(result.expiresIn).toBe(24 * 60 * 60);
    });

    it('refuses to rotate when the device session was revoked, and revokes the presented token', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(
        deviceToken({ revokedAt: new Date() }) as any,
      );

      await expect(service.refreshAccessToken('device-refresh')).rejects.toThrow(
        'Refresh token has been revoked',
      );

      expect(mockPrisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 'token-1' },
        data: { revokedAt: expect.any(Date) },
      });
      expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
      expect(mockJwtService.sign).not.toHaveBeenCalled();
    });

    it('refuses to rotate when the device credential has expired', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(
        deviceToken({ credentialExpiresAt: new Date(Date.now() - 1000) }) as any,
      );

      await expect(service.refreshAccessToken('device-refresh')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it("refuses to rotate when the linked session belongs to another user", async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(
        deviceToken({ userId: 'other-user' }) as any,
      );

      await expect(service.refreshAccessToken('device-refresh')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('does not sign the user out everywhere when a revoked device session presents its revoked token', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(
        deviceToken({ revokedAt: new Date() }, { revokedAt: new Date() }) as any,
      );

      await expect(service.refreshAccessToken('device-refresh')).rejects.toThrow(
        'Refresh token has been revoked',
      );

      expect(mockPrisma.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('still treats reuse on a LIVE device session as theft (revokes all user tokens)', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(
        deviceToken({}, { revokedAt: new Date() }) as any,
      );

      await expect(service.refreshAccessToken('device-refresh')).rejects.toThrow(
        'Refresh token has been revoked',
      );

      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('keeps an ordinary chain free of device fields', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(
        deviceToken(null, { deviceCodeId: null }) as any,
      );

      await service.refreshAccessToken('plain-refresh');

      const { data } = mockPrisma.refreshToken.create.mock.calls[0][0] as any;
      expect(data).not.toHaveProperty('deviceCodeId');
      const [payload, options] = mockJwtService.sign.mock.calls[0] as any;
      expect(payload).not.toHaveProperty('did');
      expect(options).toEqual({ expiresIn: '15m' });
    });
  });

  describe('logout', () => {
    it('should revoke specific refresh token when provided', async () => {
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 } as any);

      await service.logout('user-1', 'refresh-token');

      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: {
          tokenHash: expect.any(String),
          userId: 'user-1',
        },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('should revoke all tokens when no refresh token provided', async () => {
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 3 } as any);

      await service.logout('user-1');

      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          revokedAt: null,
        },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });

  describe('revokeAllUserTokens', () => {
    it('should revoke all non-revoked tokens for a user', async () => {
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 5 } as any);

      await service.revokeAllUserTokens('user-1');

      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          revokedAt: null,
        },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });

  describe('cleanupExpiredTokens', () => {
    it('should delete expired and revoked tokens', async () => {
      mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 10 } as any);

      const result = await service.cleanupExpiredTokens();

      expect(result).toBe(10);
      expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { expiresAt: { lt: expect.any(Date) } },
            { revokedAt: { not: null } },
          ],
        },
      });
    });

    it('should return 0 when no tokens to cleanup', async () => {
      mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 0 } as any);

      const result = await service.cleanupExpiredTokens();

      expect(result).toBe(0);
    });
  });
});
