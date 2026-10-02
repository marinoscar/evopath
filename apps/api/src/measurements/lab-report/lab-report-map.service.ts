import { isDeepStrictEqual } from 'node:util';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { type DraftItem, Prisma } from '@prisma/client';

import { stateConflict, toDraftItemView, IntakeService } from '../../intake/intake.service';
import { PrismaService } from '../../prisma/prisma.service';
import { foldAnalyteName, fromCanonical, getMetric, MetricRegistryError, toCanonical, unitFor } from '../metric-registry';
import type { LabResultMap, MapLabResultInput } from './dto/lab-report-map.dto';
import { LAB_REPORT_ITEM_KIND, LAB_REPORT_KIND, labReportValueSchema, type LabReportValue } from './lab-report.value';

// =============================================================================
// Map once, apply to every same-named result (#307)
// =============================================================================
//
// A trend report prints the same analyte once per collection date, so a
// correction the user makes to one result (an analyte the catalog could not
// resolve, a unit the model misread) usually holds for all of them.
// `POST /api/measurements/lab-reports/:intakeId/map` with
// `{ itemId, analyteKey?, unit? }` (at least one) applies it to every
// same-named result. The web calls it AFTER a successful item PATCH, with
// the new values, so the clicked item is usually already corrected: it is
// then a no-op for that item (still listed in `items`).
//
// SAME-NAMED. Another `result` item of the intake whose printed name folds
// (`foldAnalyteName`) to the clicked item's non-empty folded name and that is
// not `rejected`. A clicked item without a printed name has no siblings.
//
// ANALYTE (`analyteKey`). Targets: the clicked item, plus every same-named
// item the user has not already mapped to a DIFFERENT analyte (a user-edited
// item, i.e. user-added or carrying `originalAiValue`, whose `analyteKey` is
// set and differs). Each gets `{ ...value, analyteKey }`.
//
// UNIT (`unit`), after the analyte step. Targets: the clicked item, plus every
// same-named item that
//   - has the clicked item's analyte (as it stands after the analyte step;
//     both unmatched also counts),
//   - was PRINTED with the same unit as the clicked item. The printed unit is
//     the one the model read: `originalUnit ?? unit` of `originalAiValue`
//     (the AI's value, kept by the first user edit), else of the current
//     value. So a PATCH that already changed the clicked item does not hide
//     what its siblings were read as;
//   - still means what was printed: its value is its printed number
//     (`originalValue`) in its printed unit. A sibling whose unit (or number)
//     the user already changed is left alone.
// Each is REINTERPRETED: its printed number (and its reference limits, taken
// back to the printed unit) read in `unit`, then converted to canonical by
// the normal path. An item whose value already reads as its printed number in
// `unit` (the clicked item after the web's PATCH) is unchanged.
//
// WRITES. Every changed item is written as `PATCH /api/intakes/:id/items/
// :itemId` would write its new value: validated and normalised by
// `IntakeService.validateUserValue` (the kind's schema, then its
// `normalizeValue(..., 'user')`: canonical conversion, bounds, `match`
// recomputed), `userVerified` set, the FIRST edit of an AI item keeping
// `originalAiValue`; `status` untouched (pending stays pending). A result
// whose new value equals the stored one is not written (the clicked item is
// still listed in `items`, a sibling is not). A sibling
// that validation refuses at either step is left entirely unchanged and
// listed in `skipped` (the rule broken, never the value); a refusal of the
// CLICKED item is the 400 the PATCH would answer.
//
// ONE TRANSACTION. The intake row is locked first (`FOR UPDATE`) and its
// status re-checked, so an `apply` either sees every change or none; items
// are read and written under that lock.
//
// Owner-scoped: another user's intake, or one of another kind, is a 404. The
// intake must be editable as the item PATCH requires (not `applied`: 409).
// Nothing is logged: names and values never reach a log line.
// =============================================================================

