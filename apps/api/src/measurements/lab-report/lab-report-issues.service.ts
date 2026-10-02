import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import type { LabReportIssue, LabReportIssues } from './dto/lab-report-issues.dto';
import { labApplyIssues } from './lab-report-issues';
import { LAB_REPORT_KIND, labReportContextSchema } from './lab-report.value';

// =============================================================================
// What apply would refuse, per result, for a lab report under review (#317)
// =============================================================================
//
// `GET /api/measurements/lab-reports/:intakeId/issues`: the review badges
// each row that would block Save BEFORE the user presses it. Every result
// that is not rejected (pending or accepted) is checked as if all of them
// were accepted, with `labApplyIssues`, the very function `apply` runs on
// the accepted ones. A `DATE_CAP` issue (one per over-full date) is listed on
// each result of that date. Only results with an issue are returned, in
// review order (`sortOrder`, then `createdAt`).
//
// Owner-scoped: another user's intake (or one of another kind) is a 404.
// Read-only; nothing is logged (names and values never reach a log line).
// =============================================================================

@Injectable()
export class LabReportIssuesService {
  constructor(private readonly prisma: PrismaService) {}

  async find(userId: string, intakeId: string): Promise<LabReportIssues> {
    const intake = await this.prisma.photoIntake.findFirst({
      where: { id: intakeId, userId, kind: LAB_REPORT_KIND },
      select: { id: true, context: true },
    });
    if (!intake) throw new NotFoundException('Intake not found');

    const parsedContext = labReportContextSchema.safeParse(intake.context ?? undefined);
    const context = parsedContext.success ? parsedContext.data : undefined;

    const items = await this.prisma.draftItem.findMany({
      where: { intakeId, status: { not: 'rejected' } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, kind: true, value: true },
    });

    const byItem = new Map<string, LabReportIssue[]>();
    for (const { code, itemIds, field, message } of labApplyIssues(items, context).issues) {
      for (const itemId of itemIds) {
        byItem.set(itemId, [...(byItem.get(itemId) ?? []), { code, field, message }]);
      }
    }

    return {
      items: items.flatMap(({ id }) => {
        const issues = byItem.get(id);
        return issues ? [{ itemId: id, issues }] : [];
      }),
    };
  }
}
