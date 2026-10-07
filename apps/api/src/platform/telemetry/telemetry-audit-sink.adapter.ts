// =============================================================================
// TELEMETRY_AUDIT_SINK adapter: telemetry's audit events into audit_events
// (marinoscar/EnterpriseAppBase#703, PP-4.2)
// =============================================================================
//
// Same columns and the same Prisma delegate the telemetry services wrote
// before the slice moved into `@marinoscar/platform-api/telemetry`, so a row
// written through this port is identical to one written before. `meta` is
// JSON (telemetry's rows carry field-name arrays and request parameters),
// which is why the core `AUDIT_SINK` (scalar `meta`) is not reused.
// =============================================================================

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { TelemetryAuditEvent, TelemetryAuditSink } from '@marinoscar/platform-api/telemetry';

@Injectable()
export class TelemetryAuditSinkAdapter implements TelemetryAuditSink {
  constructor(private readonly prisma: PrismaService) {}

  async record(event: TelemetryAuditEvent): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: event.actorUserId,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        ...(event.meta === undefined ? {} : { meta: event.meta as Prisma.InputJsonValue }),
      },
    });
  }
}
