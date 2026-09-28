/**
 * What a run screen knows after the fact: the failing step, its last output,
 * and the command that repeats it.  (issue #393, epic #388 Phase E)
 *
 * Pure. No ink, no React, no process -- `run.tsx` holds the state and renders
 * it; this shapes it, and the tests assert the shape.
 *
 * =============================================================================
 * ⚠ A FAILURE MUST LEAVE SOMETHING TO ACT ON
 * =============================================================================
 *
 * The failed frame used to carry the error message and nothing else. The TUI
 * exits 0 whatever happened (tui/index.tsx), so the frame is the ONLY place
 * the failure is carried -- and it named neither the step that failed, nor
 * what that step last printed, nor the journal with the whole story, nor the
 * command that continues from where it stopped. Those four are what an
 * operator needs, in that order, and each is built here.
 *
 * ⚠ THE RE-RUN COMMAND NEVER CARRIES A SECRET. It is built ONLY from the
 * `VALUE_FLAGS` a screen declares (paths, ports, hostnames, refs) and the
 * toggles -- never from the environment answers, which is where every secret
 * lives. A value whose key `shouldMask` would hide is refused even if a caller
 * passes one, so this cannot be the place a password reaches a screenshot.
 * =============================================================================
 */
import { DEFAULT_BIND_PORT, DEFAULT_PROXY_ROOT } from '../../../commands/deploy.js';
import { CLI_NAME } from '../../../branding.js';
import { DEFAULT_APPS_ROOT, deployRootFor } from '../../../deploy/layout.js';
import { TOGGLES_FOR, VALUE_FLAGS, type RunnableAction } from './flags-model.js';
import { shouldMask } from './model.js';

export interface StepView {
  id: string;
  title: string;
  outcome: 'running' | 'ok' | 'skipped' | 'failed';
  detail?: string | undefined;
}

/** Output lines of the failing step kept for the failed frame. */
export const FAILURE_TAIL_LINES = 8;

/** Appends and keeps the last `max`. Never mutates: the input is React state. */
export function pushBounded<T>(list: readonly T[], item: T, max: number): T[] {
  const next = [...list, item];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * The step a failure belongs to.
 *
 * The LAST one reported failed; else the last one still running, because a
 * step that threw before reporting a result is still the one that failed. A
 * run that failed before any step started has none, and says so.
 */
export function failingStep(steps: readonly StepView[]): StepView | undefined {
  const latestFirst = [...steps].reverse();
  return (
    latestFirst.find((step) => step.outcome === 'failed') ??
    latestFirst.find((step) => step.outcome === 'running')
  );
}

export interface FailureReport {
  message: string;
  step?: StepView | undefined;
  /** At most `FAILURE_TAIL_LINES`, oldest first. */
  tail: string[];
  journalPath?: string | undefined;
  rerun?: string | undefined;
}

export function failureReport(input: {
  message: string;
  steps: readonly StepView[];
  tail: readonly string[];
  journalPath?: string | undefined;
  rerun?: string | undefined;
}): FailureReport {
  return {
    message: input.message,
    step: failingStep(input.steps),
    tail: input.tail.slice(-FAILURE_TAIL_LINES),
    ...(input.journalPath === undefined ? {} : { journalPath: input.journalPath }),
    ...(input.rerun === undefined ? {} : { rerun: input.rerun }),
  };
}

/** Values the subcommand already defaults to, so repeating them is noise. */
const CLI_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  '--proxy-root': DEFAULT_PROXY_ROOT,
  '--port': String(DEFAULT_BIND_PORT),
});

/** POSIX single-quoting, only when needed. Paste-safe in any sh-like shell. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface RerunInput {
  action: RunnableAction;
  /** The deployment's name, as resolved on the name step. */
  name: string;
  /** Screen-field values (`__domain`, `__port`, …) as passed to the pipeline. */
  values: ReadonlyMap<string, string>;
  /** Chosen toggle flags, as their `--flag` strings. */
  chosen: ReadonlySet<string>;
}

/**
 * The shell command that repeats this run, flags and all.
 *
 * - `--name` when the root is the one the name implies, else `--root`: the
 *   subcommand resolves either to the same directory, and the shorter one is
 *   the one an operator can read.
 * - Only flags this action declares (`VALUE_FLAGS`, the toggles); an empty
 *   value, or one equal to the subcommand's own default, is left off.
 * - `--resume` for install only -- update declares no such flag, and is
 *   re-runnable as it stands.
 */
export function rerunCommand({ action, name, values, chosen }: RerunInput): string {
  const parts = [CLI_NAME, 'deploy', action];

  const root = values.get('__root');
  if (root === undefined || root === deployRootFor(DEFAULT_APPS_ROOT, name)) {
    parts.push('--name', shellQuote(name));
  } else {
    parts.push('--root', shellQuote(root));
  }

  for (const { flag, field } of VALUE_FLAGS[action]) {
    if (flag === '--root') continue;
    // ⚠ Belt and braces: VALUE_FLAGS names screen fields only, which are never
    // masked -- but a secret must not reach this string whatever is passed.
    if (shouldMask(field)) continue;
    const value = values.get(field);
    if (value === undefined || value.trim() === '' || CLI_DEFAULTS[flag] === value) continue;

    if (flag === '--group') {
      // Repeatable on the command line; comma-separated on the screen.
      for (const group of value.split(',').map((entry) => entry.trim()).filter(Boolean)) {
        parts.push(flag, shellQuote(group));
      }
      continue;
    }
    parts.push(flag, shellQuote(value));
  }

  for (const toggle of TOGGLES_FOR[action]) {
    if (chosen.has(toggle.flag)) parts.push(toggle.flag);
  }

  if (action === 'install') parts.push('--resume');

  return parts.join(' ');
}
