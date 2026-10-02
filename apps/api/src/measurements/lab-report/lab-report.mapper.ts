import type { AiDraftInput, DraftItemConfidence } from '../../intake/intake-kind.interface';
import { REFERENCE_TEXT_MAX } from '../dto/measurement.dto';
import { getMetric, isLabMetric, LAB_PANELS, type LabPanel, resolveLabAnalyte, unitFor } from '../metric-registry';
import { LAB_REPORT_MAX_RESULTS, LAB_REPORT_PROMPT_VERSION, type LabReportOutput } from './lab-report.prompt';
import {
  analyteLabel,
  isCollectionDate,
  LAB_NAME_MAX,
  LAB_REPORT_ITEM_KIND,
  LAB_UNIT_MAX,
  LAB_VALUE_TEXT_MAX,
  labResultProblems,
  type LabMatchStatus,
  type LabReportValue,
  toCanonicalLabValue,
} from './lab-report.value';

// =============================================================================
// Model answer -> draft items and document fields (H4, #188)
// =============================================================================
//
// Pure. Every result the model returned becomes ONE pending AI draft: nothing
// is auto-accepted and nothing is dropped, an unrecognised analyte included.
// The one exception (#310, #317): a NON-RESULT, a cell with no number that
// either printed nothing or whose printed text says there is none, is not a
// result at all ({@link isNonResult}). It is dropped and counted in
// `resultMeta.nonResultsDropped`, so it never blocks apply with "no numeric
// value". "Says there is none": the text STARTS with a non-result phrase
// ("NOT APPLICABLE (CALC)", "SEE NOTE: (CALC)", "N/A*", "TNP", "Pending"),
// or CONTAINS one as a whole token while carrying nothing that reads like a
// result (no digit, `<`, `>` or qualitative word such as "negative",
// "trace", "detected"). A non-numeric RESULT ("negative", "<0.5", ">90",
// "trace") is kept. The rule is the same for a matched analyte (every catalog
// analyte is numeric) and an unmatched one.
//
// MATCHING. The analyte is resolved on the SERVER from the printed name
// (`resolveLabAnalyte`: key, label or alias, folded). The model's
// `matchedKey` is only a fallback hint: used when the printed name resolves to
// nothing AND the hint is a valid lab key, and then the draft is `suggested`,
// uncertain, with a note asking the user to confirm. A hint that disagrees
// with a resolved name is ignored (counted in `resultMeta.hintsIgnored`).
// Anything else is `unmatched`: uncertain, with a note; `apply` refuses the
// intake until the user maps or rejects it.
//
// CONVERSION. A matched result in an accepted non-canonical unit is converted
// to the canonical unit (value and reference limits), keeping the printed
// value and unit in `originalValue`/`originalUnit`.
//
// DOUBT. A matched result with no number (but a qualitative text), a unit the analyte does not allow,
// or a value outside the hard bounds is kept, flagged uncertain and low.
//
// DATES (#305). Each result keeps its own `collectionDate` (one column of a
// trend table) when it is a valid date (`isCollectionDate`); an impossible or
// future one is discarded to null, the draft flagged uncertain with the note
// "Date not read" (it then falls back to the report date). The REPORT date
// (the context's `collectionDate`) is the model's report-level date when
// valid; else the one date every dated result shares; else null.
//
// `resultMeta` is diagnostics only: counts and the prompt version, never a
// value, a name, a prompt or a document byte.
// =============================================================================

export const UNMATCHED_NOTE = 'Not in the lab catalog: map it to an analyte or reject it';
export const SUGGESTED_NOTE = "Matched from the AI's suggestion: confirm the analyte";
export const DATE_NOT_READ_NOTE = 'Date not read: set the collection date or keep the report date';

/** What a lab prints in a cell that holds no result (#310), as one alternation. */
const NON_RESULT_PHRASE =
  '(?:not applicable|n\\/?a|see notes?|see comments?|see below|tnp|test not performed|not performed|not done|cancel+ed|pending|in progress|to follow|qns|quantity not sufficient)';

/** The text starts with a non-result phrase, as a whole word ("N/A*", "SEE NOTE: (CALC)"). */
const NON_RESULT_PREFIX = new RegExp(`^${NON_RESULT_PHRASE}(?![a-z0-9])`, 'i');

