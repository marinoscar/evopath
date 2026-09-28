/**
 * The Advanced step: where the deployment lives and how its proxy runs.
 * (issue #393, epic #388 Phase E)
 *
 * Pure. No ink, no React. The screens render `advancedFields` through the same
 * `FieldWizard` every other question goes through, and read the answers back
 * with `advancedFromAnswers`.
 *
 * =============================================================================
 * ⚠ WHY THIS STEP EXISTS, AND WHY IT IS SKIPPABLE
 * =============================================================================
 *
 * The screens hardcoded the deploy root to `<apps root>/<name>` and had no way
 * to reach `--proxy-container` or `--proxy-mode` at all. A second application
 * on the same box needs a different bind port BY DEFINITION, so the TUI could
 * not install one.
 *
 * But every one of these has a right answer for the ordinary case -- the
 * recorded value, else the subcommand's own default -- so the step opens on a
 * summary of those answers with "Use these" selected. One Enter, and the
 * common path is exactly as long as it was.
 *
 * ⚠ PREFILLED FROM THE RECORD, NOT FROM THE CLI DEFAULTS. A deployment
 * installed on port 3536, re-installed by pressing Enter through a form that
 * offered 3535, would be moved to a port nothing forwards to -- silently, and
 * reported as a success. The record is what this deployment actually runs on.
 *
 * ⚠ `auto` IS "NO FLAG", NOT "DETECT AGAIN". The pipelines resolve the proxy
 * runtime as flag, else record, else detection (`resolveRecordedProxyRuntime`).
 * Choosing `auto` passes no `proxyMode`, so a recorded mode still wins -- which
 * is why the mode field's placeholder is the recorded mode when there is one:
 * the screen shows what will actually happen rather than a word that sounds
 * like it overrides the record and does not.
 * =============================================================================
 */
import { isAbsolute } from 'node:path';

import { DEFAULT_BIND_PORT, DEFAULT_PROXY_ROOT } from '../../../commands/deploy.js';
import { deployRootFor } from '../../../deploy/layout.js';
import {
  assertValidContainerName,
  DEFAULT_PROXY_CONTAINER,
  PROXY_MODES,
  type ProxyMode,
} from '../../../deploy/proxy.js';
import type { DeployState } from '../../../deploy/state.js';
import type { RunnableAction } from './flags-model.js';
import { validatePort } from './install-model.js';
import type { FieldSpec } from './model.js';

/** `auto` means "pass no --proxy-mode": as recorded, else detected. */
export type ProxyModeChoice = ProxyMode | 'auto';

export const PROXY_MODE_CHOICES: readonly ProxyModeChoice[] = ['auto', ...PROXY_MODES];

export interface AdvancedSettings {
  deployRoot: string;
  proxyRoot: string;
  bindPort: number;
  proxyContainer: string;
  proxyMode: ProxyModeChoice;
}

export type AdvancedKey = keyof AdvancedSettings;

/**
 * Which settings each screen asks about.
 *
 * ⚠ `update` takes no proxy root and no port: the subcommand declares neither,
 * and reads both off the record. Offering them would be a control that does
 * nothing -- the exact lie `flags-model.test` exists to catch.
 */
export const ADVANCED_KEYS: Readonly<Record<RunnableAction, readonly AdvancedKey[]>> =
  Object.freeze({
    doctor: ['deployRoot', 'proxyRoot', 'bindPort', 'proxyContainer', 'proxyMode'],
    install: ['deployRoot', 'proxyRoot', 'bindPort', 'proxyContainer', 'proxyMode'],
    update: ['deployRoot', 'proxyContainer', 'proxyMode'],
  });

/** The screen field each setting is asked through. Also the `VALUE_FLAGS` field. */
export const ADVANCED_FIELD: Readonly<Record<AdvancedKey, string>> = Object.freeze({
  deployRoot: '__root',
  proxyRoot: '__proxyRoot',
  bindPort: '__port',
  proxyContainer: '__proxyContainer',
  proxyMode: '__proxyMode',
});

