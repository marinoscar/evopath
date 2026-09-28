import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseEnvExample, type EnvVarSpec } from '../../../deploy/env-spec.js';
import { deployRootFor } from '../../../deploy/layout.js';
import { DEPLOY_STATE_VERSION, type DeployState } from '../../../deploy/state.js';
import {
  appName,
  decideResume,
  EMPTY_SEED,
  envAnswers,
  installFields,
  reconcileSeed,
  seedFor,
  validateAppName,
  validatePort,
  type Seed,
} from './install-model.js';

function makeAppsRoot(): string {
  return mkdtempSync(join(tmpdir(), 'appctl-install-model-'));
}

function writeDeploymentEnv(appsRoot: string, name: string, contents: string): void {
  const deployRoot = deployRootFor(appsRoot, name);
  mkdirSync(deployRoot, { recursive: true });
  writeFileSync(join(deployRoot, '.env'), contents.endsWith('\n') ? contents : `${contents}\n`);
}

/**
 * A template exercising exactly the keys these tests care about. Real
 * `EnvVarSpec`s, parsed the same way `loadSpecs` in `install.tsx` parses a real
 * `.env.example` -- not hand-built objects that could drift from what the
 * parser actually produces.
 */
const TEMPLATE = [
  '# ------------------------------------------------------------',
  '# Application',
  '# ------------------------------------------------------------',
  'APP_URL=http://localhost:3535',
  '',
  '# ------------------------------------------------------------',
  '# Database',
  '# ------------------------------------------------------------',
  'POSTGRES_HOST=localhost',
  'POSTGRES_PASSWORD=postgres',
  '',
  '# ------------------------------------------------------------',
  '# JWT / session',
  '# ------------------------------------------------------------',
  'JWT_SECRET=changeme-changeme-changeme-changeme',
  'COOKIE_SECRET=changeme-changeme-changeme-changeme',
  '',
  '# ------------------------------------------------------------',
  '# Credential encryption',
  '# ------------------------------------------------------------',
  'SECRETS_ENCRYPTION_KEY=',
].join('\n');

function specs(): EnvVarSpec[] {
  return parseEnvExample(TEMPLATE);
}

// =============================================================================
// 1. THE ONE WORTH THE ISSUE ON ITS OWN: a re-run must not mint fresh secrets
// =============================================================================
//
// `env-wizard.ts`'s generate-mode branch only fires on a BLANK answer. So the
// entire re-install-safety property reduces to one fact: the placeholder an
// operator would see on a re-run must be byte-identical to what is already on
// disk, for every key the wizard would otherwise offer to regenerate. A
// placeholder that drifted even one byte from disk -- a trailing newline eaten,
// a re-encoding, a stale cache -- would be invisible in the UI and catastrophic
// for `SECRETS_ENCRYPTION_KEY`: every credential already encrypted under the
// old key becomes permanently undecryptable the moment a NEW key is written.
// =============================================================================

