import type { AiDraftInput, DraftItemConfidence } from '../../intake/intake-kind.interface';
import { isMethodAllowed } from '../metric-registry';
import {
  BODY_METRIC_MAX_READINGS,
  BODY_METRIC_PROMPT_VERSION,
  CUFF_PULSE_NOTE,
  type BodyMetricDeviceKind,
  type BodyMetricOutput,
} from './body-metric-reading.prompt';
import {
  BODY_METRIC_READING_ITEM_KIND,
  canonicalUnitSpelling,
  metricLabel,
  outOfRangeNote,
  readingProblems,
  type BodyMetricReadingValue,
} from './body-metric-reading.value';

// =============================================================================
// Model answer -> draft items (E2.6, #64)
// =============================================================================
//
// Pure. Every reading the model returned becomes ONE pending AI draft: nothing
// is auto-accepted and nothing is dropped (E3.1's invariant). What the mapper
// adds is doubt the model may have missed:
//
//   - a reading whose unit the metric does not allow, or whose value is
//     outside the metric's hard bounds once converted, is KEPT but flagged
//     `uncertain: true`, `confidence: 'low'` with a note; `apply` refuses it
//     until the user edits or rejects it;
//   - a blood-pressure cuff's pulse is always uncertain with
//     `CUFF_PULSE_NOTE` (a cuff pulse may not be a resting rate);
//   - `method` is suggested from `deviceKind` when the metric allows it.
//
// `readable: false` yields no items and `resultMeta.unreadable = true`.
// `resultMeta` is diagnostics only: never a value, a prompt or an image.
// =============================================================================

const METHOD_FOR_DEVICE: Partial<Record<BodyMetricDeviceKind, string>> = {
  scale: 'scale',
  smart_scale: 'smart_scale',
  bp_cuff: 'bp_cuff',
};

/** Longest unit string a draft value may hold (`bodyMetricReadingValueSchema`). */
const UNIT_MAX = 16;

export interface BodyMetricMapResult {
  drafts: AiDraftInput[];
  resultMeta: {
    promptVersion: number;
    deviceKind: BodyMetricDeviceKind | null;
    unreadable: boolean;
    readingsFlagged: number;
    readingsTruncated: number;
  };
}

/**
 * Maps a validated model answer to draft items. `photoIds` are the intake's
 * photos' storage object ids in the order they were sent (photo 1 first).
 */
export function mapBodyMetricOutput(output: BodyMetricOutput, photoIds: readonly string[]): BodyMetricMapResult {
  const deviceKind = output.deviceKind ?? null;
  const readings = output.readable ? output.readings.slice(0, BODY_METRIC_MAX_READINGS) : [];
  let flagged = 0;

  const drafts = readings.map((reading): AiDraftInput => {
    const unit = canonicalUnitSpelling(reading.metricKey, reading.unit.trim()).slice(0, UNIT_MAX);
    const suggested = deviceKind ? METHOD_FOR_DEVICE[deviceKind] : undefined;

    const value: BodyMetricReadingValue = {
      metricKey: reading.metricKey,
      value: reading.value,
      // An empty unit would fail the value schema and drop the item; `?` keeps
      // it, flagged, for the user to fix.
      unit: unit.length > 0 ? unit : '?',
      ...(suggested && isMethodAllowed(reading.metricKey, suggested) ? { method: suggested } : {}),
    };

    let confidence: DraftItemConfidence = reading.confidence;
    let uncertain = reading.uncertain;
    const notes: string[] = [];

    if (reading.note && reading.note.trim().length > 0) notes.push(reading.note.trim());

    if (reading.metricKey === 'resting_hr' && deviceKind === 'bp_cuff') {
      uncertain = true;
      if (!notes.includes(CUFF_PULSE_NOTE)) notes.push(CUFF_PULSE_NOTE);
    }

    const problems = readingProblems(value);
    const badUnit = problems.some((problem) => problem.field === 'unit');
    const badValue = problems.some((problem) => problem.field === 'value');

    if (badUnit || badValue) {
      flagged += 1;
      uncertain = true;
      confidence = 'low';
      if (badValue) notes.push(outOfRangeNote(reading.metricKey));
      if (badUnit) notes.push(`Unit not recognised for ${metricLabel(reading.metricKey).toLowerCase()}`);
    }

    return {
      kind: BODY_METRIC_READING_ITEM_KIND,
      value,
      confidence,
      uncertain,
      uncertaintyNote: notes.length > 0 ? notes.join('. ') : null,
      sourcePhotoIds: sourcePhotoIds(reading.sourcePhotoIndexes, photoIds),
    };
  });

  return {
    drafts,
    resultMeta: {
      promptVersion: BODY_METRIC_PROMPT_VERSION,
      deviceKind,
      unreadable: !output.readable,
      readingsFlagged: flagged,
      readingsTruncated: output.readable ? Math.max(0, output.readings.length - readings.length) : 0,
    },
  };
}

/**
 * 1-based photo numbers -> storage object ids, de-duplicated. A reading that
 * names no valid photo is attributed to every photo sent, so its source is
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