/** What a deployment records about where it runs. All optional: there may be no record. */
export type RecordedPlacement = Partial<
  Pick<DeployState, 'proxyRoot' | 'bindPort' | 'proxyMode' | 'proxyContainer'>
>;

/** The answers the step opens with: the record, else the subcommand's defaults. */
export function advancedDefaults(
  appsRoot: string,
  name: string,
  recorded: RecordedPlacement | undefined,
): AdvancedSettings {
  return {
    deployRoot: deployRootFor(appsRoot, name),
    proxyRoot: recorded?.proxyRoot ?? DEFAULT_PROXY_ROOT,
    bindPort: recorded?.bindPort ?? DEFAULT_BIND_PORT,
    proxyContainer: recorded?.proxyContainer ?? DEFAULT_PROXY_CONTAINER,
    proxyMode: recorded?.proxyMode ?? 'auto',
  };
}

// --- validators -------------------------------------------------------------
// Each returns a message fragment the wizard prefixes with the field's label,
// or undefined. They reuse the CLI's own validators rather than restating them,
// so a value the screen accepts is one the subcommand accepts.

export function validateAbsolutePath(value: string): string | undefined {
  return isAbsolute(value) && !value.includes('\0') ? undefined : 'must be an absolute path';
}

export function validateContainerName(value: string): string | undefined {
  try {
    assertValidContainerName(value);
    return undefined;
  } catch {
    return 'must be a container name: a letter or digit, then letters, digits, dot, dash or underscore';
  }
}

export function validateProxyModeChoice(value: string): string | undefined {
  return (PROXY_MODE_CHOICES as readonly string[]).includes(value)
    ? undefined
    : `must be one of ${PROXY_MODE_CHOICES.join(', ')}`;
}

/** The step's text form, for an operator who chose to change something. */
export function advancedFields(
  action: RunnableAction,
  defaults: AdvancedSettings,
  recorded: RecordedPlacement | undefined,
): FieldSpec[] {
  const all: Record<AdvancedKey, FieldSpec> = {
    deployRoot: {
      key: ADVANCED_FIELD.deployRoot,
      label: 'root',
      help: 'The deployment directory. Everything this run reads and writes is under it.',
      placeholder: defaults.deployRoot,
      secret: false,
      prefilled: false,
      validate: validateAbsolutePath,
    },
    proxyRoot: {
      key: ADVANCED_FIELD.proxyRoot,
      label: 'proxy-root',
      help: 'The shared reverse proxy this host runs. The vhost and certificate are written under it.',
      placeholder: defaults.proxyRoot,
      secret: false,
      prefilled: recorded?.proxyRoot !== undefined,
      validate: validateAbsolutePath,
    },
    bindPort: {
      key: ADVANCED_FIELD.bindPort,
      label: 'port',
      help: 'Loopback port the proxy forwards to. One per application on this host.',
      placeholder: String(defaults.bindPort),
      secret: false,
      prefilled: recorded?.bindPort !== undefined,
      validate: validatePort,
    },
    proxyContainer: {
      key: ADVANCED_FIELD.proxyContainer,
      label: 'proxy-container',
      help: `Name of the shared proxy container. Default: as recorded, else ${DEFAULT_PROXY_CONTAINER}.`,
      placeholder: defaults.proxyContainer,
      secret: false,
      prefilled: recorded?.proxyContainer !== undefined,
      validate: validateContainerName,
    },
    proxyMode: {
      key: ADVANCED_FIELD.proxyMode,
      label: 'proxy-mode',
      help: 'How the shared proxy runs: container, host, or auto (as recorded, else detected).',
      placeholder: defaults.proxyMode,
      secret: false,
      prefilled: recorded?.proxyMode !== undefined,
      validate: validateProxyModeChoice,
    },
  };
  return ADVANCED_KEYS[action].map((key) => all[key]);
}

/**
 * The settings, from the form's answers.
 *
 * A key the form did not ask (update's port, say) keeps its default. Values
 * are assumed already validated by the wizard; a value that somehow is not
 * falls back to the default rather than reaching a path or an argv.
 */
