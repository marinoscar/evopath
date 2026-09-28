/**
 * The flags the deploy screens expose, as DATA.
 *
 * =============================================================================
 * ⚠ WHY THIS IS A LIST AND NOT A FORM
 * =============================================================================
 *
 * The rule from the specification is blunt: THE TUI MUST PASS THE SAME FLAGS
 * THE CLI DOES. The screen this replaces passed none of them -- no `--resume`,
 * `--ref`, `--group`, `--all`, `--staging` or any `--skip-*` -- while hardcoding
 * the root, the proxy root and the port. The worst consequence was not the
 * missing options: it was that the screen TOLD the operator, three times, that
 * re-running install would resume, then passed no resume flag, so every retry
 * re-ran the whole pipeline including a four-minute build and re-asked every
 * question blank.
 *
 * Declaring them as data is what makes the parity CHECKABLE. `flags-model.test`
 * builds the real Commander command and asserts that every `--flag` it declares
 * appears here, so adding an option to the subcommand and forgetting the screen
 * turns a test red instead of quietly re-creating the gap.
 *
 * Flags deliberately NOT offered, each for a stated reason, are listed in
 * `NOT_IN_TUI` below -- an explicit exclusion the parity test reads, rather
 * than a silent omission it would have to tolerate.
 * =============================================================================
 */

export type DeployAction = 'doctor' | 'install' | 'update' | 'status';

export interface ToggleFlag {
  /** Exactly as the subcommand declares it, so the parity test can match. */
  flag: string;
  /** The `InstallOptions`/`UpdateOptions` key this sets. */
  option: string;
  label: string;
  help: string;
}

// ⚠ THERE IS DELIBERATELY NO `negated` MEMBER. Commander's `--no-cache` sets
// `cache: false`, but the OPTION the pipelines take is the positively named
// `noCache`, and the subcommand's own handler already does that translation.
// A `negated` flag here would be a second, quieter copy of that mapping --
// enforced nowhere, and free to disagree with the one that runs.

export const INSTALL_TOGGLES: readonly ToggleFlag[] = [
  {
    flag: '--all',
    option: 'all',
    label: 'Review every variable',
    help: 'Ask about every environment variable, not only the essential ones.',
  },
  {
    flag: '--reinstall',
    option: 'reinstall',
    label: 'Reinstall over what is here',
    help: 'Install on top of an existing deployment instead of refusing.',
  },
  {
    flag: '--skip-doctor',
    option: 'skipDoctor',
    label: 'Skip the prerequisite checks',
    help: 'Go straight to the work. The checks exist to fail before anything is written.',
  },
  {
    flag: '--skip-proxy',
    option: 'skipProxy',
    label: 'Do not touch the proxy',
    help: 'No vhost, no certificate. The stack answers on the loopback port only.',
  },
  {
    flag: '--skip-seed',
    option: 'skipSeed',
    label: 'Do not run the seed',
    help: 'The seed is how new permissions reach a deployment; skipping it surfaces as a 403.',
  },
  {
    flag: '--create-database',
    option: 'createDatabase',
    label: 'Create the database if it is missing',
    help: 'Consent in advance: the screen cannot stop mid-run to ask, so without this a missing database stops the install.',
  },
  {
    flag: '--bootstrap-proxy',
    option: 'bootstrapProxy',
    label: 'Create the shared proxy if there is none',
    help: 'Consent in advance to set up the reverse proxy on a server that has never had one.',
  },
  {
    flag: '--skip-renewal',
    option: 'skipRenewal',
    label: 'Do not schedule certificate renewal',
    help: 'Renewal is scheduled only when nothing else owns it, so leaving this off is safe.',
  },
  {
    flag: '--skip-oauth-check',
    option: 'skipOAuthCheck',
    label: 'Do not verify the OAuth credentials',
    help: 'For placeholder credentials or no outbound HTTPS. A real deployment wants the check.',
  },
  {
    flag: '--no-cache',
    option: 'noCache',
    label: 'Rebuild without the layer cache',
    help: 'Slower, and the answer when a build is reusing something stale.',
  },
  {
    flag: '--force',
    option: 'force',
    label: 'Discard local changes in the checkout',
    help: 'Throws away anything uncommitted under the deploy root.',
  },
  {
    flag: '--staging',
    option: 'staging',
    label: "Use Let's Encrypt staging",
    help: 'Certificates browsers do not trust, and rate limits that forgive a mistake.',
  },
  {
    flag: '--no-version-bump',
    option: 'noVersionBump',
    label: 'Do not bump the version',
    help: 'Deploy the current version: no manifest write, no commit, no push.',
  },
];

