/**
 * A fake VPS: a real temp directory, and a `runCommand` that answers.
 *
 * =============================================================================
 * ⚠ WHAT THIS IS FOR, AND WHAT IT CANNOT CATCH
 * =============================================================================
 *
 * Every deploy test before this one mocked at the EDGES -- a stubbed step, a
 * hand-built context -- so the thing under test was never the pipeline. This
 * harness inverts that: the directory is real, the `.env` is a real file the
 * real writer wrote, and `runInstall`/`runUpdate` run their REAL steps in their
 * real order. Only the subprocesses are faked.
 *
 * ⚠ IT NEVER SPAWNS `docker`, AND THAT IS A KNOWN HOLE, NOT AN OVERSIGHT. A
 * change that breaks `docker compose build`, the migrate invocation, the `.env`
 * symlink resolution or `-p <project>` project naming passes every test built
 * on this harness, green. Those need the real-Docker E2E workflow
 * (`.github/workflows/deploy-e2e.yml`); this harness exists so the STEP LOGIC
 * is testable in a second rather than in ten minutes, not so the E2E can be
 * skipped.
 *
 * ⚠ AN UNMATCHED COMMAND THROWS. The alternative -- a default "exit 0, empty
 * stdout" -- is what makes a fake dangerous: a step that shells into something
 * the test author never considered would pass, silently, having done nothing.
 * Every argv a test's pipeline reaches must be answered on purpose. The thrown
 * message prints the full argv so adding the answer is mechanical.
 * =============================================================================
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { metadataFor } from '../env-metadata.js';
import type { EnvVarSpec } from '../env-spec.js';
import type { CommandResult, RunCommandOptions, runCommand } from '../executor.js';

export interface FakeInvocation {
  argv: readonly string[];
  cwd: string;
  /** The environment the caller passed, for asserting a secret was NOT in argv. */
  env?: NodeJS.ProcessEnv | undefined;
}

/** What a matched command answers with. A string is shorthand for stdout. */
export type FakeAnswer =
  | string
  | {
      stdout?: string | undefined;
      stderr?: string | undefined;
      exitCode?: number | undefined;
      /** Thrown instead of returned, for testing a step's failure path. */
      fail?: Error | undefined;
    };

/**
 * Matches an invocation.
 *
 * A prefix array (`['git', 'rev-parse']`) matches argv position by position,
 * which is the readable form for the ninety percent case. A predicate covers
 * the rest without turning the common case into one.
 */
export type FakeMatcher =
  | readonly string[]
  | ((invocation: FakeInvocation) => boolean);

export interface FakeRoute {
  match: FakeMatcher;
  answer: FakeAnswer | ((invocation: FakeInvocation) => FakeAnswer);
}

export interface FakeVpsOptions {
  /** Routes consulted in order; the FIRST match wins, so specific goes first. */
  routes?: readonly FakeRoute[] | undefined;
  /** Contents for `<deployRoot>/repo/infra/compose/.env.example`. */
  envExample?: string | undefined;
  /** Files to lay down, relative to the deploy root. */
  files?: Readonly<Record<string, string>> | undefined;
  /** Create `repo/.git` so `isDeployment` sees a checkout. */
  withCheckout?: boolean | undefined;
}

export interface FakeVps {
  /** The apps root. The deploy root is a directory under it. */
  appsRoot: string;
  deployRoot: string;
  /** Drop-in replacement for the real `runCommand`. */
  runCommand: typeof runCommand;
  /** Every invocation, in order, for assertions about what ran and how. */
  invocations: FakeInvocation[];
  /** Adds a route ahead of the existing ones, for a mid-test change. */
  route(match: FakeMatcher, answer: FakeRoute['answer']): void;
  /** Invocations whose argv starts with these words. */
  calls(...prefix: readonly string[]): FakeInvocation[];
  path(...segments: readonly string[]): string;
}

function matches(match: FakeMatcher, invocation: FakeInvocation): boolean {
  if (typeof match === 'function') return match(invocation);
  return match.every((word, index) => invocation.argv[index] === word);
}

function normalise(answer: FakeAnswer): Exclude<FakeAnswer, string> {
  return typeof answer === 'string' ? { stdout: answer } : answer;
}

/**
 * The routes every pipeline needs, so a test declares only what it cares about.
 *
 * ⚠ These are the COMMANDS, not the outcomes: each is the boring success a
 * pipeline needs to get past plumbing and reach the step under test. A test
 * asserting a failure overrides the one command it is about, and the override
 * wins because `route()` prepends.
 */
