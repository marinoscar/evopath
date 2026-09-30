import { Global, Module } from '@nestjs/common';

import { DoctorCheckRegistry } from './doctor-check.registry';
import { DoctorController } from './doctor.controller';
import { DoctorService } from './doctor.service';

// =============================================================================
// DoctorModule (issue #634)
// =============================================================================
//
// `@Global()` so a feature module contributes a check by providing it — the
// check injects `DoctorCheckRegistry` and registers itself — WITHOUT importing
// this module. That keeps every edge one-way: features know the registry,
// the doctor knows no feature. Importing a feature module here instead would
// put the doctor in the middle of every module graph in the application.
//
// This module imports nothing; the checks live in their owning modules, under
// `<module>/doctor/`, and reach their services through those modules' own
// providers.
// =============================================================================

@Global()
@Module({
  controllers: [DoctorController],
  providers: [DoctorCheckRegistry, DoctorService],
  exports: [DoctorCheckRegistry, DoctorService],
})
export class DoctorModule {}
