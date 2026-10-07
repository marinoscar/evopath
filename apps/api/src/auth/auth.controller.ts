import {
  Controller,
  Get,
  Post,
  UseGuards,
  UseFilters,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseSeedException } from '@marinoscar/platform-api/core';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthService } from './auth.service';
import {
  buildAuthErrorRedirectUrl,
  resolveAuthErrorCode,
} from './auth-error-codes';
import { GoogleOAuthGuard } from './guards/google-oauth.guard';
import { GoogleOAuthExceptionFilter } from './filters/google-oauth-exception.filter';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { RequestUser } from './interfaces/authenticated-user.interface';
import { GoogleProfile } from './strategies/google.strategy';
import {
  AuthProvidersResponseDto,
  AuthProviderDto,
} from './dto/auth-provider.dto';
import { CurrentUserDto } from './dto/auth-user.dto';
import { AllowDuringMaintenance } from '../common/maintenance/allow-during-maintenance.decorator';

const REFRESH_TOKEN_COOKIE = 'refresh_token';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/api/auth',
  maxAge: 14 * 24 * 60 * 60, // 14 days in seconds (cookie spec uses seconds)
};

/**
 * REACHABLE DURING A MAINTENANCE WINDOW, as a whole controller (#257).
 *
 * The exemption is class-level rather than route-by-route because every route
 * on it is one of four things a window must not break:
 *
 *   * `providers`, `google`, `google/callback` — SIGNING IN. A window in which
 *     nobody can sign in is a window nobody can end: `allowAdmins` is worth
 *     nothing to an administrator who cannot obtain a token, and the only way
 *     back would be the environment break-glass and a restart.
 *   * `refresh` — STAYING signed in. An access token is minutes long; a window
 *     that outlives one would evict the very admin who opened it.
 *   * `me` — the identity lookup the maintenance page itself needs, to decide
 *     whether the person looking at it is an admin who can carry on.
 *   * `logout` / `logout-all` — signing OUT must never be the thing that is
 *     unavailable. A user who wants their session ended during an incident is
 *     entitled to have it ended.
 *
 * Note this is REACHABILITY only: `@Auth()` and `@Public()` still decide who
 * may call what, exactly as they do outside a window.
 */
