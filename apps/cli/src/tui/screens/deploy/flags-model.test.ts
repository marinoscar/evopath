import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { registerDeployCommand } from '../../../commands/deploy.js';
import {
  INSTALL_TOGGLES,
  NOT_IN_TUI,
  TOGGLES_FOR,
  UPDATE_TOGGLES,
  VALUE_FLAGS,
  optionsFromToggles,
  type RunnableAction,
  type ToggleFlag,
} from './flags-model.js';

// =============================================================================
// The TUI passes the same flags the CLI does  (issue #406, epic #397)
// =============================================================================
//
// ⚠ THIS TEST IS THE WHOLE REASON THE TOGGLES ARE DATA. The rule -- the screen
// must reach every flag the subcommand accepts -- is unenforceable as prose:
// the screen this replaced offered NONE of them and nothing said so. Reading
// the real Commander definitions turns "someone added an option and forgot the
// screen" into a red test.
//
// ⚠ AND IT READS THE REAL COMMAND, not a transcribed list. A fixture copy of
// the option names would have to be updated by the same person who forgot the
// screen, which is no check at all.
// =============================================================================

/** Every `--flag` a subcommand declares, as Commander itself reports them. */
function declaredFlags(subcommand: string): string[] {
  const program = new Command();
  program.exitOverride();
  registerDeployCommand(program);

  const deploy = program.commands.find((command) => command.name() === 'deploy');
  const target = deploy?.commands.find((command) => command.name() === subcommand);
  expect(target, `\`deploy ${subcommand}\` is not registered`).toBeDefined();

  return (target?.options ?? []).map((option) => option.long ?? option.short ?? '');
}

/**
 * Commander reports a negated boolean by its positive name: `--no-cache` is
 * declared and reported as `--no-cache`, but `--no-color` style options can
 * appear either way depending on how they were declared. Both spellings are
 * accepted so this test is about COVERAGE, not about Commander's bookkeeping.
 */
function covers(declared: readonly string[], flag: string): boolean {
  const positive = flag.replace(/^--no-/, '--');
  return declared.includes(flag) || declared.includes(positive);
}

function checkParity(subcommand: RunnableAction, toggles: readonly ToggleFlag[]): void {
  const declared = declaredFlags(subcommand);
  const values = VALUE_FLAGS[subcommand].map((value) => value.flag);
  const known = new Set([
    ...toggles.map((toggle) => toggle.flag),
    ...values,
    ...Object.keys(NOT_IN_TUI),
  ]);

  // A flag the screen offers that the subcommand does not declare is a control
  // that does nothing -- the exact quiet lie these screens exist to avoid.
  const invented = [...toggles.map((toggle) => toggle.flag), ...values].filter(
    (flag) => !covers(declared, flag),
  );
  expect(invented, `\`deploy ${subcommand}\` does not declare these`).toEqual([]);

  // And a flag the subcommand declares that the screen neither offers nor
  // excludes on purpose is the original defect, reappearing.
  const missing = declared.filter(
    (flag) =>
      flag !== '' &&
      !known.has(flag) &&
      !known.has(`--no-${flag.slice(2)}`) &&
      // Value-carrying options are rendered as text fields by the screens
      // rather than as toggles, so they are not in these lists by design.
      !VALUE_OPTIONS.has(flag),
  );
  expect(missing, `the ${subcommand} screen reaches neither of these`).toEqual([]);
}

/**
 * Value options the screens reach some OTHER way than a `VALUE_FLAGS` field,
 * named here rather than filtered by a heuristic so adding one is deliberate.
 *
 * ⚠ Every value option a screen asks for as a field is in `VALUE_FLAGS`
 * (flags-model.ts), which the parity check reads above -- `--root`,
 * `--proxy-root`, `--port`, `--proxy-container` and `--proxy-mode` (the
 * Advanced step, #393) among them. Only these three stay here:
 * - `--name`: the name step, which every screen opens on;
 * - `--apps-root`: the screens use the default apps root, and `--root` on the
 *   Advanced step places a deployment anywhere else;
 * - `--app-version`: the version step suggests the bump itself.
 */
const VALUE_OPTIONS = new Set(['--apps-root', '--name', '--app-version']);

