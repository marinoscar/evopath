import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { IntakeModule } from '../intake/intake.module';
import { JobsModule } from '../jobs/jobs.module';
import { StorageModule } from '../storage/storage.module';
import { CapabilitiesController } from './capabilities.controller';
import { EquipmentTypesController } from './equipment-types.controller';
import { EquipmentTypesService } from './equipment-types.service';
import { GymEquipmentController } from './gym-equipment.controller';
import { GymEquipmentService } from './gym-equipment.service';
import { GymPhotosController } from './gym-photos.controller';
import { GymPhotosService } from './gym-photos.service';
import { GymStorageService } from './gym-storage.service';
import { GymsController } from './gyms.controller';
import { GymsService } from './gyms.service';
import { GymEquipmentIntakeKind } from './intake/gym-equipment.intake-kind';
import { GymPhotoObjectReferences } from './intake/gym-photo-references';
import { EquipmentScanHandler } from './scan/equipment-scan.handler';
import { EquipmentVocabularyService } from './scan/equipment-vocabulary';

/**
 * Gyms (E3.3): the caller's training locations, their equipment and photos,
 * the equipment catalog with custom equipment, and capabilities, all under
 * `gyms:read`/`gyms:write` (photo attach/remove also `storage:write`).
 *
 * `StorageModule` supplies `ObjectsService` (deleting a removed photo's
 * object); `PrismaService` comes from the global `PrismaModule`.
 *
 * "Scan gym" (E3.4): the `gym_equipment` intake kind (`IntakeModule`) and its
 * server-only analyzer job `ai.equipment.scan` (`JobsModule` for the registry,
 * `AiModule` for `AiService`), plus a `StorageObjectReferences` checker so
 * discarding an intake never deletes an object that is a gym photo. The
 * manual routes never touch AI and work with AI off. Exports the services for E4 (capability filters).
 */
@Module({
  imports: [StorageModule, AiModule, JobsModule, IntakeModule],
  controllers: [
    GymsController,
    GymEquipmentController,
    GymPhotosController,
    EquipmentTypesController,
    CapabilitiesController,
  ],
  providers: [
    GymsService,
    GymEquipmentService,
    GymPhotosService,
    GymStorageService,
    EquipmentTypesService,
    EquipmentVocabularyService,
    GymEquipmentIntakeKind,
    GymPhotoObjectReferences,
    EquipmentScanHandler,
  ],
  exports: [GymsService, GymEquipmentService, GymPhotosService, EquipmentTypesService],
})
export class GymsModule {}
