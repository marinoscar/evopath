import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runStatusCommand } from '../../commands/deploy.js';
import { isDeployment, resolveEnvPath } from '../deployment-evidence.js';
import { parseEnvExample, parseEnvFile } from '../env-spec.js';
import { runInstall, type InstallOptions } from '../install.js';
import { deployStatePath, readState, writeState, type DeployState } from '../state.js';
import { runUpdate } from '../update.js';
import {
  FAKE_GOOGLE_CLIENT_ID,
  createFakeVps,
  fakeGoogleFetch,
  listenForProbe,
  serveHealth,
  unattendedAnswers,
} from './fake-vps.js';

// =============================================================================
// The harness drives the REAL pipeline  (issue #407, epic #397)
// =============================================================================
//
// Every deploy test before this one mocked at the edges, so the thing under
// test was never the pipeline. Here `runInstall` runs its real steps in their
// real order against a real temp directory; only the subprocesses are faked.
//
// ⚠ These tests can never catch a Docker-level break -- the argv is answered,
// not executed. That is what `.github/workflows/deploy-e2e.yml` is for, and
// the two are complements, not alternatives.
// =============================================================================

/**
 * ⚠ THE REAL `.env.example`, NOT A TOY ONE.
 *
 * A fixture template drifts from the real one silently, and the wizard's whole
 * job is to answer THAT file. Reading it here means a variable added to the
 * template with no metadata, or a validator nothing can satisfy, fails in this
 * one-second test rather than on a server.
 */
const TEMPLATE = readFileSync(
  resolve(__dirname, '..', '..', '..', '..', '..', 'infra', 'compose', '.env.example'),
  'utf8',
);

const SPECS = parseEnvExample(TEMPLATE);

/**
 * Every essential key answered, which is what an unattended run must supply.
 * See `unattendedAnswers`: the wizard deliberately will not take a template
 * default for an essential key, nor generate a secret without a terminal.
 */
/**
 * A real listening socket for `database-reachable`'s real TCP probe, and the
 * host/port the answers point at. See `listenForProbe`.
 */
let probe: Awaited<ReturnType<typeof listenForProbe>>;
let api: Awaited<ReturnType<typeof serveHealth>>;
let ANSWERS: Map<string, string>;

beforeAll(async () => {
  probe = await listenForProbe();
  api = await serveHealth();
  ANSWERS = unattendedAnswers(
    SPECS,
    new Map([
      ['POSTGRES_HOST', '127.0.0.1'],
      ['POSTGRES_PORT', String(probe.port)],
    ]),
  );
});

afterAll(async () => {
  await probe.close();
  await api.close();
});

function install(
  vps: ReturnType<typeof createFakeVps>,
  extra: Partial<InstallOptions> = {},
) {
  const { answers: extraAnswers, ...rest } = extra;
  return runInstall({
    deployRoot: vps.deployRoot,
    bindPort: api.port,
    proxyRoot: join(vps.appsRoot, 'proxy'),
    domain: 'app.example.test',
    repo: 'https://example.test/o/r',
    ref: 'main',
    runCommand: vps.runCommand,
    // #391: the OAuth credential probe answers `invalid_grant` (valid
    // credentials) without ever reaching Google; everything else is the real
    // fetch against `serveHealth`, which also serves the sign-in smoke.
    fetch: fakeGoogleFetch().fetch,
    // ⚠ POSTGRES_PORT carries a template default, so `unattendedAnswers` does
    // not answer it and the override above never reaches the file. Supplied
    // here instead, which is also what `--answer` does on a real run.
    answers: new Map([...ANSWERS, ['POSTGRES_PORT', String(probe.port)], ...(extraAnswers ?? [])]),
    nonInteractive: true,
    skipDoctor: true,
    skipProxy: true,
    skipSeed: true,
    // ⚠ OFF BY DEFAULT HERE. The version step COMMITS, and these temp deploy
    // roots have no git repository for it to commit into -- so leaving it on
    // would make every test in this file fail on a fact about the fixture
    // rather than about the pipeline. The one test that is about versioning
    // turns it on and builds a real repository for it.
    noVersionBump: true,
    ...rest,
  });
}

function vpsWithTemplate(): ReturnType<typeof createFakeVps> {
  return createFakeVps({
    envExample: TEMPLATE,
    routes: [
      // Health: the pipeline waits for these, and an unanswered probe would
      // hang the test rather than fail it.
      {
        match: (invocation) => invocation.argv.includes('curl'),
        answer: '200',
      },
    ],
  });
}

