/**
 * The install screen's model: what to ask, what to prefill, what to pass.
 *
 * Pure. No ink, no React, no process. That is deliberate and it is where the
 * tests live -- the screen's predecessor was 509 lines with exactly one
 * testable function in it, because everything that mattered was tangled into a
 * component.
 *
 * =============================================================================
 * ⚠ THE FOUR THINGS THIS FILE EXISTS TO GET RIGHT
 * =============================================================================
 *
 * 1. PREFILL FROM THE DEPLOYMENT'S OWN `.env`. A blank re-run is not a blank
 *    slate: the wizard's generate-mode secrets fire on an empty answer, so
 *    re-running install over a live deployment minted a fresh `JWT_SECRET` and
 *    `COOKIE_SECRET`. Prefilling fixes that BY CONSTRUCTION rather than by a
 *    guard: there is no empty answer left to trigger the generator.
 *
 *    ⚠ IT DOES NOT COVER `SECRETS_ENCRYPTION_KEY`, AND SAYING SO MATTERS --
 *    that is the one whose loss makes every stored credential permanently
 *    undecryptable. It carries no `essential: true`, so `installFields`' own
 *    filter never turns it into a question at all: there is no placeholder to
 *    seed. What protects it is a SECOND, independent mechanism in
 *    `install.ts`'s environment step -- it re-reads the `.env` off disk and
 *    drops blank answers before merging, so an untouched field cannot
 *    overwrite a live secret. Two mechanisms, and only one of them is here.
 *    An earlier version of this comment claimed all three; a ⚠ comment that
 *    overstates its own coverage is worse than no comment, because the next
 *    reader stops looking.
 *
 * 2. RETRACT THE SEED WHEN THE NAME CHANGES. The app name is a field on the
 *    first screen, so an operator typing a neighbour's name reads that
 *    neighbour's `.env` on the way past -- and whatever they type after that is
 *    prefilled from a deployment they are not installing. `seedFor` is keyed on
 *    the resolved name, and a changed name throws the seed away rather than
 *    keeping the stale one "just in case".
 *
 * 3. TWO VARIABLES FOR THE NAME, NOT ONE. `resolved` is `string | undefined`
 *    and `display` is always a string. A placeholder may reach a LABEL; it must
 *    never reach a path, a check or a port probe. Upstream gated an install on
 *    a port conflict with an app literally called `app`, because a fallback
 *    display name reached a real decision.
 *
 * 4. RESUME ONLY WHEN THE ANSWERS STILL MATCH THE FILE. See `decideResume`.
 * =============================================================================
 */
import { UsageError } from '../../../errors.js';
import { resolveEnvPath } from '../../../deploy/deployment-evidence.js';
import { readEnvFile } from '../../../deploy/env-file.js';
import { metadataFor } from '../../../deploy/env-metadata.js';
import type { EnvVarSpec } from '../../../deploy/env-spec.js';
import { deployRootFor } from '../../../deploy/layout.js';
import type { DeployState } from '../../../deploy/state.js';
import { isScreenField, type FieldSpec } from './model.js';

/** The app name, as two variables. See rule 3 in the header. */
export interface AppName {
  /** Undefined until the operator has actually named one. Never a fallback. */
  resolved: string | undefined;
  /** Always a string, for labels and prompts ONLY. */
  display: string;
}

export function appName(typed: string, fallback: string): AppName {
  const trimmed = typed.trim();
  return {
    ...(trimmed === '' ? { resolved: undefined } : { resolved: trimmed }),
    display: trimmed === '' ? fallback : trimmed,
  };
}

/**
 * The values already on disk for a named deployment, or an empty map.
 *
 * ⚠ Keyed on the RESOLVED name, so it cannot be called with a placeholder. An
 * unresolved name reads nothing, which is the honest answer: there is no
 * deployment to read from yet.
 *
 * ⚠ Reads that deployment's OWN `.env` through `resolveEnvPath`, which knows
 * both the current location (`<root>/.env`) and the legacy one
 * (`<root>/repo/infra/compose/.env`). Guessing one of the two would prefill
 * blank on exactly the older deployments that most need prefilling.
 */
export interface Seed {
  /** Which deployment these values came from. Undefined means "none". */
  name: string | undefined;
  values: ReadonlyMap<string, string>;
}

export const EMPTY_SEED: Seed = { name: undefined, values: new Map() };

export function seedFor(appsRoot: string, name: string | undefined): Seed {
  if (name === undefined) return EMPTY_SEED;
  return seedAt(deployRootFor(appsRoot, name), name);
}

/**
 * The same, for a deploy root given outright (the Advanced step's `root`).
 *
 * ⚠ Still keyed on the NAME for `reconcileSeed`'s sake: the root is chosen
 * after the name, and a changed name must still retract whatever was read.
 */
export function seedAt(deployRoot: string, name: string): Seed {
  const envPath = resolveEnvPath(deployRoot);
  if (envPath === undefined) return { name, values: new Map() };

  try {
    return { name, values: readEnvFile(envPath) };
  } catch {
    // An unreadable `.env` is not an absent one, but for prefilling the two
    // are the same: there is nothing to seed with. The install's own
    // preflight reports the permission problem properly.
    return { name, values: new Map() };
  }
}

/**
 * Throws the seed away when it no longer belongs to the named deployment.
 *
 * ⚠ THE WHOLE POINT IS THAT STALE IS WORSE THAN ABSENT. A seed kept from a
 * neighbour prefills this install with THEIR database password and THEIR
 * secrets, and the operator's Enter-through-the-defaults confirms it.
 */
export function reconcileSeed(seed: Seed, name: string | undefined): Seed {
  if (name === undefined) return EMPTY_SEED;
  return seed.name === name ? seed : EMPTY_SEED;
}

