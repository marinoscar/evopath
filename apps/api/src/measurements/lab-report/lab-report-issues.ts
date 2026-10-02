import { MAX_LAB_READINGS_PER_ENTRY } from '../dto/measurement.dto';
import {
  analyteLabel,
  effectiveCollectionDate,
  LAB_REPORT_ITEM_KIND,
  labReportValueSchema,
  labResultProblems,
  toCanonicalLabValue,
  type LabReportContext,
  type LabReportValue,
} from './lab-report.value';

// =============================================================================
// What apply refuses, per result (#317)
// =============================================================================
//
// ONE function, `labApplyIssues`, decides what `apply` refuses for a set of
// lab results. Two callers:
//
//   - `LabReportIntakeKind.apply` runs it on the ACCEPTED items and refuses
//     with 409 `UNRESOLVED_ANALYTES` when any is `UNMATCHED`, else with 400
//     `details.issues` when there is any other issue;
//   - `GET /api/measurements/lab-reports/:intakeId/issues`
//     (`LabReportIssuesService`) runs it on every NOT REJECTED item (pending
//     or accepted) as if all were accepted, so the review can badge each row
//     that would block apply BEFORE the user presses Save.
//
// Because both call this function, the route lists exactly what apply would
// refuse (proven by `test/health-data/lab-report-issues.db.spec.ts`).
//
// Codes:
//   INVALID_RESULT     the stored value is not a lab result (field null)
//   UNMATCHED          no catalog analyte (`analyteKey: null`; field `analyteKey`)
//   UNIT_NOT_ALLOWED   a unit the analyte does not allow (field `unit`)
//   NO_VALUE           no numeric value (field `value`)
//   OUT_OF_RANGE       outside the analyte's hard bounds (field `value`)
//   REFERENCE_ORDER    referenceLow above referenceHigh (field `referenceLow`)
//   DUPLICATE_ON_DATE  the same analyte more than once on one effective date:
//                      reported on EVERY such result (field `analyteKey`)
//   DATE_CAP           more than MAX_LAB_READINGS_PER_ENTRY results on one
//                      effective date: ONE issue naming every result of that
//                      date (`itemIds`; field null). Apply reports it once at
//                      path `items`; the route lists it on each of them.
//
// An UNMATCHED result takes no part in the per-date checks (its analyte is
// unknown), as apply always did.
//
// ⚠ Messages name the analyte, the field and the rule, NEVER a value.
// =============================================================================

export const LAB_APPLY_ISSUE_CODES = [
  'INVALID_RESULT',
  'UNMATCHED',
  'UNIT_NOT_ALLOWED',
  'NO_VALUE',
  'OUT_OF_RANGE',
  'REFERENCE_ORDER',
  'DUPLICATE_ON_DATE',
  'DATE_CAP',
] as const;
export type LabApplyIssueCode = (typeof LAB_APPLY_ISSUE_CODES)[number];

export const UNMATCHED_ISSUE_MESSAGE = 'This result is not matched to a lab analyte; map it to an analyte or reject it';
export const INVALID_RESULT_MESSAGE = 'This item is not a valid lab result; edit or reject it';

/** One reason apply refuses. `itemIds` has one id, except for `DATE_CAP` (every result of the date). */
export interface LabApplyIssue {
  code: LabApplyIssueCode;
  itemIds: string[];
  /** The value field concerned (`unit`, `value`, `referenceLow`, `analyteKey`), or null. */
  field: string | null;
  message: string;
}

/** The minimum of a draft item the check reads. */
export interface LabCheckableItem {
  id: string;
  kind: string;
  value: unknown;
}

export interface LabCheckedResult<T extends LabCheckableItem> {
  item: T;
  /** The value in canonical units. */
  value: LabReportValue;
}

export interface LabDateGroup<T extends LabCheckableItem> {
  /** The effective date; null = dated at apply time. */
  collectionDate: string | null;
  results: LabCheckedResult<T>[];
}

export interface LabApplyCheck<T extends LabCheckableItem> {
  /** Item-level issues in item order, then the per-date ones (newest date first). */
  issues: LabApplyIssue[];
  /** The matched, parseable results grouped by effective date, newest first, the undated group last. */
  groups: LabDateGroup<T>[];
}

/** Every reason apply would refuse `items` (taken as the accepted set), and the date groups it would save. */
export function labApplyIssues<T extends LabCheckableItem>(
  items: readonly T[],
  context: LabReportContext | null | undefined,
): LabApplyCheck<T> {
  const issues: LabApplyIssue[] = [];
  const results: LabCheckedResult<T>[] = [];

  for (const item of items) {
    const parsed = labReportValueSchema.safeParse(item.value);

    if (!parsed.success || item.kind !== LAB_REPORT_ITEM_KIND) {
      issues.push({ code: 'INVALID_RESULT', itemIds: [item.id], field: null, message: INVALID_RESULT_MESSAGE });
      continue;
    }

    if (!parsed.data.analyteKey) {
      issues.push({ code: 'UNMATCHED', itemIds: [item.id], field: 'analyteKey', message: UNMATCHED_ISSUE_MESSAGE });
      continue;
    }

    const value = toCanonicalLabValue(parsed.data);
    const label = analyteLabel(value.analyteKey!);

    for (const problem of labResultProblems(value, { requireValue: true })) {
      issues.push({ code: problem.code, itemIds: [item.id], field: problem.field, message: problemMessage(label, problem.message) });
    }

    results.push({ item, value });
  }

  const byDate = new Map<string | null, LabCheckedResult<T>[]>();
  for (const result of results) {
    const date = effectiveCollectionDate(result.value, context);
    byDate.set(date, [...(byDate.get(date) ?? []), result]);
  }

  const groups: LabDateGroup<T>[] = [...byDate.entries()]
    .map(([collectionDate, grouped]) => ({ collectionDate, results: grouped }))
    .sort((a, b) => newestFirst(a.collectionDate, b.collectionDate));

  for (const group of groups) {
    const when = group.collectionDate ? `on ${group.collectionDate}` : 'without a collection date';
    const perAnalyte = new Map<string, number>();
    for (const { value } of group.results) {
      perAnalyte.set(value.analyteKey!, (perAnalyte.get(value.analyteKey!) ?? 0) + 1);
    }
    for (const { item, value } of group.results) {
      if ((perAnalyte.get(value.analyteKey!) ?? 0) > 1) {
        issues.push({
          code: 'DUPLICATE_ON_DATE',
          itemIds: [item.id],
          field: 'analyteKey',
          message: `${analyteLabel(value.analyteKey!)} appears more than once ${when}; reject one of them or change its date`,
        });
      }
    }

    if (group.results.length > MAX_LAB_READINGS_PER_ENTRY) {
      issues.push({
        code: 'DATE_CAP',
        itemIds: group.results.map(({ item }) => item.id),
        field: null,
        message: `One collection date saves at most ${MAX_LAB_READINGS_PER_ENTRY} results; ${group.results.length} are listed ${when}, reject ${group.results.length - MAX_LAB_READINGS_PER_ENTRY} of them`,
      });
    }
  }

  return { issues, groups };
}

/** The user-facing text of a result problem: prefixed with the analyte, ending with what to do. */
function problemMessage(label: string, message: string): string {
  const prefixed = message.startsWith(label) ? message : `${label}: ${message}`;
  return /reject it$/.test(prefixed) ? prefixed : `${prefixed}; edit or reject it`;
}

/** Dates newest first, null (no date) last. */
function newestFirst(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b.localeCompare(a);
}
