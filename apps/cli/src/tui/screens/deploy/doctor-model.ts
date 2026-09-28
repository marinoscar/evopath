/**
 * The doctor screen's model: results, shaped for reading.  (issue #393)
 *
 * Pure. No ink, no React -- the screen renders what this returns, and the
 * tests assert it without mounting anything (`ink-testing-library` is
 * deliberately not a dependency).
 *
 * =============================================================================
 * ⚠ THE TWO RULES THIS FILE EXISTS TO KEEP
 * =============================================================================
 *
 * 1. THE REMEDY IS THE USEFUL HALF OF A FAILED CHECK. The screen this replaces
 *    streamed `FAIL title: detail` and stopped there, so reading it told an
 *    operator THAT something failed and not what to do about it -- while the
 *    subcommand printed the remedy on the next line. Every failure and warning
 *    here carries its remedy; a pass or a skip never does, because a remedy
 *    beneath a passing check reads as an instruction to act on it.
 *
 * 2. STATUS IS A GLYPH AS WELL AS A COLOUR. The glyphs are the SAME table the
 *    subcommand renders with (`MARKS` in commands/deploy.ts), so an operator
 *    comparing a screen with a pasted shell transcript is comparing like with
 *    like -- and a colour-blind operator, or one reading over a monochrome SSH
 *    session, loses nothing.
 * =============================================================================
 */
import { MARKS } from '../../../commands/deploy.js';
import {
  checksPassed,
  summarise,
  type CheckStatus,
  type CompletedCheck,
} from '../../../deploy/checks/index.js';

/** Worst first: what needs doing is what an operator reads first. */
export const STATUS_ORDER: readonly CheckStatus[] = ['fail', 'warn', 'pass', 'skip'];

export const STATUS_GLYPH: Readonly<Record<CheckStatus, string>> = MARKS;

/** ink colour names. The glyph carries the status on its own; this is a second channel. */
export const STATUS_COLOUR: Readonly<Record<CheckStatus, string>> = Object.freeze({
  fail: 'red',
  warn: 'yellow',
  pass: 'green',
  skip: 'gray',
});

const HEADING: Readonly<Record<CheckStatus, string>> = Object.freeze({
  fail: 'Failed',
  warn: 'Warnings',
  pass: 'Passed',
  skip: 'Skipped',
});

export interface DoctorItem {
  id: string;
  title: string;
  detail: string;
  /** Present only on a failure or a warning that has one. */
  remedy?: string | undefined;
  /**
   * True for a failed check that does NOT gate the result. Said out loud,
   * because "Failed" with a passing verdict otherwise reads as a contradiction.
   */
  optional: boolean;
}

export interface DoctorGroup {
  status: CheckStatus;
  heading: string;
  glyph: string;
  colour: string;
  items: DoctorItem[];
}

export interface DoctorReport {
  /** Non-empty groups only, in `STATUS_ORDER`. */
  groups: DoctorGroup[];
  /** The same verdict `deploy doctor` exits on: no REQUIRED check failed. */
  passed: boolean;
  /** "1 failed, 2 warning(s), 14 passed, 1 skipped" -- the subcommand's wording. */
  headline: string;
}

export function groupDoctorResults(results: readonly CompletedCheck[]): DoctorReport {
  const groups: DoctorGroup[] = [];

  for (const status of STATUS_ORDER) {
    const items = results
      .filter((result) => result.status === status)
      .map((result): DoctorItem => {
        const actionable = status === 'fail' || status === 'warn';
        return {
          id: result.id,
          title: result.title,
          detail: result.detail,
          ...(actionable && result.remedy !== undefined && result.remedy !== ''
            ? { remedy: result.remedy }
            : {}),
          optional: status === 'fail' && result.severity !== 'required',
        };
      });

    if (items.length === 0) continue;
    groups.push({
      status,
      heading: HEADING[status],
      glyph: STATUS_GLYPH[status],
      colour: STATUS_COLOUR[status],
      items,
    });
  }

  return { groups, passed: checksPassed(results), headline: headlineFor(results) };
}

/** Same order and wording as `renderSummary`, so the two surfaces agree. */
function headlineFor(results: readonly CompletedCheck[]): string {
  const summary = summarise(results);
  const parts = [`${summary.passed} passed`];
  if (summary.warned > 0) parts.unshift(`${summary.warned} warning(s)`);
  if (summary.failed > 0) parts.unshift(`${summary.failed} failed`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
  return parts.join(', ');
}

/** One check as a streamed line while the run is in progress: glyph first. */
export function doctorLine(result: CompletedCheck): string {
  return `${STATUS_GLYPH[result.status]} ${result.title}: ${result.detail}`;
}
