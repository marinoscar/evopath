import { Module } from '@nestjs/common';

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

/**
 * Gyms (E3.3): the caller's training locations, their equipment and photos,
 * the equipment catalog with custom equipment, and capabilities, all under
 * `gyms:read`/`gyms:write` (photo attach/remove also `storage:write`).
 *
 * `StorageModule` supplies `ObjectsService` (deleting a removed photo's
 * object); `PrismaService` comes from the global `PrismaModule`. No AI import:
 * the manual path works with AI off. Exports the services for E3.4 (scan apply)
 * and E4 (capability filters).
 */
@Module({
  imports: [StorageModule],
  controllers: [
    GymsController,
    GymEquipmentController,
    GymPhotosController,
    EquipmentTypesController,
    CapabilitiesController,
  ],
  providers: [GymsService, GymEquipmentService, GymPhotosService, GymStorageService, EquipmentTypesService],
  exports: [GymsService, GymEquipmentService, GymPhotosService, EquipmentTypesService],
})
export class GymsModule {}