@ApiTags('Authentication')
@Controller('auth')
@AllowDuringMaintenance()
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * GET /auth/providers
   * Returns list of enabled OAuth providers
   */
  @Public()
  @Get('providers')
  @ApiOperation({
    summary: 'List enabled OAuth providers',
    description: 'Returns a list of OAuth providers that are configured and enabled',
  })
  @ApiResponse({
    status: 200,
    description: 'List of enabled providers',
    type: AuthProvidersResponseDto,
  })
  async getProviders(): Promise<{ data: { providers: AuthProviderDto[] } }> {
    const providers = await this.authService.getEnabledProviders();
    return {
      data: {
        providers,
      },
    };
  }

  /**
   * GET /auth/google
   * Initiates Google OAuth flow
   */
  @Public()
  @Get('google')
  @UseGuards(GoogleOAuthGuard)
  @ApiOperation({
    summary: 'Initiate Google OAuth',
    description:
      'Redirects to Google OAuth consent screen. Pass select_account=1 to make Google show its account chooser instead of re-using the signed-in account.',
  })
  @ApiQuery({
    name: 'select_account',
    required: false,
    description:
      'Set to 1 to forward prompt=select_account to Google so the person can pick a different account. Any other value is ignored.',
    schema: { type: 'string', enum: ['1'] },
  })
  @ApiResponse({
    status: 302,
    description: 'Redirects to Google OAuth',
  })
  async googleAuth() {
    // Guard handles the redirect to Google
  }

  /**
   * GET /auth/google/callback
   * Google OAuth callback endpoint
   */
  @Public()
  @Get('google/callback')
  @UseGuards(GoogleOAuthGuard)
  // Callback route only: guard failures run before the method body, so its
  // try/catch never sees them (#652).
  @UseFilters(GoogleOAuthExceptionFilter)
  @ApiOperation({
    summary: 'Google OAuth callback',
    description:
      'Handles the OAuth callback from Google and redirects to the frontend /auth/callback page: with the access token on success, or with error=<code> on any failure.',
  })
  @ApiResponse({
    status: 302,
    description:
      'Redirects to frontend with the token in query params, or with error set to one of not_allowlisted, account_disabled, access_denied, authentication_failed, server_misconfigured',
  })
  async googleAuthCallback(
    @Req() req: FastifyRequest & { user?: GoogleProfile },
    @Res() res: FastifyReply,
  ) {
    try {
      // Google profile is attached by the guard
      const profile = req.user;

      if (!profile) {
        this.logger.error('No profile found in Google OAuth callback');
        return res.redirect(
          buildAuthErrorRedirectUrl(
            this.configService.get<string>('appUrl'),
            'authentication_failed',
          ),
        );
      }

      // Handle login and generate tokens
      const tokens = await this.authService.handleGoogleLogin(profile);

      // Set refresh token in HttpOnly cookie
      this.logger.log(`Setting refresh token cookie with options: ${JSON.stringify(COOKIE_OPTIONS)}`);
      res.setCookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken!, COOKIE_OPTIONS);

      // Redirect to frontend with access token only
      const appUrl = this.configService.get<string>('appUrl');
      const redirectUrl = new URL('/auth/callback', appUrl);
      redirectUrl.searchParams.set('token', tokens.accessToken);
      redirectUrl.searchParams.set('expiresIn', tokens.expiresIn.toString());

      this.logger.log(`Redirecting to: ${redirectUrl.toString()}`);
      return res.status(302).redirect(redirectUrl.toString());
    } catch (error) {
      // Log with full context for debugging
      if (error instanceof DatabaseSeedException) {
        this.logger.error(
          'Database seed error during OAuth callback - seeds have not been run',
          {
            error: error.message,
            stack: error.stack,
          },
        );
      } else {
        this.logger.error('Error in Google OAuth callback', error);
      }

      // Closed set of codes only (#652): the exception's message never
      // reaches the redirect, so the callback page cannot be made to show
      // attacker-chosen text.
      return res.redirect(
        buildAuthErrorRedirectUrl(
          this.configService.get<string>('appUrl'),
          resolveAuthErrorCode(error),
        ),
      );
    }
  }

  /**
   * GET /auth/me
   * Returns current authenticated user information
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Get current user',
    description: 'Returns information about the currently authenticated user',
  })
  @ApiResponse({
    status: 200,
    description: 'Current user information',
    type: CurrentUserDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - invalid or missing token',
  })
  async getCurrentUser(
    @CurrentUser() user: RequestUser,
  ): Promise<{ data: CurrentUserDto }> {
    const currentUser = await this.authService.getCurrentUser(user.id);
    return {
      data: currentUser,
    };
  }

  /**
   * POST /auth/refresh
   * Refresh access token using refresh token from cookie
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh access token',
    description: 'Exchanges a refresh token for a new access token',
  })
  @ApiResponse({
    status: 200,
    description: 'New access token',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid or expired refresh token',
  })
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE];

    if (!refreshToken) {
      throw new UnauthorizedException('No refresh token provided');
    }

    const tokens = await this.authService.refreshAccessToken(refreshToken);

    // Set new refresh token in cookie (rotation)
    res.setCookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken!, COOKIE_OPTIONS);

    // Return new access token
    return {
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
    };
  }

  /**
   * POST /auth/logout
   * Logout current user and revoke refresh token
   */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Logout',
    description: 'Logout endpoint and revoke refresh token',
  })
  @ApiResponse({
    status: 204,
    description: 'Logout successful',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - invalid or missing token',
  })
  async logout(
    @CurrentUser() user: RequestUser,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<void> {
    const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE];

    await this.authService.logout(user.id, refreshToken);

    // Clear refresh token cookie
    res.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/api/auth' });

    this.logger.log(`User logged out: ${user.email}`);
  }

  /**
   * POST /auth/logout-all
   * Logout from all devices by revoking all refresh tokens
   */
  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Logout from all devices',
    description: 'Revoke all refresh tokens for the current user',
  })
  @ApiResponse({
    status: 204,
    description: 'All tokens revoked successfully',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - invalid or missing token',
  })
  async logoutAll(
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<void> {
    await this.authService.revokeAllUserTokens(user.id);

    // Clear refresh token cookie
    res.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/api/auth' });

    this.logger.log(`User logged out from all devices: ${user.email}`);
  }
}