export function advancedFromAnswers(
  defaults: AdvancedSettings,
  answers: ReadonlyMap<string, string>,
): AdvancedSettings {
  const read = (key: AdvancedKey, validate: (value: string) => string | undefined): string | undefined => {
    const value = answers.get(ADVANCED_FIELD[key]);
    return value === undefined || value === '' || validate(value) !== undefined ? undefined : value;
  };

  const deployRoot = read('deployRoot', validateAbsolutePath);
  const proxyRoot = read('proxyRoot', validateAbsolutePath);
  const port = read('bindPort', validatePort);
  const container = read('proxyContainer', validateContainerName);
  const mode = read('proxyMode', validateProxyModeChoice);

  return {
    deployRoot: deployRoot ?? defaults.deployRoot,
    proxyRoot: proxyRoot ?? defaults.proxyRoot,
    bindPort: port === undefined ? defaults.bindPort : Number(port),
    proxyContainer: container ?? defaults.proxyContainer,
    proxyMode: (mode as ProxyModeChoice | undefined) ?? defaults.proxyMode,
  };
}

/**
 * The proxy-runtime OPTIONS a pipeline should be given.
 *
 * Only what differs from what the pipeline would resolve on its own (flag,
 * else record, else detection): an unchanged value is left off, so the run
 * behaves exactly as `deploy <action>` with no proxy flags -- and the re-run
 * command printed after a failure carries no flag the operator did not choose.
 */
export function proxyOverrides(
  settings: AdvancedSettings,
  recorded: RecordedPlacement | undefined,
): { proxyMode?: ProxyMode; proxyContainer?: string } {
  const mode = settings.proxyMode;
  const container = settings.proxyContainer;
  return {
    ...(mode === 'auto' || mode === recorded?.proxyMode ? {} : { proxyMode: mode }),
    ...(container === (recorded?.proxyContainer ?? DEFAULT_PROXY_CONTAINER)
      ? {}
      : { proxyContainer: container }),
  };
}

/**
 * The settings as screen-field values: the confirmation rows, and the input to
 * `rerunCommand`. Only the keys this action takes.
 *
 * ⚠ Proxy container and mode appear only when they OVERRIDE something (see
 * `proxyOverrides`); root, proxy root and port always appear, because the
 * review must show where the run acts even when nothing was changed.
 */
export function advancedValues(
  action: RunnableAction,
  settings: AdvancedSettings,
  recorded: RecordedPlacement | undefined,
): Map<string, string> {
  const overrides = proxyOverrides(settings, recorded);
  const values = new Map<string, string>();
  for (const key of ADVANCED_KEYS[action]) {
    if (key === 'deployRoot') values.set(ADVANCED_FIELD.deployRoot, settings.deployRoot);
    if (key === 'proxyRoot') values.set(ADVANCED_FIELD.proxyRoot, settings.proxyRoot);
    if (key === 'bindPort') values.set(ADVANCED_FIELD.bindPort, String(settings.bindPort));
    if (key === 'proxyContainer' && overrides.proxyContainer !== undefined) {
      values.set(ADVANCED_FIELD.proxyContainer, overrides.proxyContainer);
    }
    if (key === 'proxyMode' && overrides.proxyMode !== undefined) {
      values.set(ADVANCED_FIELD.proxyMode, overrides.proxyMode);
    }
  }
  return values;
}

/** The summary the step opens on: label and value, one row per setting asked. */
export function advancedSummary(
  action: RunnableAction,
  settings: AdvancedSettings,
): Array<{ label: string; value: string }> {
  const describe: Record<AdvancedKey, { label: string; value: string }> = {
    deployRoot: { label: 'root', value: settings.deployRoot },
    proxyRoot: { label: 'proxy', value: settings.proxyRoot },
    bindPort: { label: 'port', value: String(settings.bindPort) },
    proxyContainer: { label: 'container', value: settings.proxyContainer },
    proxyMode: {
      label: 'mode',
      value: settings.proxyMode === 'auto' ? 'auto (detected)' : settings.proxyMode,
    },
  };
  return ADVANCED_KEYS[action].map((key) => describe[key]);
}