export function defaultRoutes(): FakeRoute[] {
  return [
    { match: ['git', 'rev-parse', 'HEAD'], answer: 'a'.repeat(40) },
    { match: ['git', 'rev-parse'], answer: 'b'.repeat(40) },
    { match: ['git', 'ls-remote'], answer: `${'c'.repeat(40)}\trefs/heads/main` },
    { match: ['git', 'symbolic-ref'], answer: 'refs/remotes/origin/main' },
    { match: ['git', 'status', '--porcelain'], answer: '' },
    { match: ['git'], answer: '' },
    { match: ['docker', 'compose'], answer: '' },
    // The proxy-container check (#390): the shared proxy is up.
    {
      match: ['docker', 'inspect', '--type', 'container', '--format', '{{.State.Running}}'],
      answer: 'true',
    },
    { match: ['docker'], answer: '' },
    { match: ['npm'], answer: '' },
  ];
}

export function createFakeVps(options: FakeVpsOptions = {}): FakeVps {
  const appsRoot = mkdtempSync(join(tmpdir(), 'appctl-fake-vps-'));
  const deployRoot = join(appsRoot, 'app');
  const composeDir = join(deployRoot, 'repo', 'infra', 'compose');

  mkdirSync(composeDir, { recursive: true });
  if (options.withCheckout === true) {
    mkdirSync(join(deployRoot, 'repo', '.git'), { recursive: true });
  }

  if (options.envExample !== undefined) {
    writeFileSync(join(composeDir, '.env.example'), options.envExample);
  }

  for (const [relative, contents] of Object.entries(options.files ?? {})) {
    const target = join(deployRoot, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, contents);
  }

  const routes: FakeRoute[] = [...(options.routes ?? []), ...defaultRoutes()];
  const invocations: FakeInvocation[] = [];

  const fakeRun: typeof runCommand = async (
    argv: readonly string[],
    runOptions: RunCommandOptions,
  ): Promise<CommandResult> => {
    const invocation: FakeInvocation = {
      argv,
      cwd: runOptions.cwd,
      ...(runOptions.env === undefined ? {} : { env: runOptions.env }),
    };
    invocations.push(invocation);

    const route = routes.find((candidate) => matches(candidate.match, invocation));

    if (route === undefined) {
      // ⚠ Throwing beats a silent success. See the header.
      throw new Error(
        `fake-vps: nothing answers \`${argv.join(' ')}\` (cwd ${runOptions.cwd}). ` +
          `Add a route for it rather than letting the step appear to succeed.`,
      );
    }

    const answer = normalise(
      typeof route.answer === 'function' ? route.answer(invocation) : route.answer,
    );

    if (answer.fail !== undefined) throw answer.fail;

    const stdout = answer.stdout ?? '';
    // Streamed to the caller line by line, because a step that reads its own
    // output through `onLine` rather than `result.stdout` would otherwise see
    // nothing here and pass for the wrong reason.
    for (const line of stdout.split('\n')) {
      if (line !== '') runOptions.onLine?.(line, 'stdout');
    }

    return {
      argv,
      cwd: runOptions.cwd,
      exitCode: answer.exitCode ?? 0,
      stdout,
      stderr: answer.stderr ?? '',
      durationMs: 0,
      timedOut: false,
    };
  };

  return {
    appsRoot,
    deployRoot,
    runCommand: fakeRun,
    invocations,
    route(match, answer) {
      // Prepended: a test's own route must beat the defaults it did not write.
      routes.unshift({ match, answer });
    },
    calls(...prefix) {
      return invocations.filter((invocation) =>
        prefix.every((word, index) => invocation.argv[index] === word),
      );
    },
    path(...segments) {
      return join(deployRoot, ...segments);
    },
  };
}

/**
 * Answers every ESSENTIAL variable, so an unattended run has nothing to ask.
 *
 * ⚠ AN UNATTENDED INSTALL MUST SUPPLY EVERY ESSENTIAL KEY, INCLUDING THE
 * SECRETS. That is not an oversight in the wizard, it is its rule: a
 * non-interactive run takes the template default only for a NON-essential key,
 * because a template default for an essential one is a placeholder nobody
 * chose (`POSTGRES_PASSWORD=postgres`), and deploying those credentials
 * silently is the opposite of what an unattended run should do. Generate-mode
 * secrets are likewise never generated without a terminal to confirm on.
 *
 * So this exists to make that rule cheap to satisfy in a test, NOT to paper
 * over it. The value it produces for a key is the first one that satisfies
 * that key's own validator, so a new validator makes this fail here rather
 * than at the far end of a pipeline.
 */
