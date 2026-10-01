import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PatService } from '../pat/pat.service';
import { NodeCredentialService } from '../nodes/node-credential.service';
import { AuthLoginDeniedException } from './auth-error-codes';
import { DatabaseSeedException } from '../common/exceptions/database-seed.exception';

describe('AuthController', () => {
  let controller: AuthController;
  let mockAuthService: jest.Mocked<AuthService>;
  let mockConfigService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    mockAuthService = {
      getEnabledProviders: jest.fn(),
      handleGoogleLogin: jest.fn(),
      getCurrentUser: jest.fn(),
      logout: jest.fn(),
    } as any;

    mockConfigService = {
      get: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: PatService, useValue: { validateToken: jest.fn() } },
        // JwtAuthGuard gained a second opaque-bearer dependency in #267
        // (the `nod_` family). Stubbed the same way PatService is: this suite
        // never sends a bearer token, so neither validator is ever reached —
        // the provider exists only so the guard can be constructed.
        { provide: NodeCredentialService, useValue: { validateToken: jest.fn() } },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  describe('googleAuthCallback', () => {
    const APP_URL = 'https://app.example.com';
    const profile = {
      id: 'g-1',
      email: 'person@example.com',
      displayName: 'Person',
    };
    let reply: { redirect: jest.Mock; status: jest.Mock; setCookie: jest.Mock };

    beforeEach(() => {
      reply = {
        redirect: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
        setCookie: jest.fn(),
      };
      mockConfigService.get.mockImplementation((key: string) =>
        key === 'appUrl' ? APP_URL : undefined,
      );
    });

    const callback = (user: unknown = profile) =>
      controller.googleAuthCallback({ user } as any, reply as any);

    const redirectedTo = () => new URL(reply.redirect.mock.calls[0][0]);

    it('redirects with the token on success and no error', async () => {
      mockAuthService.handleGoogleLogin.mockResolvedValue({
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresIn: 900,
      });

      await callback();

      const url = redirectedTo();
      expect(url.pathname).toBe('/auth/callback');
      expect(url.searchParams.get('token')).toBe('access');
      expect(url.searchParams.has('error')).toBe(false);
    });

    it.each([
      [
        'not_allowlisted',
        new AuthLoginDeniedException('not_allowlisted', 'Your email is not authorized'),
      ],
      [
        'account_disabled',
        new AuthLoginDeniedException('account_disabled', 'User account is disabled'),
      ],
      ['server_misconfigured', new DatabaseSeedException('roles')],
      ['authentication_failed', new Error('something unexpected')],
    ])('redirects with error=%s', async (code, thrown) => {
      mockAuthService.handleGoogleLogin.mockRejectedValue(thrown);

      await callback();

      const url = redirectedTo();
      expect(url.origin + url.pathname).toBe(`${APP_URL}/auth/callback`);
      expect(url.searchParams.get('error')).toBe(code);
      expect(url.searchParams.has('token')).toBe(false);
    });

    it('never puts the exception message in the redirect', async () => {
      mockAuthService.handleGoogleLogin.mockRejectedValue(
        new Error('Call 555-0100 to restore access'),
      );

      await callback();

      const target = reply.redirect.mock.calls[0][0] as string;
      expect(target).not.toContain('555');
      expect(target).not.toContain('restore');
    });

    it('redirects with authentication_failed when the guard attached no profile', async () => {
      await callback(null);

      expect(redirectedTo().searchParams.get('error')).toBe('authentication_failed');
      expect(mockAuthService.handleGoogleLogin).not.toHaveBeenCalled();
    });
  });

  describe('getProviders', () => {
    it('should return enabled providers', async () => {
      const providers = [{ name: 'google', enabled: true }];
      mockAuthService.getEnabledProviders.mockResolvedValue(providers);

      const result = await controller.getProviders();

      expect(result).toEqual({
        data: {
          providers,
        },
      });
    });
  });

  describe('getCurrentUser', () => {
    it('should return current user details', async () => {
      const userDetails = {
        id: 'user-1',
        email: 'test@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        isActive: true,
        roles: [{ name: 'viewer' }],
        permissions: ['user_settings:read'],
      };
      mockAuthService.getCurrentUser.mockResolvedValue(userDetails as any);

      const requestUser = { id: 'user-1', email: 'test@example.com' };
      const result = await controller.getCurrentUser(requestUser as any);

      expect(result).toEqual({
        data: userDetails,
      });
      expect(mockAuthService.getCurrentUser).toHaveBeenCalledWith('user-1');
    });
  });

  describe('logout', () => {
    it('should call auth service logout and return void', async () => {
      mockAuthService.logout.mockResolvedValue(undefined);

      const requestUser = { id: 'user-1', email: 'test@example.com' };
      const mockReq = { cookies: {} } as any;
      const mockRes = { clearCookie: jest.fn() } as any;

      const result = await controller.logout(requestUser as any, mockReq, mockRes);

      expect(result).toBeUndefined();
      expect(mockAuthService.logout).toHaveBeenCalledWith('user-1', undefined);
      expect(mockRes.clearCookie).toHaveBeenCalled();
    });
  });
});