describe('the byte-identical prefill that stops a re-install regenerating secrets', () => {
  const JWT_SECRET_ON_DISK = 'disk-jwt-Rz3!p_Qo8x==secret-value-do-not-touch';
  const COOKIE_SECRET_ON_DISK = 'disk-cookie-9wA#secret==value-do-not-touch';
  const SECRETS_ENCRYPTION_KEY_ON_DISK = 'disk-encryption-KEYVALUE+/==base64ish';

  function seedForFixture(): { appsRoot: string; seed: Seed } {
    const appsRoot = makeAppsRoot();
    writeDeploymentEnv(
      appsRoot,
      'prod',
      [
        'APP_URL=https://prod.example.com',
        `JWT_SECRET=${JWT_SECRET_ON_DISK}`,
        `COOKIE_SECRET=${COOKIE_SECRET_ON_DISK}`,
        `SECRETS_ENCRYPTION_KEY=${SECRETS_ENCRYPTION_KEY_ON_DISK}`,
        'POSTGRES_PASSWORD=real-prod-password',
      ].join('\n'),
    );
    return { appsRoot, seed: seedFor(appsRoot, 'prod') };
  }

  it('installFields placeholders for JWT_SECRET and COOKIE_SECRET are byte-identical to disk, and prefilled is true', () => {
    // These two are `essential: true` in env-metadata.ts, so `installFields`
    // asks about them directly -- this is the field-level half of the
    // mechanism the header comment describes.
    const { seed } = seedForFixture();
    const fields = installFields(specs(), seed);

    const jwt = fields.find((field) => field.key === 'JWT_SECRET');
    const cookie = fields.find((field) => field.key === 'COOKIE_SECRET');

    expect(jwt?.placeholder).toBe(JWT_SECRET_ON_DISK);
    expect(jwt?.prefilled).toBe(true);
    expect(cookie?.placeholder).toBe(COOKIE_SECRET_ON_DISK);
    expect(cookie?.prefilled).toBe(true);

    // Not merely equal-looking: literally the same bytes as what `readFileSync`
    // would hand back, with no re-encoding in between.
    expect(Buffer.from(jwt?.placeholder ?? '', 'utf8').equals(Buffer.from(JWT_SECRET_ON_DISK, 'utf8'))).toBe(true);
    expect(Buffer.from(cookie?.placeholder ?? '', 'utf8').equals(Buffer.from(COOKIE_SECRET_ON_DISK, 'utf8'))).toBe(true);
  });

  // ⚠ IMPLEMENTATION NOTE, NOT A BUG WORKED AROUND -- see the final report.
  // `SECRETS_ENCRYPTION_KEY` has no `essential: true` in env-metadata.ts, so
  // `installFields`'s own loop (`if (metadata.essential !== true) continue;`)
  // never turns it into a question at all: it is genuinely ABSENT from
  // `installFields`'s return value, seeded or not. The install-model.ts header
  // comment describes the seed/installFields prefill as what stops a re-run
  // from regenerating "JWT_SECRET, COOKIE_SECRET and SECRETS_ENCRYPTION_KEY";
  // for the third key that particular mechanism does not apply, because there
  // is no field and no placeholder to inspect.
  //
  // What DOES protect it, verified against the real code in install.ts, is a
  // second, independent mechanism that this file does not own: `runInstall`
  // reads the deployment's `.env` off disk itself and merges it under whatever
  // the TUI submitted, so an unasked key simply survives untouched. `seedFor`
  // is still the correct, byte-identical read of that same file -- it is the
  // value `runInstall`'s own onDisk merge depends on being right -- so that is
  // what this test pins.
  it('seedFor reads SECRETS_ENCRYPTION_KEY byte-identical from disk, even though installFields never turns it into a question', () => {
    const { seed } = seedForFixture();

    expect(seed.values.get('SECRETS_ENCRYPTION_KEY')).toBe(SECRETS_ENCRYPTION_KEY_ON_DISK);

    const fields = installFields(specs(), seed);
    expect(fields.some((field) => field.key === 'SECRETS_ENCRYPTION_KEY')).toBe(false);
  });

  it('ADVERSARIAL: if installFields stopped using the seed at all, this test goes red', () => {
    // This is the assertion the task calls out for deliberate breakage. Recorded
    // here so the adversarial run is reproducible: comment out the `seeded`
    // lookup in `installFields` (`placeholder: seeded ?? spec.defaultValue` ->
    // `placeholder: spec.defaultValue`) and this fails because the placeholder
    // becomes the template default instead of the disk value. See the final
    // report for the actual red/green run.
    const { seed } = seedForFixture();
    const fields = installFields(specs(), seed);
    const jwt = fields.find((field) => field.key === 'JWT_SECRET');

    expect(jwt?.placeholder).not.toBe('changeme-changeme-changeme-changeme');
    expect(jwt?.placeholder).toBe(JWT_SECRET_ON_DISK);
  });
});

// =============================================================================
// 2. Seed retraction: a changed name must never carry a neighbour's values
// =============================================================================