export function unattendedAnswers(
  specs: readonly EnvVarSpec[],
  overrides: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const answers = new Map<string, string>();

  for (const spec of specs) {
    const metadata = metadataFor(spec.key);
    if (metadata.never === true || metadata.fixed !== undefined) continue;
    if (metadata.derive !== undefined) continue;
    if (metadata.group !== undefined) continue;
    if (metadata.allowBlank === true) continue;

    // ⚠ MIRRORS THE WIZARD'S OWN NON-INTERACTIVE RULE rather than guessing at
    // it, so this stays true as that rule changes:
    //
    //   - an ESSENTIAL key takes no template default at all, because a default
    //     for an essential key is a placeholder nobody chose;
    //   - an OPTIONAL key the operator declined is skipped, not missing;
    //   - everything else takes its template default, which fails only when
    //     that default is blank.
    //
    // ⚠ THE THIRD CASE IS THE ONE THAT SURPRISES. `SECRETS_ENCRYPTION_KEY` is
    // not marked essential and is not commented out, and its template default
    // is blank -- and it is generate-mode, which never fires without a
    // terminal to confirm on. So an unattended install fails on it every time
    // unless it is answered here. That is the wizard's behaviour, not this
    // helper's, and the E2E's answers file has to carry it too.
    // A key the wizard generates itself, without asking (`autoGenerate`,
    // #567), is never blank and never needs an answer. Answering it here would
    // hide exactly the behaviour the tests exist to prove.
    if (metadata.autoGenerate === true && metadata.generate !== undefined) continue;

    const takesDefault = metadata.essential !== true && !spec.optional;
    const wouldBeBlank = metadata.essential === true || (takesDefault && spec.defaultValue === '');
    if (!wouldBeBlank) continue;

    const override = overrides.get(spec.key);
    if (override !== undefined) {
      answers.set(spec.key, override);
      continue;
    }

    // ⚠ THE SYNTHETIC VALUE IS TRIED FIRST AND THE TEMPLATE DEFAULT SECOND.
    //
    // The other order looks tidier and is wrong: for an ESSENTIAL key the
    // template default is a placeholder nobody chose, and several of them
    // (`GOOGLE_CLIENT_ID`, `POSTGRES_PASSWORD`) are rejected by their own
    // validator for precisely that reason. Preferring it would make this
    // helper fail on the keys it most needs to answer.
    const candidates = [candidateFor(spec.key), spec.defaultValue];
    const accepted = candidates.find(
      (candidate) => candidate !== '' && metadata.validate?.(candidate) === undefined,
    );

    if (accepted === undefined) {
      throw new Error(
        `fake-vps: no generated answer for ${spec.key} satisfies its own validator ` +
          `(${metadata.validate?.(candidates[0] as string) ?? 'blank'}). ` +
          `Add a case to candidateFor, or pass an override.`,
      );
    }

    answers.set(spec.key, accepted);
  }

  return answers;
}

/**
 * A plausible value for a key, shaped by what its validators actually want.
 *
 * Deliberately NOT random: a deterministic answer means a failing test prints
 * the same value twice in a row, which is the difference between a diff you
 * can read and one you cannot.
 */
function candidateFor(key: string): string {
  // Shaped like a real one, because install checks the shape (#391).
  if (key === 'GOOGLE_CLIENT_ID') return FAKE_GOOGLE_CLIENT_ID;
  if (/EMAIL/.test(key)) return 'admin@example.test';
  if (/ENCRYPTION_KEY/.test(key)) {
    // Base64 of 32 bytes, because that is what an AES-256 key must decode to.
    return Buffer.alloc(32, 7).toString('base64');
  }
  if (/SECRET|PASSWORD|TOKEN/.test(key)) {
    // Comfortably past the 32-character minimum the signing secrets require,
    // and recognisably not a real credential.
    return `fake-vps-${key.toLowerCase()}-0123456789abcdef`;
  }
  if (/PORT/.test(key)) return '3000';
  if (/URL/.test(key)) return 'http://localhost:3535';
  if (/HOST/.test(key)) return 'localhost';
  return `fake-${key.toLowerCase().replace(/_/g, '-')}`;
}

/** A well-formed, obviously fake Google OAuth client id. */
export const FAKE_GOOGLE_CLIENT_ID = '000000000000-fakevps0000000000.apps.googleusercontent.com';

