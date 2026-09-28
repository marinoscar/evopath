import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { CLI_NAME } from '../../../branding.js';
import type { DeployHooks, StepResult } from '../../../deploy/hooks.js';
import { formatError } from '../../../errors.js';
import { ErrorNotice, Field, Frame } from '../../layout.js';
import { ScrollBox } from '../../scroll-box.js';
import {
  FAILURE_TAIL_LINES,
  failureReport,
  pushBounded,
  type FailureReport,
  type StepView,
} from './run-model.js';

export type { StepView } from './run-model.js';

// =============================================================================
// The part of a deploy screen that is the same for all four  (issue #406)
// =============================================================================
//
// The four screens differ in what they ASK and which function they call. They
// do not differ in how a run is watched, cancelled or reported -- so that lives
// here once. The two hazards below are why it must not be re-derived per
// screen: each is a rule that is easy to get right once and easy to drop on the
// second copy, and both were stated on the 509-line screen this replaces.
//
//   1. THE ABORT CONTROLLER IS LOAD-BEARING. Without it, pressing Esc tears
//      down the UI and leaves the work running - and here the work is a
//      `docker compose build` on a production server. Every child process goes
//      through `withSignal(runCommand, signal)` (see each screen's `perform*`),
//      so aborting the controller SIGTERMs whatever is running. A screen that
//      held a controller reaching nothing would offer a cancel that does not
//      cancel, which is worse than no cancel at all.
//
//   2. THE EXIT CODE INVERTS HERE. A normal TUI exit is 0 even after a failed
//      operation (tui/index.tsx), whereas `appctl deploy install` must exit
//      non-zero. That is intended - the user has read the outcome on screen -
//      but it means the failure has to be UNMISTAKABLE in the frame, because
//      the exit code will not carry it. `RunFrame`'s failed branch is that
//      frame, and its hint names the command that DOES exit non-zero.
// =============================================================================

export type RunPhase =
  | { kind: 'idle' }
  | {
      kind: 'running';
      steps: StepView[];
      lines: string[];
      /**
       * The current step's own output, bounded to `FAILURE_TAIL_LINES` and
       * reset when a step starts -- so on failure it is the failing step's
       * last words, not the previous step's.
       */
      tail: string[];
      /** Known from `onJournal`, as soon as the pipeline opens it. */
      journalPath?: string | undefined;
    }
  | { kind: 'done'; summary: string[] }
  | { kind: 'cancelled'; steps: StepView[]; journalPath?: string | undefined }
  | { kind: 'failed'; report: FailureReport };

/** Lines kept in the live log. Unbounded growth is a leak on a long build. */
const MAX_LOG_LINES = 2_000;

/**
 * The work a screen runs.
 *
 * ⚠ The signal is handed IN rather than read off a module-level controller, so
 * a screen cannot forget to bind it: there is no other way to obtain one here,
 * and `withSignal` is the only thing to do with it.
 */
export type DeployWork = (signal: AbortSignal, hooks: DeployHooks) => Promise<string[]>;

export interface StartOptions {
  /**
   * The shell command that repeats this run, shown if it fails. Built by the
   * screen with `rerunCommand`, because only the screen knows what was chosen.
   */
  rerun?: string | undefined;
}

export interface DeployRun {
  phase: RunPhase;
  /** True once Esc has been pressed once during a run; a second press aborts. */
  confirmAbort: boolean;
  start: (work: DeployWork, options?: StartOptions) => void;
}

export interface UseDeployRunOptions {
  /** Where Esc goes when nothing is running. */
  onEscape: () => void;
  /**
   * False while a text field owns the keyboard.
   *
   * invoke.tsx's rule: exactly one thing accepts input at any moment, so the
   * Esc in a typed value can never also be a navigation.
   */
  escapeActive: boolean;
}

