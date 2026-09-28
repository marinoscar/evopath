import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState, type ReactNode } from 'react';

import type { EnvGroup } from '../../../deploy/env-metadata.js';
import { parseEnvExample, type EnvVarSpec } from '../../../deploy/env-spec.js';
import { runCommand, withSignal } from '../../../deploy/executor.js';
import type { DeployHooks } from '../../../deploy/hooks.js';
import { runInstall } from '../../../deploy/install.js';
import { DEFAULT_APPS_ROOT, deployRootFor } from '../../../deploy/layout.js';
import { readState, type DeployState } from '../../../deploy/state.js';
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
import { INSTALL_TOGGLES, optionsFromToggles, VALUE_FLAGS } from './flags-model.js';
import {
  decideResume,
  envAnswers,
  installFields,
  reconcileSeed,
  seedAt,
  EMPTY_SEED,
  type AppName,
  type ResumeDecision,
  type Seed,
} from './install-model.js';
import type { FieldSpec } from './model.js';
import { RunFrame, useDeployRun } from './run.js';
import { rerunCommand } from './run-model.js';

// =============================================================================
// `deploy install`, as a screen  (issue #406, epic #397)
// =============================================================================
//
// The order of the first two steps is the whole design, and it is not
// negotiable:
//
//   1. RESOLVE THE NAME. Everything else is keyed on it - the path, the `.env`
//      that is read, the record that is consulted.
//   2. SEED FROM THAT DEPLOYMENT'S OWN `.env`, then build the questions with
//      the seeded values as their PLACEHOLDERS.
//
// Step 2 is what makes a re-run safe. The environment wizard generates a value
// for an EMPTY answer, so a screen that always started blank minted a fresh
// `JWT_SECRET`, `COOKIE_SECRET` and `SECRETS_ENCRYPTION_KEY` on every re-run -
// and the last of those makes every stored credential in the database
// permanently undecryptable. Prefilling fixes it BY CONSTRUCTION rather than by
// a guard: there is no empty answer left for the generator to fire on.
//
// ⚠ A CHANGED NAME THROWS THE SEED AWAY. The name is a field, so an operator
// typing a neighbour's name reads that neighbour's `.env` on the way past.
// `reconcileSeed` runs on EVERY keystroke of the name field, because a seed
// kept from a neighbour would prefill this install with their database password
// and their secrets, and an operator pressing Enter through the defaults would
// confirm it.
//
// ⚠ WHERE IT RUNS IS STEP 1½. The Advanced step (issue #393) comes between
// the name and the questions, because it can move the deploy root -- and the
// root is what the seed, the record and the template are read from. It opens
// on "Use these" with the recorded values, so the common path costs one Enter.
//
// ⚠ RESUME IS DECIDED, NOT ASKED. See `decideResume` and `NOT_IN_TUI` in
// flags-model.ts: whether the collected answers still match the file is a fact
// this screen knows and an operator should not have to assert.
// =============================================================================

export interface InstallScreenProps {
  onDone: () => void;
  /** The deployment this host already has, offered as the default name. */
  located: string | undefined;
}