/** The domain the harness installs under, and the callback derived from it. */
export const FAKE_DOMAIN = 'app.example.test';
export const FAKE_GOOGLE_CALLBACK_URL = `https://${FAKE_DOMAIN}/api/auth/google/callback`;

/**
 * A `fetch` that answers Google's token endpoint the way it answers VALID
 * credentials and an invalid code -- `invalid_grant` (#391) -- and passes every
 * other request through to the real `fetch`, so the health gate still probes
 * the real `serveHealth` server.
 *
 * ⚠ Nothing in a test ever reaches Google. `oauthAnswer` makes the other
 * outcomes (`invalid_client`, a network failure) drivable.
 */
export function fakeGoogleFetch(
  oauthAnswer: { status?: number; error?: string; throws?: Error } = { status: 400, error: 'invalid_grant' },
): { fetch: typeof globalThis.fetch; tokenRequests: URLSearchParams[] } {
  const tokenRequests: URLSearchParams[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://oauth2.googleapis.com/')) {
      tokenRequests.push(new URLSearchParams(String(init?.body ?? '')));
      if (oauthAnswer.throws !== undefined) throw oauthAnswer.throws;
      return new Response(JSON.stringify({ error: oauthAnswer.error ?? 'invalid_grant' }), {
        status: oauthAnswer.status ?? 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return await globalThis.fetch(input, init);
  };
  return { fetch, tokenRequests };
}

/**
 * A socket that accepts connections and does nothing else.
 *
 * ⚠ THE DATABASE REACHABILITY CHECK IS A REAL TCP CONNECT, not a subprocess,
 * so no route can answer it. Faking it would mean stubbing the check registry
 * -- mocking at the edge again, which is the thing this harness exists to stop
 * doing. Standing up a listener instead lets `database-reachable` run its real
 * probe against a real socket and genuinely pass; everything after it
 * (credentials, the database, the extension) goes through `psql` in a
 * container, which IS a subprocess and IS routable.
 */
export async function listenForProbe(): Promise<{ port: number; close(): Promise<void> }> {
  const { createServer } = await import('node:net');
  const server = createServer((socket) => socket.end());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake-vps: the probe listener did not report a port');
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * An HTTP server answering the three endpoints the health gate probes.
 *
 * ⚠ SAME ARGUMENT AS `listenForProbe`: the health gate uses `fetch`, not a
 * subprocess, so a route cannot answer it. Standing up a real server means the
 * REAL gate runs -- including its rule that `/api/health/ready` returning 200
 * is not on its own enough, because the frontend fails independently of the
 * API and gets its own probe.
 *
 * `ready` is settable so a test can drive the gate's failure path, which is
 * the whole reason this is a server and not a constant.
 */
export interface FakeApi {
  port: number;
  /** Flip to make `/api/health/ready` answer 503, as an unmigrated API would. */
  setReady(ready: boolean): void;
  /**
   * What the fake sign-in routes answer (#391's OAuth smoke): the client id
   * and callback `/api/auth/google` redirects with, or `undefined` for an API
   * that lists no Google provider at all.
   */
  setOAuth(oauth: { clientId: string; callbackUrl: string } | undefined): void;
  close(): Promise<void>;
}

export async function serveHealth(): Promise<FakeApi> {
  const { createServer } = await import('node:http');
  let ready = true;
  let oauth: { clientId: string; callbackUrl: string } | undefined = {
    clientId: FAKE_GOOGLE_CLIENT_ID,
    callbackUrl: FAKE_GOOGLE_CALLBACK_URL,
  };

  const server = createServer((request, response) => {
    const path = request.url ?? '/';

    if (path.startsWith('/api/auth/providers')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ data: { providers: oauth === undefined ? [] : [{ name: 'google', enabled: true }] } }),
      );
      return;
    }

    if (path.startsWith('/api/auth/google')) {
      if (oauth === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 'NOT_FOUND' }));
        return;
      }
      const location = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      location.searchParams.set('response_type', 'code');
      location.searchParams.set('client_id', oauth.clientId);
      location.searchParams.set('redirect_uri', oauth.callbackUrl);
      response.writeHead(302, { location: location.href });
      response.end();
      return;
    }

    if (path.startsWith('/api/health/ready') && !ready) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'error' }));
      return;
    }

    if (path.startsWith('/api/health/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // The frontend probe. Any 200 with a body is what it looks for.
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>fake</title>');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake-vps: the health server did not report a port');
  }

  return {
    port: address.port,
    setReady(value: boolean) {
      ready = value;
    },
    setOAuth(value) {
      oauth = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