describe('reconcileSeed: retracts the seed the moment the name stops matching', () => {
  const seed: Seed = { name: 'alpha', values: new Map([['POSTGRES_PASSWORD', 'alpha-secret']]) };

  it('keeps the seed when the name still matches', () => {
    expect(reconcileSeed(seed, 'alpha')).toBe(seed);
  });

  it('retracts to the empty seed when the name differs', () => {
    expect(reconcileSeed(seed, 'beta')).toEqual(EMPTY_SEED);
  });

  it('retracts to the empty seed when the name becomes undefined', () => {
    expect(reconcileSeed(seed, undefined)).toEqual(EMPTY_SEED);
  });

  // ===========================================================================
  // THE INTEGRATION POINT THAT MATTERS: two real deployments, two real
  // `.env` files, one apps root. Resolving deployment A must never surface
  // deployment B's password, whichever order they were seeded in.
  // ===========================================================================
  it('fields built from a retracted seed carry the TEMPLATE default, never a neighbouring deployment\'s value', () => {
    const appsRoot = makeAppsRoot();
    writeDeploymentEnv(appsRoot, 'alpha', 'POSTGRES_PASSWORD=alpha-only-password\n');
    writeDeploymentEnv(appsRoot, 'beta', 'POSTGRES_PASSWORD=beta-only-password\n');

    // The operator is midway through naming "alpha" and its seed has loaded...
    const alphaSeed = seedFor(appsRoot, 'alpha');
    expect(alphaSeed.values.get('POSTGRES_PASSWORD')).toBe('alpha-only-password');

    // ...then retypes the name field to "beta". `reconcileSeed` runs on every
    // keystroke, exactly as install.tsx's `onChange` does.
    const retracted = reconcileSeed(alphaSeed, 'beta');
    expect(retracted).toEqual(EMPTY_SEED);

    // Only once the seed is retracted does the screen fetch the RIGHT one.
    const betaSeed = seedFor(appsRoot, 'beta');
    const betaFields = installFields(specs(), betaSeed);
    const betaPassword = betaFields.find((field) => field.key === 'POSTGRES_PASSWORD');

    expect(betaPassword?.placeholder).toBe('beta-only-password');
    expect(betaPassword?.placeholder).not.toBe('alpha-only-password');
    expect(betaPassword?.prefilled).toBe(true);

    // And the defect this test exists to catch: fields built straight from the
    // STALE alpha seed (the bug this screen used to have, if `reconcileSeed`
    // were skipped) would carry alpha's password into a beta install.
    const stillWrongFields = installFields(specs(), alphaSeed);
    const stillWrongPassword = stillWrongFields.find((field) => field.key === 'POSTGRES_PASSWORD');
    expect(stillWrongPassword?.placeholder).toBe('alpha-only-password');
    expect(stillWrongPassword?.placeholder).not.toBe(betaPassword?.placeholder);

    // A field built from the genuinely EMPTY seed (post-retraction, before a
    // fresh `seedFor` runs) falls back to the template's own default, never to
    // either neighbour's value.
    const emptyFields = installFields(specs(), EMPTY_SEED);
    const emptyPassword = emptyFields.find((field) => field.key === 'POSTGRES_PASSWORD');
    expect(emptyPassword?.placeholder).toBe('postgres'); // the template default
    expect(emptyPassword?.prefilled).toBe(false);
  });
});

// =============================================================================
// 4. decideResume: the fourth resume condition
// =============================================================================

function baseState(overrides: Partial<DeployState> = {}): DeployState {
  return {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.com/repo.git',
    ref: 'main',
    commitSha: 'abc123',
    bindPort: 3535,
    deployRoot: '/opt/infra/apps/demo',
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-01T00:00:00.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
    ...overrides,
  };
}