/** The name, resolved, and where it runs: fixed once the Advanced step is done. */
interface Target {
  name: AppName & { resolved: string };
  settings: AdvancedSettings;
  /** The record at `settings.deployRoot`, read once. */
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
  | {
      kind: 'confirm';
      target: Target;
      answers: ReadonlyMap<string, string>;
      resume: ResumeDecision;
    };

export function InstallScreen({ onDone, located }: InstallScreenProps): ReactNode {
  const [step, setStep] = useState<Step>({ kind: 'name' });
  // The values already on disk for the RESOLVED deployment. Held in state
  // rather than recomputed, because `reconcileSeed` must be able to retract it.
  const [seed, setSeed] = useState<Seed>(EMPTY_SEED);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  // Off while a text field owns the keyboard, on everywhere else - including
  // during the run, where Esc is the two-press cancel.
  const escapeActive = step.kind !== 'name' && step.kind !== 'questions' && step.kind !== 'advanced';
  const run = useDeployRun({ onEscape: onDone, escapeActive });

  if (run.phase.kind !== 'idle') return <RunFrame action="install" run={run} />;

  if (step.kind === 'name') {
    return (
      <NameStep
        title="Install"
        located={located}
        appsRoot={DEFAULT_APPS_ROOT}
        // ⚠ Every keystroke, not only the submission. A seed belonging to the
        // name that WAS typed is stale the moment the name changes.
        onChange={(name) => {
          setSeed((current) => reconcileSeed(current, name.resolved));
        }}
        onSubmit={(name) => {
          // ⚠ `name.resolved` is the only thing allowed to reach a seed or a
          // path. `name.display` exists for the titles below and nothing else.
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
        title={`Install — ${step.name.display}`}
        summary={advancedSummary('install', step.defaults)}
        fields={advancedFields('install', step.defaults, step.state)}
        onComplete={(answers) => {
          const settings =
            answers === undefined ? step.defaults : advancedFromAnswers(step.defaults, answers);
          // A moved root is a different deployment on disk: its own record,
          // its own `.env`, its own template. Re-read all three from there.
          const state =
            settings.deployRoot === step.defaults.deployRoot
              ? step.state
              : recordFor(settings.deployRoot);
          const fresh = seedAt(settings.deployRoot, step.name.resolved);
          setSeed(fresh);
          const target: Target = { name: step.name, settings, state };
          setStep({
            kind: 'questions',
            target,
            fields: [
              ...installFields(loadSpecs(settings.deployRoot), fresh),
              ...installFlagFields(state, fresh),
            ],
          });
        }}
      />
    );
  }

  if (step.kind === 'questions') {
    return (
      <FieldWizard
        title={`Install — ${step.target.name.display}`}
        subtitle={`Into ${step.target.settings.deployRoot}`}
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
        title={`Install — ${step.target.name.display}`}
        toggles={INSTALL_TOGGLES}
        chosen={chosen}
        onToggle={(flag) => {
          setChosen((current) => toggled(current, flag));
        }}
        onContinue={() => {
          setStep({
            kind: 'confirm',
            target: step.target,
            answers: step.answers,
            resume: decideResumeFor(step.target.settings.deployRoot, step.answers, seed),
          });
        }}
      />
    );
  }

  return (
    <ConfirmStep
      action="install"
      // `__name` is carried as an answer of its own so the deployment being
      // written to is on the review, not merely in the frame's title. It is a
      // screen field, so `envAnswers` strips it before it can reach the `.env`.
      answers={withFlags(
        new Map([
          ['__name', step.target.name.display],
          ...advancedValues('install', step.target.settings, step.target.state),
          ...step.answers,
        ]),
        chosen,
      )}
      notes={[
        // Every branch of `decideResume` names a reason, including the yeses,
        // and the operator sees it before agreeing to anything.
        `Resume: ${step.resume.resume ? 'yes' : 'no'} — ${step.resume.reason}`,
      ]}
      onNo={() => {
        setStep({ kind: 'flags', target: step.target, answers: step.answers });
      }}
      onYes={() => {
        const target = step.target;
        const answers = step.answers;
        const flags = chosen;
        const resume = step.resume.resume;
        run.start(
          async (signal, hooks) => await performInstall(target, answers, flags, resume, signal, hooks),
          { rerun: installRerun(target, answers, flags) },
        );
      }}
    />
  );
}

/**
 * The shell command that continues this install, shown if it fails.
 *
 * ⚠ Built from the screen fields `VALUE_FLAGS` names and the toggles ONLY --
 * never from the environment answers, which is where the secrets are.
 */
function installRerun(
  target: Target,
  answers: ReadonlyMap<string, string>,
  chosen: ReadonlySet<string>,
): string {
  const fields = new Set(VALUE_FLAGS.install.map((flag) => flag.field));
  return rerunCommand({
    action: 'install',
    name: target.name.resolved,
    values: new Map([
      ...advancedValues('install', target.settings, target.state),
      ...[...answers].filter(([key]) => fields.has(key)),
    ]),
    chosen,
  });
}

/**
 * The template the questions are derived from.
 *
 * Read from the RESOLVED deployment's own checkout, because a fork's
 * `.env.example` is the specification of its own environment and no other
 * deployment's will do.
 */
function loadSpecs(deployRoot: string): EnvVarSpec[] {
  try {
    return parseEnvExample(
      readFileSync(join(deployRoot, 'repo', 'infra', 'compose', '.env.example'), 'utf8'),
    );
  } catch {
    // Before a first checkout there is no template to read; the domain
    // question alone is still enough to get started.
    return [];
  }
}

/** The state recorded for a deployment, or undefined when there is none to read. */
function recordFor(deployRoot: string): DeployState | undefined {
  try {
    return readState(deployRoot);
  } catch {
    // ⚠ An UNREADABLE record is not an absent one, but for prefilling the two
    // are the same. `runInstall` reports the real problem properly.
    return undefined;
  }
}

/**
 * The text-valued flags, prefilled from what this deployment already records.
 *
 * Proxy root and port are not here: they moved to the Advanced step, which
 * prefills them from the same record and is skipped with one Enter.
 *
 * ⚠ THE PLACEHOLDER IS THE RECORDED VALUE, for exactly the reason the
 * environment fields' are. A deployment installed on a non-default proxy root
 * or port, re-installed by pressing Enter through a form that offered the
 * DEFAULTS, would be moved to a port nothing forwards to and a vhost directory
 * the proxy does not read - silently, and reported as a success.
 *
 * ⚠ An optional flag's placeholder is EMPTY, never a description. The wizard
 * stores the placeholder for an empty submission, so a hint in that slot would
 * become the answer; `performInstall` reads `''` as "not given" and leaves the
 * option off the call.
 */
function installFlagFields(state: DeployState | undefined, seed: Seed): FieldSpec[] {
  return [
    {
      key: '__repo',
      label: 'repo',
      help: "Repository to deploy. Empty uses this checkout's own origin, so a fork deploys itself.",
      placeholder: state?.repoUrl ?? '',
      secret: false,
      prefilled: state?.repoUrl !== undefined,
    },
    {
      key: '__ref',
      label: 'ref',
      help: "Branch, tag or commit. Empty uses the remote's default branch.",
      placeholder: state?.ref ?? '',
      secret: false,
      prefilled: state?.ref !== undefined,
    },
    {
      key: '__email',
      label: 'email',
      help: "Certificate registration address. Let's Encrypt sends expiry warnings here.",
      // The deployment's own admin address is the one the certs command falls
      // back to, so offering it here keeps the two from disagreeing.
      placeholder: seed.values.get('INITIAL_ADMIN_EMAIL') ?? '',
      secret: false,
      prefilled: seed.values.has('INITIAL_ADMIN_EMAIL'),
      validate: (value) =>
        value === '' || value.includes('@') ? undefined : 'must be an email address',
    },
    {
      key: '__group',
      label: 'group',
      help: `Optional feature groups, comma-separated: ${GROUP_NAMES.join(', ')}. Their variables are skipped otherwise.`,
      placeholder: (state?.groups ?? []).join(', '),
      secret: false,
      prefilled: (state?.groups ?? []).length > 0,
      validate: validateGroups,
    },
  ];
}

/**
 * ⚠ Exhaustive BY CONSTRUCTION. `EnvGroup` is a union with no runtime list, so
 * this record is how a new member becomes a compile error here rather than a
 * value the screen silently refuses.
 */
const GROUP_RECORD: Readonly<Record<EnvGroup, true>> = Object.freeze({
  observability: true,
  email: true,
  'microsoft-oauth': true,
});

const GROUP_NAMES: readonly string[] = Object.keys(GROUP_RECORD);

function splitGroups(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

function validateGroups(value: string): string | undefined {
  const unknown = splitGroups(value).filter((name) => !(name in GROUP_RECORD));
  return unknown.length === 0
    ? undefined
    : `must name only ${GROUP_NAMES.join(', ')}; got ${unknown.join(', ')}`;
}

/** Narrowed rather than cast, so an unknown group cannot reach `runInstall`. */
function selectedGroups(value: string): EnvGroup[] {
  return splitGroups(value).filter((name): name is EnvGroup => name in GROUP_RECORD);
}

/**
 * Whether this run may resume, asked of the model.
 *
 * ⚠ AN UNREADABLE RECORD IS NOT A RESUMABLE ONE. `readState` throws when the
 * file is there and this build cannot interpret it, which is a different
 * condition from "nothing has been attempted here" and must not be flattened
 * into it: resuming exempts the "already exists" guard, so a wrong yes here
 * skips every recorded step and reports an install that did nothing.
 */
function decideResumeFor(
  deployRoot: string,
  answers: ReadonlyMap<string, string>,
  seed: Seed,
): ResumeDecision {
  let state: DeployState | undefined;
  try {
    state = readState(deployRoot);
  } catch {
    return {
      resume: false,
      reason: 'the deployment record here cannot be read, so no step may be skipped',
    };
  }

  return decideResume({
    state,
    answers: envAnswers(answers),
    // What the deployment's `.env` holds right now. The seed IS that file, read
    // once when the name resolved and retracted whenever it changed.
    onDisk: seed.values,
  });
}

async function performInstall(
  target: Target,
  answers: ReadonlyMap<string, string>,
  chosen: ReadonlySet<string>,
  resume: boolean,
  signal: AbortSignal,
  hooks: DeployHooks,
): Promise<string[]> {
  const domain = answers.get('__domain') ?? '';
  const repo = answers.get('__repo') ?? '';
  const ref = answers.get('__ref') ?? '';
  const email = answers.get('__email') ?? '';
  const groups = selectedGroups(answers.get('__group') ?? '');

  const result = await runInstall({
    deployRoot: target.settings.deployRoot,
    // Load-bearing: every child process runs under the screen's signal, so
    // aborting the controller SIGTERMs the `docker compose build` rather than
    // leaving it running on a production server.
    runCommand: withSignal(runCommand, signal),
    bindPort: target.settings.bindPort,
    proxyRoot: target.settings.proxyRoot,
    // Only what OVERRIDES the record; see `proxyOverrides`.
    ...proxyOverrides(target.settings, target.state),
    // ⚠ Screen fields stripped. `runInstall` writes `answers` into the `.env`
    // as template keys, so a `__domain` reaching it becomes a variable of that
    // name in a production environment file.
    answers: envAnswers(answers),
    // readline cannot ask a question while ink holds stdin in raw mode, so the
    // values were collected above and the wizard runs with nothing left to ask.
    nonInteractive: true,
    // ⚠ Only when the model said so. See `decideResume`.
    ...(resume ? { resume: true } : {}),
    ...(domain === '' ? {} : { domain }),
    ...(repo === '' ? {} : { repo }),
    ...(ref === '' ? {} : { ref }),
    ...(email === '' ? {} : { email }),
    ...(groups.length === 0 ? {} : { groups }),
    // `--no-version-bump` and every other toggle land here as their real
    // option keys; `flags-model.test.ts` asserts the list against the
    // subcommand's own Commander definitions, so a toggle for a flag the CLI
    // does not declare is a failing test rather than a control that does
    // nothing.
    ...optionsFromToggles(INSTALL_TOGGLES, chosen),
    hooks,
  });

  return [`Installed ${result.commitSha.slice(0, 12)}.`, `Log: ${result.journalPath}`, '', result.nextStep];
}
