import { useState, type ReactNode } from 'react';

import { assertMovesForward, currentVersion, suggestNext } from '../../../deploy/app-version.js';
import { runCommand, withSignal } from '../../../deploy/executor.js';
import type { DeployHooks } from '../../../deploy/hooks.js';
import { DEFAULT_APPS_ROOT, deployRootFor } from '../../../deploy/layout.js';
import { readState, type DeployState } from '../../../deploy/state.js';
import { runUpdate } from '../../../deploy/update.js';
import { checkoutPathFor } from '../../../deploy/version-step.js';
import {
  advancedDefaults,
  advancedFields,
  advancedFromAnswers,
  advancedSummary,
  advancedValues,
  proxyOverrides,
  type AdvancedSettings,
} from './advanced-model.js';
import {
  AdvancedStep,
  ConfirmStep,
  FieldWizard,
  NameStep,
  ToggleStep,
  toggled,
  withFlags,
} from './fields.js';
import { optionsFromToggles, UPDATE_TOGGLES } from './flags-model.js';
import type { AppName } from './install-model.js';
import type { FieldSpec } from './model.js';
import { RunFrame, useDeployRun } from './run.js';
import { rerunCommand } from './run-model.js';

// =============================================================================
// `deploy update`, as a screen  (issue #406)
// =============================================================================
//
// `runUpdate`, with the flags the subcommand accepts actually reachable:
// --ref as a question, and --force/--no-cache/--skip-seed/--skip-proxy from
// UPDATE_TOGGLES. The screen this replaces offered none of them, so the one
// thing an operator most often wants from a TUI update - rebuild without the
// layer cache, because the build is reusing something stale - could only be
// had by leaving the TUI.
//
// ⚠ IT PASSES ITS OWN `runCommand`. The predecessor did not, which meant the
// abort controller reached every child process of install, doctor and status
// and NONE of update's: Esc during an update reported a cancel and left
// `docker compose build` running on the server. Update is the command run
// weekly, so that was the most-used path with the least honest cancel.
// =============================================================================

export interface UpdateScreenProps {
  onDone: () => void;
  /** The deployment this host already has, offered as the default name. */
  located: string | undefined;
}

/** The name, resolved, and where it runs: fixed once the Advanced step is done. */
interface Target {
  name: AppName & { resolved: string };
  settings: AdvancedSettings;
  state: DeployState | undefined;
}

type Step =
  | { kind: 'name' }
  | {
      kind: 'advanced';
      name: AppName & { resolved: string };
      defaults: AdvancedSettings;
      state: DeployState | undefined;
    }
  | { kind: 'questions'; target: Target; fields: readonly FieldSpec[] }
  | { kind: 'flags'; target: Target; answers: ReadonlyMap<string, string> }
  | { kind: 'confirm'; target: Target; answers: ReadonlyMap<string, string> };