type Value = LabReportValue;

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

      const parsedClicked = labReportValueSchema.safeParse(clicked.value);
      if (!parsedClicked.success) {
        // A stored value the schema refuses: the PATCH path answers its 400.
        await this.intakes.validateUserValue(intake, { ...(clicked.value as object), ...changesOf(input) });
        throw new BadRequestException('The result could not be mapped');
      }

      const plan = new Plan(clicked, parsedClicked.data, sameNamed(items, clicked, parsedClicked.data));
      const validate = (raw: Value) => this.intakes.validateUserValue(intake, raw) as Promise<Value>;

      if (input.analyteKey !== undefined) await this.mapAnalyte(plan, input.analyteKey, validate);
      if (input.unit !== undefined) await this.changeUnit(plan, input.unit, validate);

      const written: DraftItem[] = [];
      for (const { item } of plan.ordered(items)) {
        const next = plan.changed.get(item.id);
        if (next === undefined) {
          if (item.id === clicked.id) written.push(clicked);
          continue;
        }
        written.push(await writeLikePatch(tx, intakeId, item, next));
      }

      return { items: written.map(toDraftItemView), skipped: plan.skipped };
    });
  }

  private async mapAnalyte(plan: Plan, analyteKey: string, validate: (raw: Value) => Promise<Value>) {
    const targets = [plan.clickedEntry, ...plan.siblings.filter(({ item, value }) => !userMappedElsewhere(item, value, analyteKey))];

    for (const target of targets) {
      await plan.apply(target, { ...plan.current(target), analyteKey }, validate);
    }
  }

  private async changeUnit(plan: Plan, unit: string, validate: (raw: Value) => Promise<Value>) {
    const clickedNow = plan.current(plan.clickedEntry);
    const clickedPrinted = printedUnitOf(plan.clickedEntry.item, plan.clickedEntry.value);

    const siblings = plan.siblings.filter((entry) => {
      if (plan.isSkipped(entry.item.id)) return false;
      const now = plan.current(entry);
      return (
        now.analyteKey === clickedNow.analyteKey &&
        sameUnit(printedUnitOf(entry.item, entry.value), clickedPrinted) &&
        readsAsPrinted(now)
      );
    });

    for (const target of [plan.clickedEntry, ...siblings]) {
      const now = plan.current(target);
      if (readsIn(now, unit)) continue;
      await plan.apply(target, reinterpret(now, unit), validate);
    }
  }
}

interface Entry {
  item: DraftItem;
  /** The stored value, parsed. */
  value: Value;
}

/** The changes collected for one call: new values by item, and the siblings left alone. */
class Plan {
  readonly clickedEntry: Entry;
  readonly changed = new Map<string, Value>();
  readonly skipped: LabResultMap['skipped'] = [];

  constructor(
    clicked: DraftItem,
    clickedValue: Value,
    readonly siblings: Entry[],
  ) {
    this.clickedEntry = { item: clicked, value: clickedValue };
  }

  current(entry: Entry): Value {
    return this.changed.get(entry.item.id) ?? entry.value;
  }

  isSkipped(itemId: string): boolean {
    return this.skipped.some((skip) => skip.itemId === itemId);
  }

  /**
   * Validates `raw` for `entry`; a result equal to the stored value is no
   * change. A sibling's refusal is recorded (and its earlier change dropped).
   */
  async apply(entry: Entry, raw: Value, validate: (raw: Value) => Promise<Value>): Promise<void> {
    try {
      const next = await validate(raw);
      if (isDeepStrictEqual(next, entry.value)) this.changed.delete(entry.item.id);
      else this.changed.set(entry.item.id, next);
    } catch (error) {
      if (entry.item.id === this.clickedEntry.item.id || !(error instanceof BadRequestException)) throw error;
      this.changed.delete(entry.item.id);
      this.skipped.push({ itemId: entry.item.id, message: refusalMessage(error) });
    }
  }

  /** The clicked item and the siblings, in review order. */
  ordered(items: readonly DraftItem[]): Entry[] {
    const byId = new Map([this.clickedEntry, ...this.siblings].map((entry) => [entry.item.id, entry]));
    return items.flatMap((item) => byId.get(item.id) ?? []);
  }
}

function changesOf(input: MapLabResultInput): Partial<Value> {
  return {
    ...(input.analyteKey !== undefined ? { analyteKey: input.analyteKey } : {}),
    ...(input.unit !== undefined ? { unit: input.unit } : {}),
  };
}

/** The other `result` items printed with the clicked item's (folded) name, not rejected, in review order. */
function sameNamed(items: readonly DraftItem[], clicked: DraftItem, clickedValue: Value): Entry[] {
  const name = clickedValue.nameAsPrinted ? foldAnalyteName(clickedValue.nameAsPrinted) : '';
  if (name === '') return [];

  return items.flatMap((item) => {
    if (item.id === clicked.id || item.status === 'rejected') return [];
    const parsed = labReportValueSchema.safeParse(item.value);
    if (!parsed.success || !parsed.data.nameAsPrinted || foldAnalyteName(parsed.data.nameAsPrinted) !== name) return [];
    return [{ item, value: parsed.data }];
  });
}