describe('the deploy screens reach every flag the subcommands accept', () => {
  it('covers `deploy install`', () => {
    checkParity('install', INSTALL_TOGGLES);
  });

  it('covers `deploy update`', () => {
    checkParity('update', UPDATE_TOGGLES);
  });

  it('covers `deploy doctor`: every value flag it offers is one doctor declares', () => {
    // Doctor has no toggles, and declares output flags (`--json`, `--repo`) the
    // screen deliberately leaves out; this asserts the half that would lie.
    const declared = declaredFlags('doctor');
    const invented = VALUE_FLAGS.doctor
      .map((value) => value.flag)
      .filter((flag) => !covers(declared, flag));
    expect(invented).toEqual([]);
  });

  it('the #393 flags are surfaced, not excluded', () => {
    // ⚠ These were in NOT_IN_TUI pointing at #393. A flag both offered and
    // excluded is two answers to one question.
    for (const flag of [
      '--proxy-container',
      '--proxy-mode',
      '--bootstrap-proxy',
      '--create-database',
      '--skip-renewal',
      '--skip-oauth-check',
    ]) {
      expect(NOT_IN_TUI[flag], flag).toBeUndefined();
    }
    const offered = (action: RunnableAction): string[] => [
      ...TOGGLES_FOR[action].map((toggle) => toggle.flag),
      ...VALUE_FLAGS[action].map((value) => value.flag),
    ];
    expect(offered('install')).toEqual(
      expect.arrayContaining([
        '--proxy-container',
        '--proxy-mode',
        '--bootstrap-proxy',
        '--create-database',
        '--skip-renewal',
        '--skip-oauth-check',
      ]),
    );
    expect(offered('update')).toEqual(
      expect.arrayContaining([
        '--proxy-container',
        '--proxy-mode',
        '--create-database',
        '--skip-renewal',
        '--skip-oauth-check',
      ]),
    );
    expect(offered('update')).not.toContain('--bootstrap-proxy');
  });

  it('every deliberate exclusion names a reason', () => {
    // ⚠ The exclusions are the part that rots. A flag dropped with a stated
    // reason is a decision; one dropped silently is the defect.
    for (const [flag, reason] of Object.entries(NOT_IN_TUI)) {
      expect(flag.startsWith('--'), `${flag} is not a flag`).toBe(true);
      expect(reason.length, `${flag} has no reason`).toBeGreaterThan(20);
    }
  });
});

describe('turning chosen toggles into options', () => {
  it('sets only what was chosen', () => {
    const options = optionsFromToggles(INSTALL_TOGGLES, new Set(['--skip-seed', '--staging']));

    expect(options).toEqual({ skipSeed: true, staging: true });
  });

  it('maps a negated flag to the positively named option the pipeline takes', () => {
    // ⚠ `--no-cache` becomes `noCache: true`, NOT `cache: false`. The option
    // the pipelines declare is the positive one; a `cache: false` here would
    // be silently ignored by both.
    expect(optionsFromToggles(INSTALL_TOGGLES, new Set(['--no-cache']))).toEqual({
      noCache: true,
    });
    expect(optionsFromToggles(INSTALL_TOGGLES, new Set(['--no-version-bump']))).toEqual({
      noVersionBump: true,
    });
  });

  it('maps the #391 consent toggles to the option keys the pipelines read', () => {
    // ⚠ `skipOAuthCheck`, capital A: the pipelines' spelling, not Commander's
    // `skipOauthCheck`. The wrong case is an option both pipelines ignore.
    expect(
      optionsFromToggles(
        INSTALL_TOGGLES,
        new Set(['--create-database', '--bootstrap-proxy', '--skip-renewal', '--skip-oauth-check']),
      ),
    ).toEqual({
      createDatabase: true,
      bootstrapProxy: true,
      skipRenewal: true,
      skipOAuthCheck: true,
    });
    expect(
      optionsFromToggles(
        UPDATE_TOGGLES,
        new Set(['--create-database', '--skip-renewal', '--skip-oauth-check', '--bootstrap-proxy']),
      ),
    ).toEqual({ createDatabase: true, skipRenewal: true, skipOAuthCheck: true });
  });

  it('is empty when nothing was chosen', () => {
    expect(optionsFromToggles(INSTALL_TOGGLES, new Set())).toEqual({});
  });
});