export function UpdateScreen({ onDone, located }: UpdateScreenProps): ReactNode {
  const [step, setStep] = useState<Step>({ kind: 'name' });
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  // Off while a text field owns the keyboard, on everywhere else - including
  // during the run, where Esc is the two-press cancel.
  const escapeActive = step.kind !== 'name' && step.kind !== 'questions' && step.kind !== 'advanced';
  const run = useDeployRun({ onEscape: onDone, escapeActive });

  if (run.phase.kind !== 'idle') return <RunFrame action="update" run={run} />;

  if (step.kind === 'name') {
    return (
      <NameStep
        title="Update"
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
        title={`Update — ${step.name.display}`}
        summary={advancedSummary('update', step.defaults)}
        fields={advancedFields('update', step.defaults, step.state)}
        onComplete={(answers) => {
          const settings =
            answers === undefined ? step.defaults : advancedFromAnswers(step.defaults, answers);
          const state =
            settings.deployRoot === step.defaults.deployRoot
              ? step.state
              : recordFor(settings.deployRoot);
          setStep({
            kind: 'questions',
            target: { name: step.name, settings, state },
            fields: updateFields(state, settings.deployRoot),
          });
        }}
      />
    );
  }

  if (step.kind === 'questions') {
    return (
      <FieldWizard
        title={`Update — ${step.target.name.display}`}
        subtitle={`At ${step.target.settings.deployRoot}`}
        fields={step.fields}
        onComplete={(answers) => {
          setStep({ kind: 'flags', target: step.target, answers });
        }}
      />
    );
  }

  if (step.kind === 'flags') {
    return (
      <ToggleStep
        title={`Update — ${step.target.name.display}`}
        toggles={UPDATE_TOGGLES}
        chosen={chosen}
        onToggle={(flag) => {
          setChosen((current) => toggled(current, flag));
        }}
        onContinue={() => {
          setStep({ kind: 'confirm', target: step.target, answers: step.answers });
        }}
      />
    );
  }

  return (
    <ConfirmStep
      action="update"
      answers={withFlags(
        new Map([
          ...advancedValues('update', step.target.settings, step.target.state),
          ...step.answers,
        ]),
        chosen,
      )}
      onNo={() => {
        setStep({ kind: 'flags', target: step.target, answers: step.answers });
      }}
      onYes={() => {
        const target = step.target;
        const answers = step.answers;
        const flags = chosen;
        run.start(
          async (signal, hooks) => await performUpdate(target, answers, flags, signal, hooks),
          {
            rerun: rerunCommand({
              action: 'update',
              name: target.name.resolved,
              values: new Map([
                ...advancedValues('update', target.settings, target.state),
                ['__ref', answers.get('__ref') ?? ''],
              ]),
              chosen: flags,
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
    // ⚠ An UNREADABLE record is not an absent one, but for prefilling the two
    // are the same: there is nothing to offer. `runUpdate` reports the real
    // problem properly, with the message this screen has no business guessing.
    return undefined;
  }
}

/**
 * The text-valued flags update takes.
 *
 * ⚠ `__ref`'s placeholder is the RECORDED ref, so pressing Enter through it
 * keeps the branch this deployment is actually following. An empty
 * placeholder stores `''`, which the call below reads as "not given" and
 * leaves off entirely - `runUpdate` then follows whatever the state records,
 * rather than being told to move to a ref the operator never typed.
 *
 * ⚠ `__app_version`'s placeholder is a COMPUTED SUGGESTION, not a fact on
 * disk like every other prefilled field here - which is exactly why its
 * value never reaches the printed rerun command (`rerunCommand` only emits a
 * flag it finds in the values map it is given, and update.tsx's `onYes`
 * deliberately does not add this field to that map): a suggestion computed
 * now and replayed verbatim later, after the real "current version" has
 * moved, would pin the wrong number rather than re-suggest a fresh one.
 */
export function updateFields(state: DeployState | undefined, deployRoot: string): FieldSpec[] {
  const current = currentVersion(checkoutPathFor(deployRoot));
  const suggested = suggestNext(current);

  return [
    {
      key: '__ref',
      label: 'ref',
      help: 'Branch, tag or commit to move to. Empty follows the one this deployment already tracks.',
      placeholder: state?.ref ?? '',
      secret: false,
      prefilled: state?.ref !== undefined,
    },
    {
      key: '__app_version',
      label: 'version',
      help: `Release version this deploy is recorded as. Must sort above the current one (${current}).`,
      placeholder: suggested,
      secret: false,
      prefilled: true,
      validate: (value) => {
        if (value === '') return undefined;
        try {
          assertMovesForward(value, current);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
  ];
}

export async function performUpdate(
  target: Target,
  answers: ReadonlyMap<string, string>,
  chosen: ReadonlySet<string>,
  signal: AbortSignal,
  hooks: DeployHooks,
): Promise<string[]> {
  const ref = answers.get('__ref') ?? '';
  const appVersion = answers.get('__app_version') ?? '';

  const result = await runUpdate({
    deployRoot: target.settings.deployRoot,
    // Only what OVERRIDES the record; see `proxyOverrides`.
    ...proxyOverrides(target.settings, target.state),
    // Load-bearing: without it the abort reaches nothing. See the file header.
    runCommand: withSignal(runCommand, signal),
    // readline cannot ask a question while ink holds stdin in raw mode, so the
    // values were collected above and the wizard runs with nothing left to ask.
    nonInteractive: true,
    ...(ref === '' ? {} : { ref }),
    // Empty means "the suggestion was fine", exactly like `ref` above -- the
    // version step then suggests its own patch bump, computed fresh rather
    // than reusing what this screen prefilled minutes ago.
    ...(appVersion === '' ? {} : { appVersion }),
    // `--no-version-bump` and every other toggle land here as their real
    // option keys; `flags-model.test.ts` asserts the list against the
    // subcommand's own Commander definitions, so a toggle for a flag the CLI
    // does not declare is a failing test rather than a control that does
    // nothing.
    ...optionsFromToggles(UPDATE_TOGGLES, chosen),
    hooks,
  });

  return result.changed
    ? [`Updated to ${result.commitSha.slice(0, 12)}.`, `Log: ${result.journalPath}`]
    : ['Already up to date.'];
}