function userEdited(item: DraftItem): boolean {
  return item.origin === 'user' || (item.originalAiValue !== null && item.originalAiValue !== undefined);
}

/** A result the user already set to another analyte: user-added, or an AI item the user edited. */
function userMappedElsewhere(item: DraftItem, value: Value, analyteKey: string): boolean {
  return userEdited(item) && value.analyteKey !== null && value.analyteKey !== analyteKey;
}

/** The unit the result was printed (read) with: from the AI's own value when a user edit kept it. */
function printedUnitOf(item: DraftItem, value: Value): string | null {
  const ai = labReportValueSchema.safeParse(item.originalAiValue ?? undefined);
  const source = ai.success && item.originalAiValue !== null ? ai.data : value;
  return source.originalUnit ?? source.unit;
}

function sameUnit(a: string | null, b: string | null): boolean {
  const fold = (unit: string | null) => (unit === null ? null : unit.trim().toLowerCase().replace(/[µμ]/g, 'u'));
  return fold(a) === fold(b);
}

/** The number the report printed for this result. */
const printedValueOf = (value: Value): number | null => value.originalValue ?? value.value;

/** The canonical value of `n` in `unit` for `key`, or null when the unit does not convert. */
function canonicalOrNull(key: string, n: number, unit: string): number | null {
  try {
    return toCanonical(key, n, unit);
  } catch (error) {
    if (error instanceof MetricRegistryError) return null;
    throw error;
  }
}

/** Whether `value` holds its printed number read in `unit` (as stored: canonical once matched). */
function readsIn(value: Value, unit: string): boolean {
  const printed = printedValueOf(value);
  if (printed === null || value.value === null) return sameUnit(value.unit, unit);
  if (!value.analyteKey || !getMetric(value.analyteKey)) return sameUnit(value.unit, unit) && value.value === printed;

  const canonical = canonicalOrNull(value.analyteKey, printed, unit);
  return canonical !== null && Math.abs(canonical - value.value) <= 1e-4;
}

/** Whether `value` still holds its printed number in its printed unit (no one changed its unit or number). */
function readsAsPrinted(value: Value): boolean {
  const printedUnit = value.originalUnit ?? value.unit;
  if (printedUnit === null) return value.value === printedValueOf(value);
  return readsIn(value, printedUnit);
}

/**
 * `value` with its printed number, and its reference limits as printed, read
 * in `unit` (the normal path then converts them to canonical).
 */
function reinterpret(value: Value, unit: string): Value {
  const printedUnit = value.originalUnit ?? value.unit;
  const key = value.analyteKey;
  const back = (n: number | null): number | null => {
    if (n === null || !key || value.unit === null || printedUnit === null) return n;
    if (!unitFor(key, value.unit) || !unitFor(key, printedUnit)) return n;
    try {
      return fromCanonical(key, toCanonical(key, n, value.unit), printedUnit);
    } catch (error) {
      if (error instanceof MetricRegistryError) return n;
      throw error;
    }
  };

  return {
    ...value,
    value: printedValueOf(value),
    unit,
    referenceLow: back(value.referenceLow),
    referenceHigh: back(value.referenceHigh),
  };
}

/** One item written as the item PATCH writes a value edit. */
async function writeLikePatch(tx: Prisma.TransactionClient, intakeId: string, item: DraftItem, value: Value): Promise<DraftItem> {
  if (item.origin === 'ai') {
    // Write-once, as the item PATCH: only while `original_ai_value` IS NULL.
    await tx.draftItem.updateMany({
      where: { id: item.id, intakeId, originalAiValue: { equals: Prisma.DbNull } },
      data: { originalAiValue: item.value as Prisma.InputJsonValue },
    });
  }

  return tx.draftItem.update({
    where: { id: item.id },
    data: { value: value as unknown as Prisma.InputJsonValue, userVerified: true },
  });
}

/** The rule(s) a refused target breaks, from the 400 the PATCH path threw (never a value). */
function refusalMessage(error: BadRequestException): string {
  const body = error.getResponse() as { message?: unknown; details?: { issues?: Array<{ message?: unknown }> } };
  const issues = (body.details?.issues ?? []).map((issue) => issue.message).filter((m): m is string => typeof m === 'string');
  if (issues.length > 0) return issues.join('; ');
  return typeof body.message === 'string' ? body.message : 'The result could not be mapped';
}