/**
 * The questions install asks, in order, prefilled from `seed`.
 *
 * The screen keeps a cursor into this array. A hand-rolled union of thirty
 * step variants does not scale, so the wizard is DATA.
 */
export function installFields(
  specs: readonly EnvVarSpec[],
  seed: Seed = EMPTY_SEED,
): FieldSpec[] {
  const fields: FieldSpec[] = [
    {
      key: '__domain',
      label: 'Domain',
      help: 'The public hostname this will be served on. APP_URL and the OAuth callback are derived from it.',
      placeholder: seed.values.get('APP_URL') === undefined
        ? 'app.example.com'
        : hostOf(seed.values.get('APP_URL') as string),
      secret: false,
      prefilled: seed.values.has('APP_URL'),
      validate: (value) => (/^[a-z0-9.-]+$/i.test(value) ? undefined : 'must be a hostname'),
    },
  ];

  for (const spec of specs) {
    const metadata = metadataFor(spec.key);
    if (metadata.never === true || metadata.fixed !== undefined) continue;
    if (metadata.derive !== undefined) continue;
    if (metadata.group !== undefined) continue;
    if (metadata.essential !== true) continue;

    const seeded = seed.values.get(spec.key);

    fields.push({
      key: spec.key,
      label: spec.key,
      help: spec.help,
      // ⚠ The seeded value REPLACES the template default as the placeholder.
      // A "keep current value" branch that writes the TEMPLATE's default is
      // correct for a key nobody answered and catastrophic for one seeded from
      // disk -- it would reset a live deployment's database password to
      // `postgres` on an operator pressing Enter.
      placeholder: seeded ?? spec.defaultValue,
      secret: metadata.secret === true,
      prefilled: seeded !== undefined,
      ...(metadata.validate === undefined ? {} : { validate: metadata.validate }),
    });
  }

  return fields;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * The environment answers alone, with the screen's own fields stripped.
 *
 * `runInstall` takes `answers` as template keys; a `__domain` reaching it would
 * be written into the `.env` as a variable of that name.
 */
export function envAnswers(
  answers: ReadonlyMap<string, string>,
): Map<string, string> {
  return new Map([...answers].filter(([key]) => !isScreenField(key)));
}

export interface ResumeDecision {
  resume: boolean;
  /** Shown to the operator. Every branch names WHY, including the yeses. */
  reason: string;
}

/**
 * Whether this run may resume, given what the operator just answered.
 *
 * =============================================================================
 * ⚠ THE FOURTH RESUME CONDITION
 * =============================================================================
 *
 * The environment step is EARLY in the pipeline, so any run that got as far as
 * `build` has it in `completedSteps` -- and a resumed run skips it, `.env` and
 * all. That is correct for a shell `--resume`, where nobody was asked anything
 * and nothing can have changed.
 *
 * It is WRONG for a screen that asks every question first. An operator whose
 * install failed at `migrate`, who re-runs and CORRECTS THE DATABASE PASSWORD,
 * would have the correction silently dropped -- the environment step is
 * already "done" -- and would watch the identical failure, forever, with no
 * way to tell that their fix never reached disk.
 *
 * So resume is offered only when the collected answers STILL MATCH THE FILE.
 * Prefilling is what makes "unchanged" the ordinary case rather than a lucky
 * one: an operator pressing Enter through the questions produces exactly the
 * values already on disk, so the common path resumes and the corrected path
 * does not.
 *
 * ⚠ And resume over a COMPLETED deployment is strictly worse than the refusal
 * it waives: the flag exempts the "already exists" guard, so it would skip
 * every recorded step and report an install that did nothing at all.
 * =============================================================================
 */
export function decideResume(input: {
  state: DeployState | undefined;
  /** The environment answers, screen fields already stripped. */
  answers: ReadonlyMap<string, string>;
  /** What the deployment's `.env` holds right now. */
  onDisk: ReadonlyMap<string, string>;
}): ResumeDecision {
  const { state, answers, onDisk } = input;

  if (state === undefined) {
    return { resume: false, reason: 'no previous attempt is recorded here' };
  }

  // ⚠ `=== 'failure'`, NEVER `!== 'success'`. Every state file written before
  // the field existed has it ABSENT, and those runs all succeeded -- that is
  // how they came to be written. A negated test would treat every deployment
  // in the field as a failed attempt and resume over a serving one.
  if (state.lastOutcome !== 'failure') {
    return {
      resume: false,
      reason: 'the last run completed; resuming would skip every step and change nothing',
    };
  }

  if ((state.completedSteps ?? []).length === 0) {
    return { resume: false, reason: 'the last attempt recorded no completed steps' };
  }

  const changed = [...answers.keys()]
    .filter((key) => answers.get(key) !== onDisk.get(key))
    .sort();

  if (changed.length > 0) {
    return {
      resume: false,
      reason:
        `these answers differ from the ones on disk, so the environment step must run again: ` +
        changed.join(', '),
    };
  }

  return {
    resume: true,
    reason: `continuing from ${state.lastFailedStep ?? 'the step that failed'}`,
  };
}

/** Validation for the loopback port field, kept here so the screen stays dumb. */
export function validatePort(value: string): string | undefined {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return 'must be a port between 1 and 65535';
  }
  return undefined;
}

/** Refuses a name that would escape the apps root. Paths are built from this. */
export function validateAppName(value: string): string | undefined {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) {
    return 'must be a directory name: letters, digits, dot, dash or underscore';
  }
  return undefined;
}

/** Turns a rejected name into the error the CLI would have raised. */
export function assertAppName(value: string): void {
  const message = validateAppName(value);
  if (message !== undefined) throw new UsageError(`App name ${message}.`);
}