export const UPDATE_TOGGLES: readonly ToggleFlag[] = [
  {
    flag: '--force',
    option: 'force',
    label: 'Rebuild even when nothing moved',
    help: 'Update normally exits without doing anything when the revision is unchanged.',
  },
  {
    flag: '--no-cache',
    option: 'noCache',
    label: 'Rebuild without the layer cache',
    help: 'Slower, and the answer when a build is reusing something stale.',
  },
  {
    flag: '--skip-seed',
    option: 'skipSeed',
    label: 'Do not re-run the seed',
    help: 'The seed is how new permissions reach an existing deployment.',
  },
  {
    flag: '--skip-proxy',
    option: 'skipProxy',
    label: 'Do not touch the proxy',
    help: 'Leaves the vhost and the certificate exactly as they are.',
  },
  {
    flag: '--create-database',
    option: 'createDatabase',
    label: 'Create the database if it is missing',
    help: 'Consent in advance: the screen cannot stop mid-run to ask.',
  },
  {
    flag: '--skip-renewal',
    option: 'skipRenewal',
    label: 'Do not schedule certificate renewal',
    help: 'Renewal is scheduled only when nothing else owns it, so leaving this off is safe.',
  },
  {
    flag: '--skip-oauth-check',
    option: 'skipOAuthCheck',
    label: 'Do not run the OAuth sign-in smoke',
    help: 'For placeholder credentials or no outbound HTTPS.',
  },
  {
    flag: '--no-version-bump',
    option: 'noVersionBump',
    label: 'Do not bump the version',
    help: 'Deploy the current version: no manifest write, no commit, no push.',
  },
];

/**
 * Flags the screens deliberately do not offer, each with the reason.
 *
 * ⚠ AN EXPLICIT EXCLUSION, NOT A SILENT ONE. The parity test reads this list,
 * so dropping a flag costs a sentence here rather than nothing at all -- and a
 * flag that stops being justifiable becomes visible as a stale sentence.
 */
export const NOT_IN_TUI: Readonly<Record<string, string>> = Object.freeze({
  '--json':
    'A machine-readable report on stdout is meaningless while ink owns the terminal.',
  '--no-color':
    'Colour here is ink’s, not the renderer’s; the screen has no monochrome mode to switch to.',
  '--non-interactive':
    'The screen IS the interaction. It always passes this to the wizard underneath, because readline cannot ask a question while ink holds stdin in raw mode.',
  '--resume':
    'Decided, not offered: see decideResume. Resume is passed only when the collected answers still match the file, which is a fact the screen knows and the operator should not have to assert.',
  '--answer':
    'Every answer is collected by the screen itself; a second channel for them would be two sources of truth for one value.',
  '--answers-file':
    'Same as --answer: the screen collects them.',
});

/** The options object a set of chosen toggles produces. */
export function optionsFromToggles(
  toggles: readonly ToggleFlag[],
  chosen: ReadonlySet<string>,
): Record<string, true> {
  const options: Record<string, true> = {};
  for (const toggle of toggles) {
    if (chosen.has(toggle.flag)) options[toggle.option] = true;
  }
  return options;
}

/**
 * A flag that takes a VALUE, and the screen field that carries it.
 *
 * Declared as data for the same reason the toggles are: the parity test reads
 * it against the real Commander definitions, and `rerunCommand` reads it to
 * print the command that repeats a failed run. One list, so the flag a screen
 * says it passes and the flag the re-run command prints cannot disagree.
 */
export interface ValueFlag {
  /** Exactly as the subcommand declares it. */
  flag: string;
  /** The screen field (`__`-prefixed) whose answer is the value. */
  field: string;
}

/** The screens that run a pipeline, and so can be re-run from a shell. */
export type RunnableAction = Exclude<DeployAction, 'status'>;

const ROOT: ValueFlag = { flag: '--root', field: '__root' };
const PROXY_ROOT: ValueFlag = { flag: '--proxy-root', field: '__proxyRoot' };
const PORT: ValueFlag = { flag: '--port', field: '__port' };
const PROXY_CONTAINER: ValueFlag = { flag: '--proxy-container', field: '__proxyContainer' };
const PROXY_MODE: ValueFlag = { flag: '--proxy-mode', field: '__proxyMode' };
const DOMAIN: ValueFlag = { flag: '--domain', field: '__domain' };
const REF: ValueFlag = { flag: '--ref', field: '__ref' };

export const VALUE_FLAGS: Readonly<Record<RunnableAction, readonly ValueFlag[]>> = Object.freeze({
  doctor: [ROOT, PROXY_ROOT, PORT, DOMAIN, PROXY_CONTAINER, PROXY_MODE],
  install: [
    ROOT,
    DOMAIN,
    PROXY_ROOT,
    PORT,
    PROXY_CONTAINER,
    PROXY_MODE,
    { flag: '--repo', field: '__repo' },
    REF,
    { flag: '--email', field: '__email' },
    { flag: '--group', field: '__group' },
  ],
  update: [ROOT, REF, PROXY_CONTAINER, PROXY_MODE],
});

/** The toggles each runnable screen offers. `doctor` takes none. */
export const TOGGLES_FOR: Readonly<Record<RunnableAction, readonly ToggleFlag[]>> = Object.freeze({
  doctor: [],
  install: INSTALL_TOGGLES,
  update: UPDATE_TOGGLES,
});