describe('the fake VPS harness', () => {
  it('drives the real install pipeline to completion', async () => {
    const vps = vpsWithTemplate();

    const result = await install(vps);

    expect(result.deployRoot).toBe(vps.deployRoot);

    // ⚠ FOUND THROUGH `resolveEnvPath`, NOT AT A HARDCODED PATH. That helper
    // knows both the current location and the legacy one, and asserting on a
    // literal path here would make this test a second, quieter opinion about
    // where the file lives -- the exact disagreement it exists to catch.
    const envPath = resolveEnvPath(vps.deployRoot);
    expect(envPath).toBeDefined();
    expect(existsSync(envPath as string)).toBe(true);
  });

  it('writes the .env at 0600, because it holds every secret', async () => {
    const vps = vpsWithTemplate();
    await install(vps);

    // ⚠ Asserted on the REAL file, not on the argument passed to the writer.
    // `mode` on writeFileSync applies only when a file is CREATED, so a
    // rewritten pre-existing `.env` kept whatever mode it had -- which is
    // exactly the bug this permission check exists to catch.
    expect(statSync(resolveEnvPath(vps.deployRoot) as string).mode & 0o777).toBe(0o600);
  });

  it('carries the operator answers into the file rather than the defaults', async () => {
    const vps = vpsWithTemplate();
    await install(vps);

    const contents = readFileSync(resolveEnvPath(vps.deployRoot) as string, 'utf8');

    const written = parseEnvFile(contents);

    expect(written.get('POSTGRES_PASSWORD')).toBe(ANSWERS.get('POSTGRES_PASSWORD'));

    // ⚠ NOT the template placeholder. `postgres` is the value nobody chose,
    // and a run that writes it has silently ignored what was supplied -- which
    // is how a deployment ends up serving with the password from the example
    // file. `unattendedAnswers` never produces it, so this is a real
    // distinction rather than a tautology.
    expect(written.get('POSTGRES_PASSWORD')).not.toBe('postgres');
    expect(written.get('INITIAL_ADMIN_EMAIL')).toBe(ANSWERS.get('INITIAL_ADMIN_EMAIL'));
  });

  it('reproduces the template section banners, so the file diffs against it', async () => {
    const vps = vpsWithTemplate();
    await install(vps);

    const contents = readFileSync(resolveEnvPath(vps.deployRoot) as string, 'utf8');

    // ⚠ DERIVED FROM WHAT WAS ACTUALLY WRITTEN, not transcribed and not taken
    // from the whole template.
    //
    // Transcribing banner names drifts silently the moment a section is
    // renamed. But asserting EVERY template section is also wrong, and wrongly
    // strict: a section whose keys were all skipped -- optional variables the
    // operator declined -- correctly produces no banner, because a banner over
    // nothing is noise. So the invariant is narrower and truer: every section
    // that has a key in the file has its banner in the file.
    const written = parseEnvFile(contents);
    const sections = SPECS.filter((spec) => written.has(spec.key))
      .map((spec) => spec.section)
      .filter((section, index, all) => section !== '' && all.indexOf(section) === index);

    expect(sections.length).toBeGreaterThan(2);
    for (const section of sections) {
      expect(contents).toContain(`# ${section}`);
    }
  });

  it('runs every compose command under an explicit project name', async () => {
    const vps = vpsWithTemplate();
    await install(vps);

    // `docker compose version` is the host-facts probe (issue #392): it asks
    // the CLI plugin its own version and touches no project, so `-p` has no
    // meaning there.
    const composeCalls = vps
      .calls('docker', 'compose')
      .filter((call) => call.argv[2] !== 'version');
    expect(composeCalls.length).toBeGreaterThan(0);

    // ⚠ Without `-p`, Compose derives the project from the compose file's
    // DIRECTORY -- which is `compose` for every deployment on the host, so two
    // applications collide on one project and each `up -d` fights the other.
    for (const call of composeCalls) {
      expect(call.argv).toContain('-p');
    }
  });

  it('records the state file only after the pipeline succeeds', async () => {
    const vps = vpsWithTemplate();

    expect(readState(vps.deployRoot)).toBeUndefined();
    await install(vps);
    expect(readState(vps.deployRoot)).toBeDefined();
  });

  it('records the partial state when a step fails, so --resume has something to resume', async () => {
    const vps = vpsWithTemplate();
    // ⚠ The build is the realistic failure: long, the step people actually
    // watch fail, and late enough that several steps already completed --
    // which is the entire point of recording them.
    vps.route(
      (invocation) =>
        invocation.argv[0] === 'docker' && invocation.argv.includes('build'),
      { fail: new Error('build failed') },
    );

    await expect(install(vps)).rejects.toThrow();

    // ⚠ WITHOUT THIS RECORD `--resume` RESUMED NOTHING. `completedSteps` was
    // written only on the SUCCESS path, so the one run that needs resuming --
    // a failed one -- left no trace of its progress, and the flag the error
    // message recommends in its very next line skipped zero steps and rebuilt
    // everything. The message was true about intent and false about behaviour.
    const state = readState(vps.deployRoot);
    expect(state?.lastOutcome).toBe('failure');
    expect(state?.lastFailedStep).toBeDefined();
    expect((state?.completedSteps ?? []).length).toBeGreaterThan(0);
  });

  it('marks a successful run as such rather than leaving it to be inferred', async () => {
    const vps = vpsWithTemplate();
    await install(vps);

    const state = readState(vps.deployRoot);
    expect(state?.lastOutcome).toBe('success');
    // ⚠ `lastFailedStep` must be ABSENT, not stale. A success still carrying
    // the previous run's failed step would have `decideResume` offer to
    // continue from a step that has since completed.
    expect(state?.lastFailedStep).toBeUndefined();
  });

  it('refuses to answer a command no route covers', async () => {
    const vps = createFakeVps({ routes: [] });

    // ⚠ The alternative -- a default "exit 0, empty stdout" -- is what makes a
    // fake dangerous: a step shelling into something the test author never
    // considered would pass, silently, having done nothing.
    await expect(
      vps.runCommand(['certbot', 'certonly'], { cwd: vps.deployRoot }),
    ).rejects.toThrow(/nothing answers/);
  });

  it('lets a later route override an earlier default', async () => {
    const vps = createFakeVps();
    vps.route(['git', 'rev-parse', 'HEAD'], 'f'.repeat(40));

    const result = await vps.runCommand(['git', 'rev-parse', 'HEAD'], {
      cwd: vps.deployRoot,
    });

    expect(result.stdout).toBe('f'.repeat(40));
  });
});

describe('deploy status asks the deployment, not the bookkeeping about it', () => {
  it('reports on a deployment whose state file is gone', async () => {
    const vps = vpsWithTemplate();
    await install(vps);

    // ⚠ The clone is FAKED here -- `git clone` is answered, not executed -- so
    // the `.git` a real checkout would have has to be laid down by hand. It is
    // half of what `isDeployment` asks for, and the half this fixture cannot
    // produce on its own.
    mkdirSync(join(vps.deployRoot, 'repo', '.git'), { recursive: true });

    // The record is what `install` wrote; the deployment is the checkout and
    // the `.env`. Removing the first leaves the second entirely intact.
    rmSync(join(vps.deployRoot, '.appctl-deploy.json'), { force: true });
    expect(readState(vps.deployRoot)).toBeUndefined();
    expect(isDeployment(vps.deployRoot)).toBe(true);

    // ⚠ THE DEFECT THIS PINS, and it is the same wrong question `update` used
    // to ask, from the other side. Guarding on the state file meant a
    // deployment whose record was lost -- containers up, certificate issued,
    // site serving -- was reported as "No deployment found" by the ONE command
    // an operator runs when something is wrong.
    await expect(
      runStatusCommand(
        { root: vps.deployRoot, port: String(api.port), json: true, color: false },
        { runCommand: vps.runCommand, stdout: sink(), stderr: sink() },
      ),
    ).resolves.toBeUndefined();
  });

  it('still refuses when nothing is installed there at all', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'appctl-fake-vps-empty-'));

    // ⚠ The distinction is preserved, just asked of the deployment rather than
    // of the record: "nothing installed" is a usage problem, "installed and
    // unhealthy" is not, and a monitoring script must tell them apart.
    await expect(
      runStatusCommand(
        { root: empty, port: String(api.port), json: true, color: false },
        { runCommand: vpsWithTemplate().runCommand, stdout: sink(), stderr: sink() },
      ),
    ).rejects.toThrow(/No deployment found/);
  });
});

