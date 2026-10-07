// =============================================================================
// /api/admin/doctor: is every capability configured and healthy? (issue #634)
// =============================================================================
//
// The Doctor framework comes from `@marinoscar/platform-api/doctor`
// (marinoscar/EnterpriseAppBase#717): the check contract, the registry, the
// service, the DTOs and the controller. This file is the app's whole binding:
// ONE `DoctorModule.forRoot()` call. The checks stay in their owning feature
// modules, under `<module>/doctor/`, and register themselves with
// `DoctorCheckRegistry` from their own `onModuleInit`. Platform code: never
// edit the package here (CLAUDE.md, "Platform code lives in packages").
//
// ⚠ IT GATES ON THE EXISTING `system_settings:read` (the package default,
// `DEFAULT_DOCTOR_PERMISSION`; see docs/specs/doctor.md §2.6). The report
// describes the deployment's configuration, which is exactly the blast radius
// `system_settings:read` already covers, and every check is read-only. No
// `doctor:read` is invented, and no `permission` is passed below.
//
// ⚠ THE STRING IS HALF OF A CROSS-APP CONTRACT (CLAUDE.md, Settings UI Pattern
// rule 3): the web Doctor card (`apps/web/src/config/adminSections.tsx`) and
// route (`apps/web/src/App.tsx`) declare the same literal.
//
// The access check is the app's own `@Auth()`, applied through the platform
// host (`./platform-host.ts`): same guards, same RBAC metadata, same `x-rbac`
// OpenAPI extension as any controller of the app.
//
// The category order is the package default (`PLATFORM_DOCTOR_CATEGORIES`);
// this app's own `android` category sorts after it, in registration order,
// exactly as before the adoption.
// =============================================================================

import { DoctorModule } from '@marinoscar/platform-api/doctor';

import { platformHost } from './platform-host';

/** `GET /api/admin/doctor`, gated on `system_settings:read` (the package default). */
export const doctorModule = DoctorModule.forRoot({ host: platformHost });