describe('decideResume: every branch, and every branch names why', () => {
  it('no state at all: never resume', () => {
    const decision = decideResume({
      state: undefined,
      answers: new Map(),
      onDisk: new Map(),
    });
    expect(decision.resume).toBe(false);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  // ⚠ THE REGRESSION THIS BRANCH ORDER EXISTS TO PREVENT. Every state file
  // written before `lastOutcome` was introduced has it ABSENT, and every one
  // of those runs succeeded -- that is the only way the file came to exist
  // without ever recording a failure. `state.lastOutcome !== 'failure'` is
  // true for `undefined`, so this correctly refuses to resume; the WRONG
  // implementation here would test `!== 'success'`, which is also true for
  // `undefined` but for the opposite, catastrophic reason: it would treat
  // every already-serving deployment in the field as a failed attempt and
  // offer to resume over it, skipping every real step.
  it('lastOutcome absent (a state file written before the field existed): never resume', () => {
    const state = baseState(); // lastOutcome intentionally not set
    expect(state.lastOutcome).toBeUndefined();

    const decision = decideResume({ state, answers: new Map(), onDisk: new Map() });
    expect(decision.resume).toBe(false);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it('lastOutcome success: never resume', () => {
    const state = baseState({ lastOutcome: 'success' });
    const decision = decideResume({ state, answers: new Map(), onDisk: new Map() });
    expect(decision.resume).toBe(false);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it('lastOutcome failure but no completed steps recorded (absent): never resume', () => {
    const state = baseState({ lastOutcome: 'failure' }); // completedSteps absent
    const decision = decideResume({ state, answers: new Map(), onDisk: new Map() });
    expect(decision.resume).toBe(false);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it('lastOutcome failure with an explicitly empty completedSteps array: never resume', () => {
    const state = baseState({ lastOutcome: 'failure', completedSteps: [] });
    const decision = decideResume({ state, answers: new Map(), onDisk: new Map() });
    expect(decision.resume).toBe(false);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it('lastOutcome failure, steps recorded, answers still match the file: resume', () => {
    const state = baseState({
      lastOutcome: 'failure',
      completedSteps: ['env', 'build'],
      lastFailedStep: 'migrate',
    });
    const onDisk = new Map([
      ['POSTGRES_PASSWORD', 'unchanged-password'],
      ['JWT_SECRET', 'unchanged-jwt'],
    ]);
    // The common, Enter-through-the-defaults path: the collected answers are
    // exactly what prefilling handed back.
    const answers = new Map(onDisk);

    const decision = decideResume({ state, answers, onDisk });
    expect(decision.resume).toBe(true);
    expect(decision.reason.length).toBeGreaterThan(0);
    expect(decision.reason).toContain('migrate');
  });

  // ===========================================================================
  // THE CASE THE CONDITION EXISTS FOR. An operator who fixed the thing that
  // actually failed must have that correction reach the run, not be silently
  // dropped because the environment step was already marked done.
  // ===========================================================================
  it('lastOutcome failure, steps recorded, ONE answer differs: refuse, and NAME the differing key', () => {
    const state = baseState({
      lastOutcome: 'failure',
      completedSteps: ['env', 'build'],
      lastFailedStep: 'migrate',
    });
    const onDisk = new Map([
      ['POSTGRES_PASSWORD', 'old-wrong-password'],
      ['JWT_SECRET', 'unchanged-jwt'],
    ]);
    const answers = new Map([
      ['POSTGRES_PASSWORD', 'corrected-password'], // the operator's fix
      ['JWT_SECRET', 'unchanged-jwt'],
    ]);

    const decision = decideResume({ state, answers, onDisk });

    expect(decision.resume).toBe(false);
    expect(decision.reason.length).toBeGreaterThan(0);
    expect(decision.reason).toContain('POSTGRES_PASSWORD');
    // The key that did NOT change must not be blamed.
    expect(decision.reason).not.toContain('JWT_SECRET');
  });

  it('lastOutcome failure, steps recorded, ALL answers differ: names every differing key', () => {
    const state = baseState({
      lastOutcome: 'failure',
      completedSteps: ['env'],
    });
    const onDisk = new Map([
      ['A_KEY', 'old-a'],
      ['B_KEY', 'old-b'],
    ]);
    const answers = new Map([
      ['A_KEY', 'new-a'],
      ['B_KEY', 'new-b'],
    ]);

    const decision = decideResume({ state, answers, onDisk });
    expect(decision.resume).toBe(false);
    expect(decision.reason).toContain('A_KEY');
    expect(decision.reason).toContain('B_KEY');
  });

  it('ADVERSARIAL: if decideResume stopped comparing answers to disk, this test goes red', () => {
    // The deliberate breakage for this test: replace the `changed` computation
    // with an empty array (as if the comparison were skipped entirely) and the
    // corrected-password case above would wrongly resume, silently discarding
    // the operator's fix. See the final report for the actual red/green run.
    const state = baseState({
      lastOutcome: 'failure',
      completedSteps: ['env', 'build'],
      lastFailedStep: 'migrate',
    });
    const onDisk = new Map([['POSTGRES_PASSWORD', 'old-wrong-password']]);
    const answers = new Map([['POSTGRES_PASSWORD', 'corrected-password']]);

    const decision = decideResume({ state, answers, onDisk });
    expect(decision.resume).toBe(false);
  });
});

// =============================================================================
// 5. The name as two variables
// =============================================================================

describe('appName: resolved is undefined until an operator actually names one', () => {
  it('empty input: resolved is undefined, display is the fallback', () => {
    const name = appName('', 'fallback-name');
    expect(name.resolved).toBeUndefined();
    expect(name.display).toBe('fallback-name');
  });

  it('whitespace-only input: resolved is still undefined', () => {
    // ⚠ A placeholder may reach a LABEL; it must never reach a path, an
    // existence check or a port probe. Treating "   " as a real name here
    // would let a stray space silently become a resolved deployment name and
    // survive as far as `seedFor` / `deployRootFor`, which is precisely the
    // upstream defect this file's header calls out (a port conflict gated on
    // an app literally named after a fallback display string).
    const name = appName('   ', 'fallback-name');
    expect(name.resolved).toBeUndefined();
    expect(name.display).toBe('fallback-name');
  });

  it('real input: resolved and display both carry it, trimmed', () => {
    const name = appName('  myapp  ', 'fallback-name');
    expect(name.resolved).toBe('myapp');
    expect(name.display).toBe('myapp');
  });
});

// =============================================================================
// 6. envAnswers, validatePort, validateAppName
// =============================================================================

describe('envAnswers: strips screen fields, keeps everything else', () => {
  it('drops every __-prefixed key and keeps the rest untouched', () => {
    const answers = new Map([
      ['__domain', 'app.example.com'],
      ['__port', '3535'],
      ['JWT_SECRET', 'a-secret'],
      ['POSTGRES_PASSWORD', 'a-password'],
    ]);

    const result = envAnswers(answers);

    expect(result).toEqual(
      new Map([
        ['JWT_SECRET', 'a-secret'],
        ['POSTGRES_PASSWORD', 'a-password'],
      ]),
    );
  });

  it('is empty when every answer is a screen field', () => {
    expect(envAnswers(new Map([['__name', 'x']]))).toEqual(new Map());
  });

  it('is unchanged when nothing is a screen field', () => {
    const answers = new Map([['A', '1'], ['B', '2']]);
    expect(envAnswers(answers)).toEqual(answers);
  });
});

describe('validatePort', () => {
  it('accepts ports in range', () => {
    expect(validatePort('1')).toBeUndefined();
    expect(validatePort('3535')).toBeUndefined();
    expect(validatePort('65535')).toBeUndefined();
  });

  it('rejects out-of-range and non-integer values', () => {
    expect(validatePort('0')).toBeDefined();
    expect(validatePort('65536')).toBeDefined();
    expect(validatePort('-1')).toBeDefined();
    expect(validatePort('3535.5')).toBeDefined();
    expect(validatePort('not-a-port')).toBeDefined();
    expect(validatePort('')).toBeDefined();
  });
});

describe('validateAppName: refuses anything that would escape the apps root', () => {
  it('accepts an ordinary directory-safe name', () => {
    expect(validateAppName('my-app_1.2')).toBeUndefined();
    expect(validateAppName('demo')).toBeUndefined();
  });

  it('rejects a name of just ".." (the classic path-traversal segment)', () => {
    // Paths are built from this value with a plain `join`, so a name that
    // resolves to a traversal segment must never reach it.
    expect(validateAppName('..')).toBeDefined();
  });

  it('rejects a name containing a "/" (would escape the apps root outright)', () => {
    expect(validateAppName('../etc')).toBeDefined();
    expect(validateAppName('a/b')).toBeDefined();
    expect(validateAppName('/etc/passwd')).toBeDefined();
  });

  it('rejects an empty name', () => {
    expect(validateAppName('')).toBeDefined();
  });
});