/** A writable stream that keeps nothing; the assertions are on the outcome. */
function sink(): NodeJS.WritableStream {
  return { write: () => true } as unknown as NodeJS.WritableStream;
}

describe('the deployment record the About page reads', () => {
  it('is written where the compose file bind-mounts it', async () => {
    const vps = vpsWithTemplate();
    await install(vps);

    // ⚠ THE GAP THIS CLOSES. The API reader, the bind mount and the Console
    // page all shipped; nothing wrote the file. Install created the DIRECTORY
    // -- so Docker would not create it root-owned -- and stopped there, so the
    // About page reported `absent` on every deployment, including ones this
    // CLI had just deployed.
    const path = join(vps.deployRoot, 'deploy-info', 'info.json');
    expect(existsSync(path)).toBe(true);
  });

  it('writes a document the API reader accepts', async () => {
    const vps = vpsWithTemplate();
    await install(vps);

    const document = JSON.parse(
      readFileSync(join(vps.deployRoot, 'deploy-info', 'info.json'), 'utf8'),
    ) as Record<string, unknown>;

    // ⚠ `schema` IS THE ONE FIELD THE READER VALIDATES STRICTLY, and the number
    // never moves. A bump to add an optional field makes every already-deployed
    // API answer `invalid` the instant a newer CLI writes its file -- before
    // the container it describes has necessarily restarted.
    expect(document['schema']).toBe(1);

    // Every other field is read leniently, so the contract that matters is
    // that the SHAPE is there and absence is spelled `null` rather than by
    // omitting the key -- an explicit null says a human decided, a missing key
    // says a writer forgot.
    const app = document['app'] as Record<string, unknown>;
    expect(Object.keys(app).sort()).toEqual(['commitSha', 'name', 'ref', 'version']);
    for (const key of ['installedAt', 'updatedAt', 'deployedBy', 'domain', 'remote', 'run']) {
      expect(document).toHaveProperty(key);
    }

    const run = document['run'] as Record<string, unknown>;
    expect(Array.isArray(run['completed'])).toBe(true);
    // The steps that had completed by the health gate, which is what makes the
    // About page's third state -- complete, but the run did not finish --
    // renderable at all.
    expect((run['completed'] as string[]).length).toBeGreaterThan(0);
  });

  it('replaces the document atomically, leaving no temp file behind', async () => {
    const vps = vpsWithTemplate();
    await install(vps);

    // ⚠ The DIRECTORY is bind-mounted, not the file, precisely so a rename can
    // hand the container a new document with no restart. A temp file left in
    // that directory would be visible inside the container.
    expect(existsSync(join(vps.deployRoot, 'deploy-info', 'info.json.tmp'))).toBe(false);
  });
});

describe('the CLI writes its own marker into the .env', () => {
  it('records DEPLOY_ROOT, which the bind mount and the inventory both read', async () => {
    const vps = vpsWithTemplate();
    await install(vps);

    const written = parseEnvFile(
      readFileSync(resolveEnvPath(vps.deployRoot) as string, 'utf8'),
    );

    // ⚠ THIS KEY WAS READ IN THREE PLACES AND WRITTEN IN NONE, and every one
    // of the three failed silently:
    //
    //   - `vps.compose.yml` interpolates it for the deploy-info bind mount.
    //     Unset, it falls back to `./.deploy/deploy-info`, so the api
    //     container mounts an empty directory and the About page reports
    //     `absent` for ever -- with every deploy step reporting green, because
    //     the stack is up and the fallback path is perfectly valid.
    //   - `layout.ts` uses it as the marker for an `.env` THIS CLI wrote, so
    //     the ambiguity refusal labelled our own deployments as unmarked.
    //   - `version-step.ts`'s comment describes it as already being there.
    //
    // The real-Docker E2E is what caught it: `cat` inside the container said
    // "No such file or directory" for a document sitting on the host disk.
    expect(written.get('DEPLOY_ROOT')).toBe(vps.deployRoot);
  });

  it('puts it under the not-in-template banner, since it is not an answer', () => {
    // It is deliberately absent from `.env.example` -- that is precisely what
    // makes it usable as a marker, because a stranger's file cannot have it.
    const vps = vpsWithTemplate();

    return install(vps).then(() => {
      const contents = readFileSync(resolveEnvPath(vps.deployRoot) as string, 'utf8');
      const banner = contents.indexOf('# Not in .env.example');

      expect(banner).toBeGreaterThan(-1);
      expect(contents.indexOf('DEPLOY_ROOT=')).toBeGreaterThan(banner);
    });
  });

  it('does NOT write COMPOSE_PROJECT_NAME', async () => {
    const vps = vpsWithTemplate();
    await install(vps);

    const contents = readFileSync(resolveEnvPath(vps.deployRoot) as string, 'utf8');

    // ⚠ A REFUSAL, AND IT PREVENTS AN OUTAGE. The project name reaches compose
    // through `-p` on every invocation this CLI makes. Writing it into an
    // EXISTING deployment's `.env` RENAMES the project: compose then sees no
    // existing containers, builds a parallel stack, and collides with the old
    // one on the bind port. A bookkeeping change causing an outage.
    expect(contents).not.toContain('COMPOSE_PROJECT_NAME');
  });
});

// =============================================================================
// Host facts and deployment history  (issue #392)
// =============================================================================
//
// The REAL pipelines, end to end: what a successful run records in the state
// file and in info.json, what a failed one leaves alone, and that the two
// documents carry the same history.
// =============================================================================

const FIXTURE = JSON.parse(
  readFileSync(
    resolve(__dirname, '..', '..', '..', '..', 'api', 'test', 'fixtures', 'deploy-info.sample.json'),
    'utf8',
  ),
) as Record<string, unknown>;

/** Recursive key set; see deploy-info.test.ts. `remote` is excluded by the callers. */
function keyShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [keyShape(value[0])];
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, keyShape((value as Record<string, unknown>)[key])]),
    );
  }
  return 'leaf';
}

function readInfo(vps: ReturnType<typeof createFakeVps>): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(vps.deployRoot, 'deploy-info', 'info.json'), 'utf8'),
  ) as Record<string, unknown>;
}

function failTheBuild(vps: ReturnType<typeof createFakeVps>): void {
  vps.route(
    (invocation) => invocation.argv[0] === 'docker' && invocation.argv.includes('build'),
    { fail: new Error('build failed') },
  );
}

