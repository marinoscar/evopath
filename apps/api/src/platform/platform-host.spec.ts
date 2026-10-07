import 'reflect-metadata';

import { Controller, Get } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';

import { RBAC_EXTENSION_KEY } from '../auth/decorators/auth.decorator';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { doctorModule } from './doctor.config';
import { platformHost } from './platform-host';

describe('platformHost (the app access port)', () => {
  @Controller('probe')
  class ProbeController {
    @Get('settings')
    @(platformHost.access.requirePermissions(['system_settings:read']))
    settings() {
      return null;
    }

    @Get('me')
    @(platformHost.access.requireAuthenticated())
    me() {
      return null;
    }
  }

  it("requirePermissions applies the app's @Auth: the guard stack and the permissions metadata", () => {
    const handler = ProbeController.prototype.settings;

    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([JwtAuthGuard, RolesGuard, PermissionsGuard]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual(['system_settings:read']);
  });

  it('requireAuthenticated applies @Auth() with no permission', () => {
    const handler = ProbeController.prototype.me;

    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([JwtAuthGuard, RolesGuard, PermissionsGuard]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toBeUndefined();
  });

  it('stamps the x-rbac OpenAPI extension the document builder renders', () => {
    const extensions = Reflect.getMetadata('swagger/apiExtension', ProbeController.prototype.settings);

    expect(extensions?.[RBAC_EXTENSION_KEY]).toEqual({
      authenticated: true,
      roles: [],
      permissions: ['system_settings:read'],
    });
  });

  it('is frozen and refuses a permission gate with no permission', () => {
    expect(Object.isFrozen(platformHost)).toBe(true);
    expect(() => platformHost.access.requirePermissions([])).toThrow(/no permission/);
  });
});

describe('doctorModule (the Doctor binding)', () => {
  it('is global and gates GET /api/admin/doctor on system_settings:read through the app guards', () => {
    const [controller] = doctorModule.controllers as Array<{ prototype: { getReport: object } }>;

    expect(doctorModule.global).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, controller.prototype.getReport)).toEqual([
      JwtAuthGuard,
      RolesGuard,
      PermissionsGuard,
    ]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, controller.prototype.getReport)).toEqual(['system_settings:read']);
  });
});