/** The text contains a non-result phrase as a whole token anywhere ("(CALC) see note"). */
const NON_RESULT_TOKEN = new RegExp(`(?:^|[^a-z0-9])${NON_RESULT_PHRASE}(?![a-z0-9])`, 'i');

/** Only dashes: an empty cell. */
const DASHES = /^[-\u2013\u2014]+$/;

/** Something that reads like a qualitative or bounded result, which a contained token must not override. */
const RESULT_LIKE =
  /[0-9<>]|\b(?:negative|positive|neg|pos|trace|detected|reactive|nonreactive|non-reactive|normal|abnormal|present|absent|nil|equivocal|indeterminate|borderline)\b/i;

/**
 * Whether a model result is a non-result (#310, #317): no number, and the
 * printed text is empty or says there is none (starts with a non-result
 * phrase, or contains one as a token and nothing result-like).
 */
export function isNonResult(result: Pick<LabReportOutput['results'][number], 'value' | 'valueText'>): boolean {
  if (finite(result.value) !== null) return false;
  const printed = result.valueText?.trim().replace(/^[\s*#([]+/, '').replace(/[\s.:;,*]+$/, '') ?? '';
  if (printed === '' || DASHES.test(printed)) return true;
  if (NON_RESULT_PREFIX.test(printed)) return true;
  return NON_RESULT_TOKEN.test(printed) && !RESULT_LIKE.test(printed);
}

export interface LabReportMapResult {
  drafts: AiDraftInput[];
  /** The document-level fields, validated; null where the model read nothing usable. */
  document: { collectionDate: string | null; labName: string | null };
  resultMeta: {
    promptVersion: number;
    unreadable: boolean;
    resultsReturned: number;
    resultsTruncated: number;
    unmatched: number;
    suggested: number;
    flagged: number;
    hintsIgnored: number;
    converted: number;
    collectionDateRead: boolean;
    collectionDateDiscarded: boolean;
    /** How many different per-result collection dates were read (#305). */
    distinctDates: number;
    /** Per-result dates discarded as impossible or in the future. */
    resultDatesDiscarded: number;
    /** Cells that printed no result (nothing, "NOT APPLICABLE", "SEE NOTE: (CALC)"), dropped (#310, #317). */
    nonResultsDropped: number;
  };
}

const text = (value: string | null | undefined, max: number): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed.slice(0, max) : null;
};

const finite = (value: number | null): number | null => (value !== null && Number.isFinite(value) ? value : null);

/**
 * Maps a validated model answer. `photoIds` are the intake's inputs' storage
 * object ids in the order they were sent (input 1 first).
 */
export function mapLabReportOutput(output: LabReportOutput, photoIds: readonly string[], now: Date = new Date()): LabReportMapResult {
  const returned = output.readable ? output.results.slice(0, LAB_REPORT_MAX_RESULTS) : [];
  const results = returned.filter((result) => !isNonResult(result));
  const counts = { unmatched: 0, suggested: 0, flagged: 0, hintsIgnored: 0, converted: 0 };
  let resultDatesDiscarded = 0;

  const drafts = results.map((result): AiDraftInput => {
    const nameAsPrinted = text(result.nameAsPrinted, 120) ?? '?';
    const resolved = resolveLabAnalyte(nameAsPrinted);
    const hint = result.matchedKey?.trim() ?? null;
    const notes: string[] = [];
    let uncertain = result.uncertain;
    let confidence: DraftItemConfidence = result.confidence;
    let analyteKey: string | null = null;
    let match: LabMatchStatus = 'unmatched';

    if (resolved) {
      analyteKey = resolved.key;
      match = 'matched';
      if (hint && hint !== resolved.key) counts.hintsIgnored += 1;
    } else if (hint && isLabMetric(hint)) {
      analyteKey = hint;
      match = 'suggested';
      uncertain = true;
      notes.push(SUGGESTED_NOTE);
      counts.suggested += 1;
    } else {
      uncertain = true;
      notes.push(UNMATCHED_NOTE);
      counts.unmatched += 1;
    }

    if (result.note && result.note.trim().length > 0) notes.unshift(result.note.trim());

    const printedResultDate = text(result.collectionDate, 10);
    const collectionDate = printedResultDate && isCollectionDate(printedResultDate, now) ? printedResultDate : null;
    if (printedResultDate !== null && collectionDate === null) {
      resultDatesDiscarded += 1;
      uncertain = true;
      notes.push(DATE_NOT_READ_NOTE);
    }

    const unit = text(result.unit, LAB_UNIT_MAX);
    const value = finite(result.value);
    const printed: LabReportValue = {
      analyteKey,
      nameAsPrinted,
      value,
      valueText: text(result.valueText, LAB_VALUE_TEXT_MAX),
      unit,
      originalValue: value,
      originalUnit: unit,
      referenceLow: finite(result.referenceLow),
      referenceHigh: finite(result.referenceHigh),
      referenceText: text(result.referenceText, REFERENCE_TEXT_MAX),
      flag: result.labFlag ?? null,
      panel: panelHint(result.panelHint),
      match,
      collectionDate,
    };

    const saved = toCanonicalLabValue(printed);
    if (analyteKey && printed.unit !== null) {
      const unitDef = unitFor(analyteKey, printed.unit);
      if (unitDef && unitDef.unit !== getMetric(analyteKey)?.canonicalUnit) counts.converted += 1;
    }

    const problems = labResultProblems(saved, { requireValue: true });
    if (problems.length > 0) {
      counts.flagged += 1;
      uncertain = true;
      confidence = 'low';
      const label = analyteLabel(analyteKey!);
      for (const problem of problems) {
        notes.push(
          problem.field === 'unit'
            ? `Unit not recognised for ${label}`
            : problem.field === 'value'
              ? saved.value === null
                ? 'No numeric value: enter one or reject it'
                : `Outside the usual range for ${label}`
              : 'The reference range limits are in the wrong order',
        );
      }
    }

    return {
      kind: LAB_REPORT_ITEM_KIND,
      value: saved,
      confidence,
      uncertain,
      uncertaintyNote: notes.length > 0 ? notes.join('. ') : null,
      sourcePhotoIds: sourcePhotoIds(result.sourcePhotoIndexes, photoIds),
    };
  });

  const resultDates = new Set(
    drafts.map((draft) => (draft.value as LabReportValue).collectionDate).filter((date): date is string => date !== null),
  );
  const printedDate = text(output.collectionDate, 10);
  const reportDate = printedDate && isCollectionDate(printedDate, now) ? printedDate : null;
  const collectionDate = reportDate ?? (resultDates.size === 1 ? [...resultDates][0] : null);

  return {
    drafts,
    document: {
      collectionDate: output.readable ? collectionDate : null,
      labName: output.readable ? text(output.labName, LAB_NAME_MAX) : null,
    },
    resultMeta: {
      promptVersion: LAB_REPORT_PROMPT_VERSION,
      unreadable: !output.readable,
      resultsReturned: output.readable ? output.results.length : 0,
      resultsTruncated: output.readable ? Math.max(0, output.results.length - returned.length) : 0,
      ...counts,
      collectionDateRead: output.readable && collectionDate !== null,
      collectionDateDiscarded: output.readable && printedDate !== null && reportDate === null,
      distinctDates: resultDates.size,
      resultDatesDiscarded,
      nonResultsDropped: returned.length - results.length,
    },
  };
}

function panelHint(hint: string | null): LabPanel | null {
  const folded = hint?.trim().toLowerCase() ?? '';
  return (LAB_PANELS as readonly string[]).includes(folded) ? (folded as LabPanel) : null;
}

/**
 * 1-based input numbers -> storage object ids, de-duplicated. A result that
 * names no valid input is attributed to every input sent, so its source is
 * never lost.
 */
function sourcePhotoIds(indexes: readonly number[], photoIds: readonly string[]): string[] {
  const ids = [
    ...new Set(
      indexes.filter((index) => Number.isInteger(index) && index >= 1 && index <= photoIds.length).map((index) => photoIds[index - 1]),
    ),
  ];

  return ids.length > 0 ? ids : [...photoIds];
}
