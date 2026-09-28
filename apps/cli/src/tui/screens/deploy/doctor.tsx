import { Box, Text } from 'ink';
import { useState, type ReactNode } from 'react';

import { ALL_CHECKS, runChecks, type CompletedCheck } from '../../../deploy/checks/index.js';
import { runCommand, withSignal } from '../../../deploy/executor.js';
import type { DeployHooks } from '../../../deploy/hooks.js';
import { DEFAULT_APPS_ROOT, deployRootFor } from '../../../deploy/layout.js';
import { describeProxyRuntime, resolveRecordedProxyRuntime } from '../../../deploy/proxy.js';
import { readState, type DeployState } from '../../../deploy/state.js';
import { Frame } from '../../layout.js';
import {
  advancedDefaults,
  advancedFields,
  advancedFromAnswers,
  advancedSummary,
  advancedValues,
  proxyOverrides,
  type AdvancedSettings,
} from './advanced-model.js';
import { doctorLine, groupDoctorResults, type DoctorReport } from './doctor-model.js';
import { AdvancedStep, FieldWizard, NameStep, optionalHostname } from './fields.js';
import { seedAt, type AppName } from './install-model.js';
import type { FieldSpec } from './model.js';
import { RunFrame, useDeployRun } from './run.js';
import { rerunCommand } from './run-model.js';

// =============================================================================
// `deploy doctor`, as a screen  (issue #406)
// =============================================================================
//
// It calls `runChecks` with the same context `runDoctorCommand` builds, and
// renders the stream of results instead of writing them to stderr. There is no
// confirmation step and there is nothing to undo: checks are READ-ONLY by
// contract (checks/types.ts rule 4), which is what makes doctor safe to run
// against a production server at any time.
//
// ⚠ ROOT, PROXY ROOT AND PORT ARE ASKED FOR, NOT ASSUMED. The screen this
// replaces hardcoded all three, so a deployment installed anywhere else was
// checked against a directory it does not live in - every answer correct about
// the wrong server. They live on the Advanced step (issue #393), prefilled from
// the record and skipped with one Enter, alongside the proxy container/mode.
//
// ⚠ THE RESULT IS GROUPED, WITH REMEDIES. Fail, warn, pass, skip - each with
// its glyph as well as its colour, and the remedy beneath every failure and
// warning. See doctor-model.ts.
// =============================================================================

export interface DoctorScreenProps {
  onDone: () => void;
  /** The deployment this host already has, offered as the default name. */
  located: string | undefined;
}

const DOCTOR_FIELDS: readonly FieldSpec[] = [
  {
    key: '__domain',
    label: 'domain',
    help: 'Optional. Empty skips the DNS and TLS checks rather than running them against a guess.',
    placeholder: '',
    secret: false,
    prefilled: false,
    validate: optionalHostname,
  },
];

type Step =
  | { kind: 'name' }
  | {
      kind: 'advanced';
      name: AppName & { resolved: string };
      defaults: AdvancedSettings;
      state: DeployState | undefined;
    }
  | {
      kind: 'questions';
      name: AppName & { resolved: string };
      settings: AdvancedSettings;
      state: DeployState | undefined;
    };

export function DoctorScreen({ onDone, located }: DoctorScreenProps): ReactNode {
  const [step, setStep] = useState<Step>({ kind: 'name' });
  // The full results, kept so the done frame can group them. Set only by the
  // run itself, just before it resolves.
  const [report, setReport] = useState<DoctorReport | undefined>(undefined);
  // Every step before the run is a text field or the Advanced step, so Esc is
  // off until the run starts - after which it is the cancel. `started` rather
  // than the run's own phase because the phase is what the hook returns, and
  // the hook needs this.
  const [started, setStarted] = useState(false);
  const run = useDeployRun({ onEscape: onDone, escapeActive: started });

  if (run.phase.kind === 'done' && report !== undefined) return <DoctorReportFrame report={report} />;
  if (run.phase.kind !== 'idle') return <RunFrame action="doctor" run={run} />;

  if (step.kind === 'name') {
    return (
      <NameStep
        title="Doctor"
        located={located}
        appsRoot={DEFAULT_APPS_ROOT}
        onSubmit={(name) => {
          const resolved = name.resolved;
          if (resolved === undefined) return;
          const state = recordFor(deployRootFor(DEFAULT_APPS_ROOT, resolved));
          setStep({
            kind: 'advanced',
            name: { ...name, resolved },
            defaults: advancedDefaults(DEFAULT_APPS_ROOT, resolved, state),
            state,
          });
        }}
      />
    );
  }

  if (step.kind === 'advanced') {
    return (
      <AdvancedStep
        title={`Doctor — ${step.name.display}`}
        summary={advancedSummary('doctor', step.defaults)}
        fields={advancedFields('doctor', step.defaults, step.state)}
        onComplete={(answers) => {
          const settings =
            answers === undefined ? step.defaults : advancedFromAnswers(step.defaults, answers);
          const state =
            settings.deployRoot === step.defaults.deployRoot
              ? step.state
              : recordFor(settings.deployRoot);
          setStep({ kind: 'questions', name: step.name, settings, state });
        }}
      />
    );
  }

  return (
    <FieldWizard
      title={`Doctor — ${step.name.display}`}
      subtitle={`At ${step.settings.deployRoot}`}
      fields={DOCTOR_FIELDS}
      onComplete={(answers) => {
        // ⚠ `name.resolved`, never `name.display`. A fallback display name must
        // not reach a path or a port probe; `NameStep` refuses to submit an
        // unresolved name, which is what makes this narrowing sound.
        const { name, settings, state } = step;
        const domain = answers.get('__domain') ?? '';
        setStarted(true);
        run.start(
          async (signal, hooks) =>
            await performDoctor(
              { name: name.resolved, settings, state, domain },
              signal,
              hooks,
              setReport,
            ),
          {
            rerun: rerunCommand({
              action: 'doctor',
              name: name.resolved,
              values: new Map([
                ...advancedValues('doctor', settings, state),
                ['__domain', domain],
              ]),
              chosen: new Set(),
            }),
          },
        );
      }}
    />
  );
}