export function useDeployRun({ onEscape, escapeActive }: UseDeployRunOptions): DeployRun {
  const [phase, setPhase] = useState<RunPhase>({ kind: 'idle' });
  // Esc once arms the cancel and shows what it will and will not undo; Esc
  // again commits it. A single keystroke is too little ceremony for killing a
  // half-applied deployment.
  const [confirmAbort, setConfirmAbort] = useState(false);
  const mounted = useRef(true);
  const abortRef = useRef<AbortController | undefined>(undefined);
  // Whether THIS run was cancelled by the operator, as distinct from having
  // failed on its own. An aborted child exits on SIGTERM and surfaces as an
  // ordinary `CommandFailedError`, so the two are indistinguishable from the
  // error alone -- and reporting a cancel as a crash sends an operator looking
  // for a fault that is not there.
  const cancelledRef = useRef(false);

  useEffect(
    () => () => {
      mounted.current = false;
      // Load-bearing: without it, Esc tears down the UI and leaves a
      // `docker compose build` running on a production server.
      abortRef.current?.abort();
    },
    [],
  );

  const appendLine = useCallback((line: string) => {
    if (!mounted.current) return;
    setPhase((current) => {
      if (current.kind !== 'running') return current;
      // Oldest-first, because the end of a build log is the part that matters.
      return {
        ...current,
        lines: pushBounded(current.lines, line, MAX_LOG_LINES),
        tail: pushBounded(current.tail, line, FAILURE_TAIL_LINES),
      };
    });
  }, []);

  const hooks = useMemo<DeployHooks>(
    () => ({
      onStepStart: ({ id, title }: { id: string; title: string }) => {
        if (!mounted.current) return;
        setPhase((current) =>
          current.kind === 'running'
            ? {
                ...current,
                steps: [...current.steps, { id, title, outcome: 'running' as const }],
                // A new step's output starts here; the tail is per step.
                tail: [],
              }
            : current,
        );
      },
      onStepResult: (result: StepResult) => {
        if (!mounted.current) return;
        setPhase((current) =>
          current.kind === 'running'
            ? {
                ...current,
                // A result for a step that never announced a start still has to
                // land, or a pipeline that skips its announcement renders a
                // silent gap where a completed step belongs.
                steps: current.steps.some((step) => step.id === result.id)
                  ? current.steps.map((step) =>
                      step.id === result.id
                        ? { ...step, outcome: result.outcome, detail: result.detail }
                        : step,
                    )
                  : [
                      ...current.steps,
                      {
                        id: result.id,
                        title: result.title,
                        outcome: result.outcome,
                        detail: result.detail,
                      },
                    ],
              }
            : current,
        );
      },
      onProgress: appendLine,
      onLog: appendLine,
      onJournal: (path: string) => {
        if (!mounted.current) return;
        setPhase((current) => (current.kind === 'running' ? { ...current, journalPath: path } : current));
      },
    }),
    [appendLine],
  );

  const start = useCallback(
    (work: DeployWork, options?: StartOptions) => {
      const rerun = options?.rerun;
      const controller = new AbortController();
      abortRef.current = controller;
      cancelledRef.current = false;
      setConfirmAbort(false);
      setPhase({ kind: 'running', steps: [], lines: [], tail: [] });

      void (async () => {
        try {
          const summary = await work(controller.signal, hooks);
          if (mounted.current) setPhase({ kind: 'done', summary });
        } catch (error) {
          if (!mounted.current) return;
          if (cancelledRef.current) {
            // Reported as a cancel, naming the steps that already committed.
            setPhase((current) =>
              current.kind === 'running'
                ? { kind: 'cancelled', steps: current.steps, journalPath: current.journalPath }
                : current,
            );
            return;
          }
          if (error instanceof Error && error.name === 'AbortError') return;
          const message = formatError(error);
          // Read off the running phase: which step, what it said last, where
          // the journal is. See run-model.ts for why each of these matters.
          setPhase((current) => ({
            kind: 'failed',
            report: failureReport({
              message,
              steps: current.kind === 'running' ? current.steps : [],
              tail: current.kind === 'running' ? current.tail : [],
              journalPath: current.kind === 'running' ? current.journalPath : undefined,
              rerun,
            }),
          }));
        }
      })();
    },
    [hooks],
  );

  useInput(
    (_input, key) => {
      if (phase.kind === 'running') {
        if (!key.escape) return;
        if (!confirmAbort) {
          setConfirmAbort(true);
          return;
        }
        cancelledRef.current = true;
        abortRef.current?.abort();
        return;
      }

      // Enter is accepted only on a terminal frame, where nothing else owns it.
      // Binding it generally would make one keystroke both choose a list item
      // and leave the screen.
      const terminal = phase.kind === 'done' || phase.kind === 'failed' || phase.kind === 'cancelled';
      if (key.escape || (key.return && terminal)) onEscape();
    },
    { isActive: escapeActive },
  );

  return { phase, confirmAbort, start };
}

export interface RunFrameProps {
  /** The action, as the operator chose it: `install`, `doctor`, … */
  action: string;
  run: DeployRun;
}

/**
 * The running, cancelled, done and failed frames.
 *
 * Returns null while idle, so a screen renders its own questions until it has
 * something to run: `{run.phase.kind === 'idle' ? <Questions/> : <RunFrame …/>}`.
 */
