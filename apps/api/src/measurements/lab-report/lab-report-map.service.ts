import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { type DraftItem, Prisma } from '@prisma/client';

import { stateConflict, toDraftItemView, IntakeService } from '../../intake/intake.service';
import { PrismaService } from '../../prisma/prisma.service';
import { foldAnalyteName } from '../metric-registry';
import type { LabResultMap, MapLabResultInput } from './dto/lab-report-map.dto';
import { LAB_REPORT_ITEM_KIND, LAB_REPORT_KIND, labReportValueSchema, type LabReportValue } from './lab-report.value';

// =============================================================================
// Map once, apply to every same-named result (#307)
// =============================================================================
//
// A trend report prints the same analyte once per collection date, so an
// analyte the catalog could not resolve ("Chol/HDL Ratio" before #307) comes
// back as N unmatched results with one printed name. Mapping one maps them
// all: `POST /api/measurements/lab-reports/:intakeId/map` with
// `{ itemId, analyteKey }`.
//
// TARGETS. The clicked item, always, plus every other `result` item of the
// intake whose printed name folds (`foldAnalyteName`) to the same non-empty
// name, that is not `rejected`, and that the user has not already mapped to
// a DIFFERENT analyte (a user-edited item, i.e. user-added or carrying
// `originalAiValue`, whose `analyteKey` is set and differs).
//
// EACH TARGET is written as `PATCH /api/intakes/:id/items/:itemId` would
// write `{ value: { ...value, analyteKey } }`: validated and normalised by
// `IntakeService.validateUserValue` (the kind's schema and its
// `normalizeValue(..., 'user')`: canonical conversion, `match` recomputed),
// `userVerified` set, the FIRST edit of an AI item keeping `originalAiValue`.
// `status` is untouched (pending stays pending). When that validation refuses
// a target (e.g. a unit the analyte does not allow), the target is left
// unchanged and listed in `skipped`; when it refuses the CLICKED item, the
// call answers that 400, as the PATCH would.
//
// ONE TRANSACTION. The intake row is locked first (`FOR UPDATE`) and its
// status re-checked, so an `apply` either sees every mapping or none; items
// are read and written under that lock.
//
// Owner-scoped: another user's intake, or one of another kind, is a 404. The
// intake must be editable as the item PATCH requires (not `applied`: 409).
// Nothing is logged: names and values never reach a log line.
// =============================================================================

@Injectable()
export class LabReportMapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly intakes: IntakeService,
  ) {}

  async map(userId: string, intakeId: string, input: MapLabResultInput): Promise<LabResultMap> {
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
        where: { intakeId, kind: LAB_REPORT_ITEM_KIND },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });

      const clicked = items.find((item) => item.id === input.itemId);
      if (!clicked) throw new NotFoundException('Draft item not found');

      const targets = sameNamedTargets(items, clicked, input.analyteKey);
      const updated: DraftItem[] = [];
      const skipped: LabResultMap['skipped'] = [];

      for (const { item, value } of targets) {
        let next: unknown;
        try {
          next = await this.intakes.validateUserValue(intake, { ...value, analyteKey: input.analyteKey });
        } catch (error) {
          if (item.id === clicked.id || !(error instanceof BadRequestException)) throw error;
          skipped.push({ itemId: item.id, message: refusalMessage(error) });
          continue;
        }

        if (item.origin === 'ai') {
          // Write-once, as the item PATCH: only while `original_ai_value` IS NULL.
          await tx.draftItem.updateMany({
            where: { id: item.id, intakeId, originalAiValue: { equals: Prisma.DbNull } },
            data: { originalAiValue: item.value as Prisma.InputJsonValue },
          });
        }

        updated.push(
          await tx.draftItem.update({
            where: { id: item.id },
            data: { value: next as Prisma.InputJsonValue, userVerified: true },
          }),
        );
      }

      return { items: updated.map(toDraftItemView), skipped };
    });
  }
}

interface Target {
  item: DraftItem;
  /** The stored value, parsed; the clicked item's raw value when it does not parse (the PATCH path refuses it). */
  value: LabReportValue | Record<string, unknown>;
}

/** The clicked item first, then the other same-named, mappable items in review order. */
function sameNamedTargets(items: readonly DraftItem[], clicked: DraftItem, analyteKey: string): Target[] {
  const parsedClicked = labReportValueSchema.safeParse(clicked.value);
  const clickedValue = parsedClicked.success ? parsedClicked.data : ((clicked.value ?? {}) as Record<string, unknown>);
  const name = parsedClicked.success && parsedClicked.data.nameAsPrinted ? foldAnalyteName(parsedClicked.data.nameAsPrinted) : '';

  const targets: Target[] = [{ item: clicked, value: clickedValue }];
  if (name === '') return targets;

  for (const item of items) {
    if (item.id === clicked.id || item.status === 'rejected') continue;

    const parsed = labReportValueSchema.safeParse(item.value);
    if (!parsed.success || !parsed.data.nameAsPrinted) continue;
    if (foldAnalyteName(parsed.data.nameAsPrinted) !== name) continue;
    if (userMappedElsewhere(item, parsed.data, analyteKey)) continue;

    targets.push({ item, value: parsed.data });
  }

  return targets;
}

/** A result the user already set to another analyte: user-added, or an AI item the user edited. */
function userMappedElsewhere(item: DraftItem, value: LabReportValue, analyteKey: string): boolean {
  const userEdited = item.origin === 'user' || (item.originalAiValue !== null && item.originalAiValue !== undefined);
  return userEdited && value.analyteKey !== null && value.analyteKey !== analyteKey;
}

/** The rule(s) a refused target breaks, from the 400 the PATCH path threw (never a value). */
function refusalMessage(error: BadRequestException): string {
  const body = error.getResponse() as { message?: unknown; details?: { issues?: Array<{ message?: unknown }> } };
  const issues = (body.details?.issues ?? []).map((issue) => issue.message).filter((m): m is string => typeof m === 'string');
  if (issues.length > 0) return issues.join('; ');
  return typeof body.message === 'string' ? body.message : 'The result could not be mapped';
}
