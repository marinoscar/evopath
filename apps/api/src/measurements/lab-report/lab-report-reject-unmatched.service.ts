import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { stateConflict, toDraftItemView } from '../../intake/intake.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { LabReportRejectUnmatched } from './dto/lab-report-reject-unmatched.dto';
import { LAB_REPORT_ITEM_KIND, LAB_REPORT_KIND, labReportValueSchema } from './lab-report.value';

// =============================================================================
// Reject every unmatched result of a lab report at once (#311)
// =============================================================================
//
// A portal report prints analytes the catalog does not know (and the user
// does not want to map one by one). `POST /api/measurements/lab-reports/
// :intakeId/reject-unmatched` rejects, in one call, every `result` item of
// the intake that
//   - is not already `rejected`, and
//   - is UNMATCHED: its value has `analyteKey === null`. A "suggested" result
//     carries a key and is not touched, nor is a matched or user-mapped one.
//     A stored value the kind's schema refuses is left alone.
//
// A REJECTION LIKE THE USER'S. Each is written as `PATCH /api/intakes/:id/
// items/:itemId` `{ status: 'rejected' }` writes it: only `status` changes
// (value, `userVerified` and `originalAiValue` are kept), so the review's
// restore (the same PATCH with `{ status: 'pending' }`) works on it.
//
// ONE TRANSACTION. The intake row is locked first (`FOR UPDATE`) and its
// status re-checked, as the map route does, so an `apply` sees every
// rejection or none.
//
// Owner-scoped: another user's intake, or one of another kind, is a 404. The
// intake must be editable as the item PATCH requires (not `applied`: 409).
// Returns the items it rejected (`{ items: [] }` when there was none).
// Nothing is logged: names and values never reach a log line.
// =============================================================================

@Injectable()
export class LabReportRejectUnmatchedService {
  constructor(private readonly prisma: PrismaService) {}

  async rejectUnmatched(userId: string, intakeId: string): Promise<LabReportRejectUnmatched> {
    const owned = await this.prisma.photoIntake.findFirst({
      where: { id: intakeId, userId, kind: LAB_REPORT_KIND },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException('Intake not found');

    return this.prisma.$transaction(async (tx) => {
      // The lock: a concurrent apply (whose status flip updates this row) waits for us, or we for it.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM photo_intakes WHERE id = ${intakeId}::uuid FOR UPDATE`);

      const intake = await tx.photoIntake.findFirst({ where: { id: intakeId, userId, kind: LAB_REPORT_KIND } });
      if (!intake) throw new NotFoundException('Intake not found');
      if (intake.status === 'applied') throw stateConflict(intake.status, 'edit items of');

      const items = await tx.draftItem.findMany({
        where: { intakeId, kind: LAB_REPORT_ITEM_KIND, status: { not: 'rejected' } },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });

      const ids = items
        .filter((item) => {
          const parsed = labReportValueSchema.safeParse(item.value);
          return parsed.success && parsed.data.analyteKey === null;
        })
        .map((item) => item.id);
      if (ids.length === 0) return { items: [] };

      // As the item PATCH writes `{ status: 'rejected' }`: status only.
      await tx.draftItem.updateMany({
        where: { id: { in: ids }, intakeId, status: { not: 'rejected' } },
        data: { status: 'rejected' },
      });

      const rejected = await tx.draftItem.findMany({
        where: { id: { in: ids }, intakeId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
      return { items: rejected.map(toDraftItemView) };
    });
  }
}