export function RunFrame({ action, run }: RunFrameProps): ReactNode {
  const { phase, confirmAbort } = run;

  if (phase.kind === 'idle') return null;

  if (phase.kind === 'running') {
    return (
      <Frame
        title={`${action} — running`}
        hints={[confirmAbort ? 'esc again to cancel' : 'esc cancel', 'ctrl-c abort']}
      >
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text> {phase.steps.at(-1)?.title ?? 'Starting'}…</Text>
        </Box>
        {phase.journalPath === undefined ? null : (
          <Text dimColor>Log: {phase.journalPath}</Text>
        )}
        {confirmAbort ? (
          // Names what cancelling does NOT undo. A cancel that implies a clean
          // rollback is the same lie as a cancel that does not cancel.
          <Box marginTop={1} flexDirection="column">
            <Text color="yellow">
              Press esc again to stop. Steps already completed are NOT undone:
            </Text>
            <Text color="yellow">
              {'  '}
              {completedTitles(phase.steps)}
            </Text>
            <Text dimColor>Re-run to continue from where this stopped.</Text>
          </Box>
        ) : null}
        <Box flexDirection="column" marginTop={1}>
          {phase.steps.map((step) => (
            <Text key={step.id}>
              {OUTCOME_MARK[step.outcome]}
              {step.title}
            </Text>
          ))}
        </Box>
        <Box marginTop={1} flexDirection="column">
          {/* Bounded viewport, following the tail. An unbounded list of Text
              would be redrawn in full on every appended line. */}
          <ScrollBox lines={phase.lines} reservedRows={16} followTail isActive={false} />
        </Box>
      </Frame>
    );
  }

  if (phase.kind === 'cancelled') {
    return (
      <Frame title={`${action} — cancelled`} hints={['esc return to the menu']}>
        <Box flexDirection="column">
          <Text color="yellow">Stopped on request. These steps are NOT undone:</Text>
          <Text color="yellow">
            {'  '}
            {completedTitles(phase.steps)}
          </Text>
          <Text dimColor>Re-running continues from where this stopped.</Text>
          {phase.journalPath === undefined ? null : (
            <Text dimColor>Log: {phase.journalPath}</Text>
          )}
        </Box>
      </Frame>
    );
  }

  if (phase.kind === 'failed') {
    return <FailedFrame action={action} report={phase.report} />;
  }

  return (
    <Frame title={`${action} — done`} hints={['esc return to the menu']}>
      <Box flexDirection="column">
        {phase.summary.map((line, index) => (
          // The index is part of the key because a summary legitimately repeats
          // a line (a blank separator is the common case).
          <Text key={`${index}:${line}`}>{line.length === 0 ? ' ' : line}</Text>
        ))}
      </Box>
    </Frame>
  );
}

const OUTCOME_MARK: Readonly<Record<StepView['outcome'], string>> = {
  ok: '  OK ',
  failed: '  XX ',
  skipped: '  -- ',
  running: '  .. ',
};

function completedTitles(steps: readonly StepView[]): string {
  return (
    steps
      .filter((step) => step.outcome === 'ok')
      .map((step) => step.title)
      .join(', ') || 'none yet'
  );
}

/**
 * The failed frame.
 *
 * ⚠ UNMISTAKABLE ON PURPOSE. The exit code will be 0 whatever happened here,
 * so the frame carries the failure on its own: a FAILED title, the red notice,
 * and then -- in the order an operator needs them -- the step, its last
 * output, the journal, and the command that continues from here.
 */
function FailedFrame({ action, report }: { action: string; report: FailureReport }): ReactNode {
  const { step, tail, journalPath, rerun } = report;
  return (
    <Frame title={`${action} — FAILED`} hints={['esc return to the menu']}>
      <ErrorNotice message={report.message} />
      <Box marginTop={1} flexDirection="column">
        {step === undefined ? (
          <Text color="red">Failed before any step started.</Text>
        ) : (
          <Text color="red">
            {OUTCOME_MARK.failed.trim()} Failed at {step.id} — {step.title}
          </Text>
        )}
        {step?.detail === undefined ? null : <Text>{'   '}{step.detail}</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          {tail.length === 0 ? 'The step printed nothing.' : `Last ${tail.length} line(s) of its output:`}
        </Text>
        {tail.map((line, index) => (
          <Text key={`${index}:${line}`} dimColor>
            {'  '}
            {line.length === 0 ? ' ' : line}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {journalPath === undefined ? (
          <Text dimColor>No journal was opened; nothing was written.</Text>
        ) : (
          <Field label="journal" value={journalPath} />
        )}
        <Text dimColor>
          {rerun === undefined
            ? `The same run is \`${CLI_NAME} deploy ${action}\`, which exits non-zero.`
            : 'Fix the cause, then continue from a shell (this one exits non-zero on failure):'}
        </Text>
        {rerun === undefined ? null : <Text color="cyan">{'  '}{rerun}</Text>}
      </Box>
    </Frame>
  );
}