describe('host facts and deployment history (issue #392)', () => {
  it('records one success entry, the host and the proxy on a successful install', async () => {
    const vps = vpsWithTemplate();
    vps.route(['docker', 'version', '--format'], '27.3.1');
    vps.route(['docker', 'compose', 'version', '--short'], '2.29.7');

    await install(vps);

    const state = readState(vps.deployRoot);
    expect(state?.version).toBe(2);
    expect(state?.history).toHaveLength(1);
    expect(state?.history?.[0]).toMatchObject({
      command: 'install',
      commitSha: state?.commitSha,
      previousCommitSha: null,
      ref: 'main',
      outcome: 'success',
    });
    expect(state?.history?.[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(state?.history?.[0]?.at).toBe(state?.lastDeployedAt);

    expect(state?.host?.dockerVersion).toBe('27.3.1');
    expect(state?.host?.composeVersion).toBe('2.29.7');
    expect(state?.host?.capturedAt).toEqual(expect.any(String));

    // A domain with no certificate on disk: the expiry is unknown, not invented.
    expect(state?.proxy).toMatchObject({
      domain: 'app.example.test',
      bindPort: api.port,
      certificateExpiresAt: null,
    });

    // Host facts are probed ONCE per run, not per write.
    expect(vps.calls('docker', 'version')).toHaveLength(1);
    expect(vps.calls('docker', 'compose', 'version')).toHaveLength(1);
  });

  it('rewrites info.json at the end of the run, carrying the same history as the state', async () => {
    const vps = vpsWithTemplate();
    await install(vps);

    const info = readInfo(vps);
    const state = readState(vps.deployRoot);

    // ⚠ The health-gate write predates this run's success, so without the
    // end-of-run rewrite the About page would show an empty history.
    expect(info['history']).toEqual(state?.history);
    expect(info['lastCommand']).toBe('install');
    expect(info['bindPort']).toBe(api.port);
    expect(info['host']).toEqual(state?.host);
    expect((info['run'] as { completed: string[] }).completed).toContain('verify');
  });

  it('writes info.json with exactly the shared fixture key set at every level', async () => {
    const vps = vpsWithTemplate();
    await install(vps);

    const { remote: _infoRemote, ...info } = readInfo(vps);
    const { remote: _fixtureRemote, ...fixture } = FIXTURE;

    expect(keyShape(info)).toEqual(keyShape(fixture));
    expect(Object.keys(readInfo(vps)).sort()).toEqual(Object.keys(FIXTURE).sort());
  });

  it('appends newest first across successful runs, naming what each replaced', async () => {
    const vps = vpsWithTemplate();
    await install(vps);
    const first = readState(vps.deployRoot);

    vps.route(['git', 'rev-parse', 'HEAD'], 'd'.repeat(40));
    await install(vps, { reinstall: true });

    const history = readState(vps.deployRoot)?.history ?? [];
    expect(history).toHaveLength(2);
    expect(history[0]?.commitSha).toBe('d'.repeat(40));
    expect(history[0]?.previousCommitSha).toBe(first?.commitSha);
    expect(history[1]).toEqual(first?.history?.[0]);
  });

  it('does not append history for a failed run, and keeps the history already there', async () => {
    const vps = vpsWithTemplate();
    await install(vps);
    const before = readState(vps.deployRoot);

    failTheBuild(vps);
    await expect(install(vps, { reinstall: true })).rejects.toThrow();

    const after = readState(vps.deployRoot);
    expect(after?.lastOutcome).toBe('failure');
    expect(after?.history).toEqual(before?.history);
    // Host/proxy are what the last SUCCESSFUL run observed.
    expect(after?.host).toEqual(before?.host);
    expect(after?.proxy).toEqual(before?.proxy);
  });

  it('a failed first install records no history at all', async () => {
    const vps = vpsWithTemplate();
    failTheBuild(vps);

    await expect(install(vps)).rejects.toThrow();

    expect(readState(vps.deployRoot)?.history ?? []).toEqual([]);
  });

  it('keeps the state file 0600 and free of every secret the env answers carried', async () => {
    const vps = vpsWithTemplate();
    await install(vps);

    expect(statSync(deployStatePath(vps.deployRoot)).mode & 0o777).toBe(0o600);

    const raw = readFileSync(deployStatePath(vps.deployRoot), 'utf8');
    const info = readFileSync(join(vps.deployRoot, 'deploy-info', 'info.json'), 'utf8');
    const secrets = [...ANSWERS]
      .filter(([key]) => /SECRET|PASSWORD|TOKEN|ENCRYPTION_KEY|CLIENT_ID/.test(key))
      .map(([, value]) => value);

    expect(secrets.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      expect(raw).not.toContain(secret);
      expect(info).not.toContain(secret);
    }
  });

  it('an update appends to the history an install began, and rewrites info.json', async () => {
    const vps = vpsWithTemplate();
    await install(vps);
    const installed = readState(vps.deployRoot);

    // The fake clone needs a `.git` for update's own bookkeeping, and a new
    // revision for the fetch to move to.
    mkdirSync(join(vps.deployRoot, 'repo', '.git'), { recursive: true });
    vps.route(['git', 'rev-parse', 'HEAD'], 'e'.repeat(40));
    // Update's light preflight checks free space; install's skipped doctor did not.
    vps.route(
      ['df'],
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 10000000 80000000 12% /',
    );

    await runUpdate({
      deployRoot: vps.deployRoot,
      runCommand: vps.runCommand,
      nonInteractive: true,
      skipProxy: true,
      skipSeed: true,
      noVersionBump: true,
      force: true,
      answers: new Map([...ANSWERS, ['POSTGRES_PORT', String(probe.port)]]),
    });

    const state = readState(vps.deployRoot);
    expect(state?.history).toHaveLength(2);
    expect(state?.history?.[0]).toMatchObject({ command: 'update', outcome: 'success' });
    expect(state?.history?.[1]).toEqual(installed?.history?.[0]);

    const info = readInfo(vps);
    expect(info['lastCommand']).toBe('update');
    expect(info['history']).toEqual(state?.history);
  });
  it('an update that finds nothing new deploys nothing, and so records nothing', async () => {
    const vps = vpsWithTemplate();
    await install(vps);
    const before = readState(vps.deployRoot);

    mkdirSync(join(vps.deployRoot, 'repo', '.git'), { recursive: true });
    vps.route(
      ['df'],
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 10000000 80000000 12% /',
    );

    const result = await runUpdate({
      deployRoot: vps.deployRoot,
      runCommand: vps.runCommand,
      nonInteractive: true,
      skipProxy: true,
      noVersionBump: true,
    });

    expect(result.changed).toBe(false);
    expect(readState(vps.deployRoot)?.history).toEqual(before?.history);
  });
});

// =============================================================================
// Install acting on what it used to only report  (issue #391)
// =============================================================================

describe('ensure-database, through the real pipeline', () => {
  /** psql against the application database answers 3D000; everything else works. */
  function vpsWithoutDatabase(): ReturnType<typeof createFakeVps> {
    const vps = vpsWithTemplate();
    vps.route(
      (invocation) =>
        invocation.argv.includes('psql') &&
        invocation.argv.includes('appdb') &&
        invocation.argv[invocation.argv.length - 1] === 'select 1',
      () =>
        vps.calls('docker', 'run').some((call) => /CREATE DATABASE/.test(call.argv.join(' ')))
          ? { stdout: '1' }
          : { fail: new Error('FATAL:  database "appdb" does not exist (3D000)') },
    );
    vps.route(
      (invocation) => invocation.argv.includes('psql') && /rolcreatedb/.test(invocation.argv.join(' ')),
      't',
    );
    // #396: the re-verify after the CREATE asks this for real now, where it
    // used to be `skipped: database-exists did not pass`.
    vps.route(
      (invocation) => invocation.argv.includes('psql') && /has_schema_privilege/.test(invocation.argv.join(' ')),
      't',
    );
    return vps;
  }

  const database = new Map([['POSTGRES_DB', 'appdb']]);

  it('stops a non-interactive run without --create-database, naming the flag, and creates nothing', async () => {
    const vps = vpsWithoutDatabase();

    // --skip-doctor (the harness default) skips preflight, so the refusal
    // comes from ensure-database -- still before anything is built or migrated.
    await expect(install(vps, { answers: database })).rejects.toThrow(/--create-database/);

    expect(vps.invocations.some((call) => /CREATE DATABASE/.test(call.argv.join(' ')))).toBe(false);
    expect(readState(vps.deployRoot)?.lastFailedStep).toBe('ensure-database');
    expect(vps.calls('docker', 'compose').some((call) => call.argv.includes('build'))).toBe(false);
  });

  it('with preflight on and the settings already known, stops at preflight -- before anything is cloned (#396)', async () => {
    const vps = vpsWithoutDatabase();

    // ⚠ The harness answers no host checks (df, DNS...), so preflight has
    // other reasons to fail too. The assertions are that the database refusal
    // is AMONG them -- flag, POSTGRES_DB, the .env path -- and that it came
    // from preflight, with nothing cloned or written.

    const error = await install(vps, { answers: database, skipDoctor: false }).catch((caught: unknown) => caught);

    expect((error as Error).message).toMatch(/--create-database/);
    expect((error as Error).message).toContain('POSTGRES_DB');
    expect((error as Error).message).toContain(join(vps.deployRoot, 'repo', 'infra', 'compose', '.env'));
    expect(readState(vps.deployRoot)?.lastFailedStep).toBe('preflight');
    expect(vps.invocations.some((call) => call.argv.includes('clone'))).toBe(false);
    expect(existsSync(join(vps.deployRoot, 'repo', 'infra', 'compose', '.env'))).toBe(false);
    expect(vps.invocations.some((call) => /CREATE DATABASE/.test(call.argv.join(' ')))).toBe(false);
  });

  it('an interactive run is never asked, or refused, about the database by preflight (#396)', async () => {
    const vps = vpsWithoutDatabase();
    const questions: string[] = [];

    // Preflight still fails here, on the host checks the harness does not
    // answer (see the test above) -- what this pins is that the database was
    // not among its reasons and nothing was asked: an interactive run gets
    // its one question from ensure-database, with the settings it wrote.
    const error = await install(vps, {
      answers: database,
      skipDoctor: false,
      nonInteractive: false,
      ask: async (question) => {
        questions.push(question);
        return false;
      },
    }).catch((caught: unknown) => caught);

    expect(readState(vps.deployRoot)?.lastFailedStep).toBe('preflight');
    expect((error as Error).message).not.toMatch(/database-exists|--create-database|POSTGRES_DB/);
    expect(questions).toEqual([]);
    expect(vps.invocations.some((call) => /rolcreatedb|CREATE DATABASE/.test(call.argv.join(' ')))).toBe(false);
  });

  it('re-verifies after the CREATE: database-privileges gives a real answer, not a skip (#396)', async () => {
    const vps = vpsWithoutDatabase();

    await install(vps, { answers: database, createDatabase: true });

    const privilegeProbes = vps.invocations.filter((call) => /has_schema_privilege/.test(call.argv.join(' ')));
    const createAt = vps.invocations.findIndex((call) => /CREATE DATABASE/.test(call.argv.join(' ')));
    expect(createAt).toBeGreaterThanOrEqual(0);
    // At least one privileges probe ran AFTER the database existed.
    expect(privilegeProbes.some((call) => vps.invocations.indexOf(call) > createAt)).toBe(true);
  });

  it('stops after the CREATE when the new database cannot take a table, and drops nothing (#396)', async () => {
    const vps = vpsWithoutDatabase();
    vps.route(
      (invocation) => invocation.argv.includes('psql') && /has_schema_privilege/.test(invocation.argv.join(' ')),
      'f',
    );

    await expect(install(vps, { answers: database, createDatabase: true })).rejects.toThrow(
      /GRANT CREATE ON SCHEMA public/,
    );
    expect(readState(vps.deployRoot)?.lastFailedStep).toBe('ensure-database');
    expect(vps.invocations.some((call) => /DROP/i.test(call.argv.join(' ')))).toBe(false);
  });

  it('creates it with --create-database and carries on to a healthy stack', async () => {
    const vps = vpsWithoutDatabase();

    await install(vps, { answers: database, createDatabase: true });

    const creates = vps.invocations.filter((call) => /CREATE DATABASE/.test(call.argv.join(' ')));
    expect(creates).toHaveLength(1);
    expect(creates[0]?.argv).toContain('postgres');
    expect(creates[0]?.argv[creates[0].argv.length - 1]).toBe('CREATE DATABASE "appdb"');
    expect(readState(vps.deployRoot)?.lastOutcome).toBe('success');
  });
});

// =============================================================================
// --resume against a state predating the #391 steps  (backward compatibility)
// =============================================================================
//
// `completedSteps` on a real deployment's state file was written by whatever
// CLI version last succeeded there. A deployment installed BEFORE #391 added
// `validate-environment`'s database gate, `ensure-database`, `proxy-bootstrap`
// and `renewal` simply has no entry for any of them -- there is no migration
// that could have retrofitted one. `--resume` must run them anyway: the
// pipeline skips a step only when its OWN id is in `completed`, so an id that
// never existed in an older run is, correctly, not "already done".
// =============================================================================
describe('--resume against an older state missing the #391 step ids', () => {
  /** psql against the application database answers 3D000; everything else works. */
  function vpsWithoutDatabase(): ReturnType<typeof createFakeVps> {
    const vps = vpsWithTemplate();
    vps.route(
      (invocation) =>
        invocation.argv.includes('psql') &&
        invocation.argv.includes('appdb') &&
        invocation.argv[invocation.argv.length - 1] === 'select 1',
      () =>
        vps.calls('docker', 'run').some((call) => /CREATE DATABASE/.test(call.argv.join(' ')))
          ? { stdout: '1' }
          : { fail: new Error('FATAL:  database "appdb" does not exist (3D000)') },
    );
    vps.route(
      (invocation) => invocation.argv.includes('psql') && /rolcreatedb/.test(invocation.argv.join(' ')),
      't',
    );
    // #396: the re-verify after the CREATE asks this for real now, where it
    // used to be `skipped: database-exists did not pass`.
    vps.route(
      (invocation) => invocation.argv.includes('psql') && /has_schema_privilege/.test(invocation.argv.join(' ')),
      't',
    );
    return vps;
  }

  const database = new Map([['POSTGRES_DB', 'appdb']]);

  it('re-runs validate-environment and ensure-database, reading the .env this CLI already wrote to disk', async () => {
    const vps = vpsWithoutDatabase();
    await install(vps, { answers: database, createDatabase: true });

    const installed = readState(vps.deployRoot);
    expect(installed?.completedSteps).toContain('ensure-database');

    // ⚠ THE SETUP: a completedSteps list an OLDER CLI could actually have
    // written -- `environment` (so `context.env` is undefined this run,
    // exactly as it would be for a real pre-#391 deployment) but nothing that
    // did not exist yet.
    const preDatabaseGate = new Set(['validate-environment', 'ensure-database', 'proxy-bootstrap', 'renewal']);
    const olderCompletedSteps = (installed?.completedSteps ?? []).filter((id) => !preDatabaseGate.has(id));
    expect(olderCompletedSteps).toContain('environment');
    expect(olderCompletedSteps).not.toContain('ensure-database');

    writeState({
      ...(installed as DeployState),
      completedSteps: olderCompletedSteps,
      lastOutcome: 'failure',
      lastFailedStep: 'validate-environment',
    } as DeployState);

    const psqlCallsBefore = vps.calls('docker', 'run').filter((call) => call.argv.includes('psql')).length;

    // ⚠ IF `ensure-database` HAD SILENTLY STAYED UNDEFINED (context.env), this
    // would throw "No environment to read the database settings from" instead
    // of resolving -- environmentOf's disk fallback is what makes it succeed.
    await expect(install(vps, { answers: database, createDatabase: true, resume: true })).resolves.toBeDefined();

    const resumed = readState(vps.deployRoot);
    expect(resumed?.lastOutcome).toBe('success');
    // Both ran again this time, rather than being treated as already done.
    expect(resumed?.completedSteps).toContain('validate-environment');
    expect(resumed?.completedSteps).toContain('ensure-database');

    const psqlCallsAfter = vps.calls('docker', 'run').filter((call) => call.argv.includes('psql')).length;
    expect(psqlCallsAfter).toBeGreaterThan(psqlCallsBefore);
  });
});

describe('the OAuth check, through the real pipeline', () => {
  it('stops before the build on invalid_client, and the secret never reaches the log', async () => {
    const vps = vpsWithTemplate();
    const google = fakeGoogleFetch({ status: 401, error: 'invalid_client' });

    await expect(install(vps, { fetch: google.fetch })).rejects.toThrow(/rejected the client credentials/);

    expect(google.tokenRequests).toHaveLength(1);
    expect(vps.calls('docker', 'compose').some((call) => call.argv.includes('build'))).toBe(false);

    const secret = ANSWERS.get('GOOGLE_CLIENT_SECRET') as string;
    const logs = join(vps.deployRoot, 'logs');
    for (const name of readdirSync(logs)) {
      expect(readFileSync(join(logs, name), 'utf8')).not.toContain(secret);
    }
  });

  it('fails verify when the running API redirects with another client id', async () => {
    const vps = vpsWithTemplate();
    api.setOAuth({ clientId: 'someone-else.apps.googleusercontent.com', callbackUrl: 'https://app.example.test/api/auth/google/callback' });
    try {
      await expect(install(vps)).rejects.toThrow(/Sign-in is broken/);
      expect(readState(vps.deployRoot)?.lastFailedStep).toBe('verify');
    } finally {
      api.setOAuth({ clientId: FAKE_GOOGLE_CLIENT_ID, callbackUrl: 'https://app.example.test/api/auth/google/callback' });
    }
  });

  it('runs neither the probe nor the smoke with --skip-oauth-check', async () => {
    const vps = vpsWithTemplate();
    const google = fakeGoogleFetch({ status: 401, error: 'invalid_client' });
    api.setOAuth(undefined);
    try {
      await install(vps, { fetch: google.fetch, skipOAuthCheck: true });
      expect(google.tokenRequests).toHaveLength(0);
    } finally {
      api.setOAuth({ clientId: FAKE_GOOGLE_CLIENT_ID, callbackUrl: 'https://app.example.test/api/auth/google/callback' });
    }
  });
});

describe('the stack\'s external networks exist before compose instantiates it (#391)', () => {
  const BASE = 'networks:\n  app-network:\n    driver: bridge\n  devnet:\n    external: true\n    name: devnet\n';

  function vpsWithNetworks(): ReturnType<typeof createFakeVps> {
    return createFakeVps({
      envExample: TEMPLATE,
      files: { 'repo/infra/compose/base.compose.yml': BASE },
    });
  }

  function indexOf(vps: ReturnType<typeof createFakeVps>, predicate: (argv: readonly string[]) => boolean): number {
    return vps.invocations.findIndex((call) => predicate(call.argv));
  }

  const isCreate = (argv: readonly string[]) => argv.join(' ') === 'docker network create devnet';
  const isFirstInstantiation = (argv: readonly string[]) =>
    argv[0] === 'docker' && argv[1] === 'compose' && (argv.includes('run') || argv.includes('up'));

  it('creates devnet before the first compose run/up when inspect cannot find it', async () => {
    const vps = vpsWithNetworks();
    vps.route(['docker', 'network', 'inspect', 'devnet'], { fail: new Error('Error: No such network: devnet') });

    await install(vps);

    const created = indexOf(vps, isCreate);
    expect(created).toBeGreaterThanOrEqual(0);
    expect(created).toBeLessThan(indexOf(vps, isFirstInstantiation));
    expect(created).toBeLessThan(indexOf(vps, (argv) => argv[1] === 'compose' && argv.includes('up')));
    // Once per run, not once per compose call.
    expect(vps.calls('docker', 'network', 'create')).toHaveLength(1);
  });

  it('does not create it when it already exists', async () => {
    const vps = vpsWithNetworks();

    await install(vps);

    expect(vps.calls('docker', 'network', 'inspect', 'devnet')).toHaveLength(1);
    expect(vps.calls('docker', 'network', 'create')).toHaveLength(0);
  });
});

// =============================================================================
// The observability group brings the telemetry stack with it  (issue #531)
// =============================================================================

describe('the compose files follow the recorded groups, through the real pipeline', () => {
  const GREPTIME_PASSWORDS = [
    'GREPTIME_WRITER_PASSWORD',
    'GREPTIME_READER_PASSWORD',
    'GREPTIME_ADMIN_PASSWORD',
  ] as const;

  const TELEMETRY_ANSWERS = new Map([
    ['GREPTIME_WRITER_PASSWORD', 'fake-writer-password'],
    ['GREPTIME_READER_PASSWORD', 'fake-reader-password'],
    ['GREPTIME_ADMIN_PASSWORD', 'fake-admin-password'],
  ]);

  /** Compose calls against the application stack (not `docker compose version`). */
  function stackCompose<T extends { argv: readonly string[] }>(calls: readonly T[]): T[] {
    return calls.filter(
      (call) => call.argv[0] === 'docker' && call.argv[1] === 'compose' && call.argv.includes('-f'),
    );
  }

  function composeFiles(invocation: { argv: readonly string[] }): string[] {
    return invocation.argv.filter((_, index) => invocation.argv[index - 1] === '-f');
  }

  it('install, update and status all name the telemetry files once observability is on', async () => {
    const vps = vpsWithTemplate();
    await install(vps, { groups: ['observability'], answers: TELEMETRY_ANSWERS });

    // Recorded, so the later commands below can act on it without the flag.
    expect(readState(vps.deployRoot)?.groups).toEqual(['observability']);

    const installCompose = stackCompose(vps.invocations);
    expect(installCompose.length).toBeGreaterThan(0);
    for (const call of installCompose) {
      expect(composeFiles(call)).toEqual([
        'base.compose.yml',
        'prod.compose.yml',
        'telemetry.compose.yml',
        'vps.compose.yml',
        'vps.telemetry.compose.yml',
      ]);
    }

    mkdirSync(join(vps.deployRoot, 'repo', '.git'), { recursive: true });
    vps.route(['git', 'rev-parse', 'HEAD'], 'e'.repeat(40));
    vps.route(
      ['df'],
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 10000000 80000000 12% /',
    );
    const before = vps.invocations.length;

    await runUpdate({
      deployRoot: vps.deployRoot,
      runCommand: vps.runCommand,
      nonInteractive: true,
      skipProxy: true,
      skipSeed: true,
      noVersionBump: true,
      force: true,
      answers: new Map([...ANSWERS, ...TELEMETRY_ANSWERS, ['POSTGRES_PORT', String(probe.port)]]),
    });

    const updateCompose = stackCompose(vps.invocations.slice(before));
    expect(updateCompose.length).toBeGreaterThan(0);
    for (const call of updateCompose) {
      expect(composeFiles(call)).toContain('telemetry.compose.yml');
      expect(composeFiles(call).at(-1)).toBe('vps.telemetry.compose.yml');
    }

    const beforeStatus = vps.invocations.length;
    await runStatusCommand(
      { root: vps.deployRoot, port: String(api.port), json: true, color: false },
      { runCommand: vps.runCommand, stdout: sink(), stderr: sink() },
    );

    const statusCompose = stackCompose(vps.invocations.slice(beforeStatus));
    expect(statusCompose.length).toBeGreaterThan(0);
    for (const call of statusCompose) {
      expect(composeFiles(call)).toContain('telemetry.compose.yml');
    }
  });

  it('a deployment installed without the group still gets the telemetry stack (#567)', async () => {
    const vps = vpsWithTemplate();
    await install(vps);

    // Always on, and recorded so the record says what actually runs.
    expect(readState(vps.deployRoot)?.groups).toEqual(['observability']);
    const composeCalls = stackCompose(vps.invocations);
    expect(composeCalls.length).toBeGreaterThan(0);
    for (const call of composeCalls) {
      expect(composeFiles(call)).toEqual([
        'base.compose.yml',
        'prod.compose.yml',
        'telemetry.compose.yml',
        'vps.compose.yml',
        'vps.telemetry.compose.yml',
      ]);
    }

    // The passwords were generated without an answer or a prompt.
    const env = parseEnvFile(readFileSync(resolveEnvPath(vps.deployRoot) as string, 'utf8'));
    for (const key of GREPTIME_PASSWORDS) {
      expect(env.get(key)).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(env.get('GREPTIME_HOST')).toBe('greptimedb');
    expect(env.get('OTEL_EXPORTER_OTLP_ENDPOINT')).toBe('http://otel-collector:4318');
  });

  /**
   * A deployment as a pre-#567 CLI left it: no `groups` in the record and no
   * OTEL_* / GREPTIME_* key in the `.env` (the wizard skipped the group).
   */
  async function legacyDeployment(
    overrides: ReadonlyMap<string, string> = new Map(),
  ): Promise<ReturnType<typeof createFakeVps>> {
    const vps = vpsWithTemplate();
    await install(vps);

    const { groups: _dropped, ...state } = readState(vps.deployRoot) as DeployState;
    writeState(state as DeployState);

    const envPath = resolveEnvPath(vps.deployRoot) as string;
    const kept = readFileSync(envPath, 'utf8')
      .split('\n')
      .filter((line) => !/^(OTEL_|GREPTIME_)/.test(line));
    for (const [key, value] of overrides) kept.push(`${key}=${value}`);
    writeFileSync(envPath, `${kept.join('\n')}\n`);

    mkdirSync(join(vps.deployRoot, 'repo', '.git'), { recursive: true });
    vps.route(['git', 'rev-parse', 'HEAD'], 'e'.repeat(40));
    vps.route(
      ['df'],
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 10000000 80000000 12% /',
    );
    return vps;
  }

  it('upgrades a deployment recorded without it on the next update, without prompting (#567)', async () => {
    const vps = await legacyDeployment();
    expect(readState(vps.deployRoot)?.groups).toBeUndefined();
    const before = vps.invocations.length;

    await runUpdate({
      deployRoot: vps.deployRoot,
      runCommand: vps.runCommand,
      nonInteractive: true,
      skipProxy: true,
      skipSeed: true,
      noVersionBump: true,
      force: true,
      // No GREPTIME_* answer: an unattended run must not need one.
      answers: new Map([...ANSWERS, ['POSTGRES_PORT', String(probe.port)]]),
    });

    const env = parseEnvFile(readFileSync(resolveEnvPath(vps.deployRoot) as string, 'utf8'));
    const passwords = GREPTIME_PASSWORDS.map((key) => env.get(key) as string);
    for (const value of passwords) {
      expect(value).toMatch(/^[0-9a-f]{64}$/);
      expect(value).not.toMatch(/[,=:]/);
    }
    expect(new Set(passwords).size).toBe(3);
    // The rest of the group takes its template defaults.
    expect(env.get('GREPTIME_HOST')).toBe('greptimedb');
    expect(env.get('GREPTIME_WRITER_USER')).toBe('writer');
    expect(env.get('OTEL_ENABLED')).toBe('true');

    const updateCompose = stackCompose(vps.invocations.slice(before));
    expect(updateCompose.length).toBeGreaterThan(0);
    for (const call of updateCompose) {
      expect(composeFiles(call)).toContain('telemetry.compose.yml');
      expect(composeFiles(call).at(-1)).toBe('vps.telemetry.compose.yml');
    }

    // Recorded now, so status and uninstall name the same files.
    expect(readState(vps.deployRoot)?.groups).toEqual(['observability']);
  });

  it('keeps a real password and replaces a placeholder on update (#567)', async () => {
    const vps = await legacyDeployment(
      new Map([
        ['GREPTIME_WRITER_PASSWORD', 'an-operator-chosen-writer-secret'],
        ['GREPTIME_READER_PASSWORD', 'change-me-reader'],
      ]),
    );

    await runUpdate({
      deployRoot: vps.deployRoot,
      runCommand: vps.runCommand,
      nonInteractive: true,
      skipProxy: true,
      skipSeed: true,
      noVersionBump: true,
      force: true,
      answers: new Map([...ANSWERS, ['POSTGRES_PORT', String(probe.port)]]),
    });

    const env = parseEnvFile(readFileSync(resolveEnvPath(vps.deployRoot) as string, 'utf8'));
    expect(env.get('GREPTIME_WRITER_PASSWORD')).toBe('an-operator-chosen-writer-secret');
    expect(env.get('GREPTIME_READER_PASSWORD')).toMatch(/^[0-9a-f]{64}$/);
    expect(env.get('GREPTIME_ADMIN_PASSWORD')).toMatch(/^[0-9a-f]{64}$/);
  });

  // ---------------------------------------------------------------------------
  // STACK_AGENT_TOKEN: vps.compose.yml refuses to start without it (#567)
  // ---------------------------------------------------------------------------

  function envOf(vps: ReturnType<typeof createFakeVps>): Map<string, string> {
    return parseEnvFile(readFileSync(resolveEnvPath(vps.deployRoot) as string, 'utf8'));
  }

  async function updateUnattended(vps: ReturnType<typeof createFakeVps>): Promise<void> {
    await runUpdate({
      deployRoot: vps.deployRoot,
      runCommand: vps.runCommand,
      nonInteractive: true,
      skipProxy: true,
      skipSeed: true,
      noVersionBump: true,
      force: true,
      // No STACK_AGENT_TOKEN answer: an unattended run must not need one.
      answers: new Map([...ANSWERS, ['POSTGRES_PORT', String(probe.port)]]),
    });
  }

  it('install generates STACK_AGENT_TOKEN without an answer or a prompt (#567)', async () => {
    const vps = vpsWithTemplate();
    await install(vps);

    const token = envOf(vps).get('STACK_AGENT_TOKEN');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // A secret: the journal redacts it like any other.
    expect(JSON.stringify(vps.invocations)).not.toContain(token);
  });

  it('update generates STACK_AGENT_TOKEN for a deployment that predates it (#567)', async () => {
    const vps = await legacyDeployment();
    const envPath = resolveEnvPath(vps.deployRoot) as string;
    writeFileSync(
      envPath,
      readFileSync(envPath, 'utf8')
        .split('\n')
        .filter((line) => !line.startsWith('STACK_AGENT_TOKEN='))
        .join('\n'),
    );
    expect(envOf(vps).has('STACK_AGENT_TOKEN')).toBe(false);

    await updateUnattended(vps);

    expect(envOf(vps).get('STACK_AGENT_TOKEN')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('update replaces an empty STACK_AGENT_TOKEN and keeps a real one (#567)', async () => {
    const blank = await legacyDeployment(new Map([['STACK_AGENT_TOKEN', '']]));
    const blankPath = resolveEnvPath(blank.deployRoot) as string;
    writeFileSync(
      blankPath,
      readFileSync(blankPath, 'utf8').replace(/^STACK_AGENT_TOKEN=[0-9a-f]{64}\n/m, ''),
    );
    expect(envOf(blank).get('STACK_AGENT_TOKEN')).toBe('');
    await updateUnattended(blank);
    expect(envOf(blank).get('STACK_AGENT_TOKEN')).toMatch(/^[0-9a-f]{64}$/);

    const chosen = 'an-operator-chosen-stack-agent-token-0123456789';
    const kept = await legacyDeployment(new Map([['STACK_AGENT_TOKEN', chosen]]));
    const keptPath = resolveEnvPath(kept.deployRoot) as string;
    writeFileSync(
      keptPath,
      readFileSync(keptPath, 'utf8').replace(/^STACK_AGENT_TOKEN=[0-9a-f]{64}\n/m, ''),
    );
    await updateUnattended(kept);
    expect(envOf(kept).get('STACK_AGENT_TOKEN')).toBe(chosen);
  });
});