/** The state recorded for a deployment, or undefined when there is none to read. */
function recordFor(deployRoot: string): DeployState | undefined {
  try {
    return readState(deployRoot);
  } catch {
    // Doctor's job includes reporting an unreadable record; it is not this
    // step's to guess about. Prefill as if there were none.
    return undefined;
  }
}

/**
 * The grouped result: fail, warn, pass, skip.
 *
 * ⚠ The verdict is in the TITLE as a word, not only in a colour, and each row
 * leads with the same glyph the subcommand prints. The TUI exits 0 either way,
 * so this frame is the only place a failed doctor is carried.
 */
function DoctorReportFrame({ report }: { report: DoctorReport }): ReactNode {
  return (
    <Frame
      title={`doctor — ${report.passed ? 'passed' : 'FAILED'}`}
      hints={['esc return to the menu']}
    >
      <Text color={report.passed ? 'green' : 'red'} bold>
        {report.passed ? 'All required checks passed' : 'Required checks failed'} — {report.headline}
      </Text>
      {report.groups.map((group) => (
        <Box key={group.status} marginTop={1} flexDirection="column">
          <Text color={group.colour} bold>
            {group.glyph} {group.heading} ({group.items.length})
          </Text>
          {group.items.map((item) => (
            <Box key={item.id} flexDirection="column">
              <Text>
                <Text color={group.colour}>{'  '}{group.glyph} </Text>
                {item.title}
                {item.optional ? ' (recommended, not required)' : ''}
                <Text dimColor>  {item.detail}</Text>
              </Text>
              {item.remedy === undefined ? null : (
                <Text>
                  {'     -> '}
                  {item.remedy}
                </Text>
              )}
            </Box>
          ))}
        </Box>
      ))}
    </Frame>
  );
}

/**
 * Runs the checks.
 *
 * ⚠ THE SAME FUNCTION THE SUBCOMMAND CALLS, with the same context shape.
 * Anything this computed for itself would be a second answer to a question
 * `runDoctorCommand` already answers.
 */
async function performDoctor(
  target: {
    name: string;
    settings: AdvancedSettings;
    state: DeployState | undefined;
    domain: string;
  },
  signal: AbortSignal,
  hooks: DeployHooks,
  onReport: (report: DoctorReport) => void,
): Promise<string[]> {
  const { settings, domain } = target;
  const deployRoot = settings.deployRoot;
  // The deployment's own environment, so the database checks have credentials
  // to probe with. `runDoctorCommand` reads it for the same reason; this goes
  // through `seedFor`, which knows both the current `.env` location and the
  // legacy one, so an older deployment is not checked with no environment at
  // all merely because its file is in the other place.
  const seed = seedAt(deployRoot, target.name);

  // Every child process runs under the screen's signal, so Esc reaches it.
  const run = withSignal(runCommand, signal);
  const proxyRoot = settings.proxyRoot;

  // Same resolution as `deploy doctor`: the flags, else the record, else
  // detection. The flags are the Advanced step's overrides, and nothing else.
  const overrides = proxyOverrides(settings, target.state);
  const proxyRuntime = await resolveRecordedProxyRuntime({
    proxyRoot,
    flags: { mode: overrides.proxyMode, container: overrides.proxyContainer },
    recorded: target.state,
    runCommand: run,
  });
  hooks.onLog?.(describeProxyRuntime(proxyRuntime));

  const results: CompletedCheck[] = await runChecks(
    ALL_CHECKS,
    {
      runCommand: run,
      deployRoot,
      bindPort: settings.bindPort,
      proxyRoot,
      proxyRuntime,
      ...(domain === '' ? {} : { domain }),
      ...(seed.values.size === 0 ? {} : { env: seed.values }),
    },
    // Glyph first, as the subcommand prints it: the stream is read while it
    // scrolls, and a glyph survives a terminal with no colour.
    (result) => hooks.onLog?.(doctorLine(result)),
  );

  // Handed to the screen BEFORE resolving, so the done frame that follows is
  // the grouped one rather than the plain summary below.
  const report = groupDoctorResults(results);
  onReport(report);
  return [report.headline];
}
