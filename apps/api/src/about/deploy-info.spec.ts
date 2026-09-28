// =============================================================================
// Unit tests for the deploy-document reader (issue #401, epic #397)
// =============================================================================
//
// These drive `readDeployInfo` against REAL FILES in a temp directory rather
// than a mocked `fs`. The distinctions this reader has to make are filesystem
// distinctions — a missing file versus a directory in its place versus a path
// whose parent is a file — and a mock of `readFile` would be a mock of the very
// `ErrnoException.code` values under test, which proves only that the test
// author and the implementation agree.
// =============================================================================

import { readFileSync } from 'fs';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  DEFAULT_DEPLOY_INFO_PATH,
  DEPLOY_INFO_HISTORY_LIMIT,
  DEPLOY_INFO_SCHEMA_VERSION,
  readDeployInfo,
  resolveDeployInfoPath,
} from './deploy-info';

/** A complete, successful document, exactly as the CLI will write it. */
const GOOD_DOCUMENT = {
  schema: 1,
  app: {
    name: 'EnterpriseAppBase',
    version: '1.4.0',
    commitSha: '9f1c2b7e4a5d6c8f0e1a2b3c4d5e6f7a8b9c0d1e',
    ref: 'main',
  },
  installedAt: '2026-01-04T09:00:00.000Z',
  updatedAt: '2026-09-12T18:30:00.000Z',
  deployedBy: { cli: 'appctl', version: '1.4.0' },
  domain: 'app.example.com',
  remote: { commitsBehind: 3, checkedAt: '2026-09-14T06:00:00.000Z' },
  run: { completed: ['pull', 'migrate', 'up'], outcome: 'success' },
};

describe('readDeployInfo', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'deploy-info-'));
    path = join(dir, 'info.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (value: unknown) =>
    writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

  // ---------------------------------------------------------------------------
  // absent — the state EVERY environment is in until the CLI half ships
  // ---------------------------------------------------------------------------

  describe('absent', () => {
    it('reports absent for a file that is not there, without throwing', async () => {
      const result = await readDeployInfo(path);

      expect(result.status).toBe('absent');
      expect(result.document).toBeNull();
      expect(result.error).toBeNull();
    });

    it('reports the path it looked at, which is the whole actionable fact', async () => {
      // An absent answer must never assert "this was not deployed with the CLI"
      // — the file may simply be elsewhere. The path is what lets a client say
      // something true instead.
      const result = await readDeployInfo(path);

      expect(result.path).toBe(path);
    });

    it('reports absent when a parent path component is a file (ENOTDIR)', async () => {
      const notADirectory = join(dir, 'a-file');
      await writeFile(notADirectory, 'not a directory', 'utf8');

      const result = await readDeployInfo(join(notADirectory, 'info.json'));

      expect(result.status).toBe('absent');
    });
  });

  // ---------------------------------------------------------------------------
  // invalid — something IS there and could not be used
  // ---------------------------------------------------------------------------

  describe('invalid', () => {
    it('reports invalid for a file that is not JSON', async () => {
      await write('this is not json {{{');

      const result = await readDeployInfo(path);

      expect(result.status).toBe('invalid');
      expect(result.document).toBeNull();
      expect(result.error).toContain('not valid JSON');
    });

    it('reports invalid for JSON that is not an object', async () => {
      await write('[1, 2, 3]');

      expect((await readDeployInfo(path)).status).toBe('invalid');
    });

    it('reports invalid, not absent, when a directory sits where the file should be', async () => {
      // A bind mount that attached a directory. Something is there; telling the
      // operator the file is missing would send them to create one.
      await mkdir(path);

      const result = await readDeployInfo(path);

      expect(result.status).toBe('invalid');
      expect(result.error).toBeTruthy();
    });

    // -------------------------------------------------------------------------
    // ⚠ `schema` IS THE ONE STRICT FIELD
    // -------------------------------------------------------------------------

    it('rejects schema: 2 as invalid', async () => {
      await write({ ...GOOD_DOCUMENT, schema: 2 });

      const result = await readDeployInfo(path);

      expect(result.status).toBe('invalid');
      expect(result.document).toBeNull();
      // The message names both numbers, because the operator's next question is
      // always "which one does this API read?".
      expect(result.error).toContain('2');
      expect(result.error).toContain(String(DEPLOY_INFO_SCHEMA_VERSION));
    });

    it('rejects a missing schema, a string schema and a null schema', async () => {
      const { schema: _dropped, ...withoutSchema } = GOOD_DOCUMENT;

      for (const document of [
        withoutSchema,
        { ...GOOD_DOCUMENT, schema: '1' },
        { ...GOOD_DOCUMENT, schema: null },
      ]) {
        await write(document);
        expect((await readDeployInfo(path)).status).toBe('invalid');
      }
    });

    it('pins the supported version at 1', () => {
      // ⚠ This is not a tautology, it is a tripwire. Bumping the constant makes
      // every already-deployed API answer `invalid` the instant a newer CLI
      // writes its file — see the constant's own comment. Adding an OPTIONAL
      // field needs no bump, which the leniency tests below demonstrate.
      expect(DEPLOY_INFO_SCHEMA_VERSION).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // ok — and everything except `schema` is read leniently
  // ---------------------------------------------------------------------------

  describe('ok', () => {
    it('reads a complete document', async () => {
      await write(GOOD_DOCUMENT);

      const result = await readDeployInfo(path);

      expect(result.status).toBe('ok');
      expect(result.error).toBeNull();
      expect(result.document).toEqual({
        app: GOOD_DOCUMENT.app,
        installedAt: GOOD_DOCUMENT.installedAt,
        updatedAt: GOOD_DOCUMENT.updatedAt,
        deployedBy: GOOD_DOCUMENT.deployedBy,
        domain: GOOD_DOCUMENT.domain,
        remote: GOOD_DOCUMENT.remote,
        run: { completed: ['pull', 'migrate', 'up'], failedStep: null, outcome: 'success' },
        lastCommand: null,
        bindPort: null,
        proxy: null,
        host: null,
        history: [],
      });
    });

    it('stays ok for a document carrying a field this reader has never heard of', async () => {
      // The whole reason the version number must never move for an additive
      // change: the writer is upgraded before the reader, routinely.
      await write({ ...GOOD_DOCUMENT, somethingNewerCliWrites: { nested: true } });

      expect((await readDeployInfo(path)).status).toBe('ok');
    });

    it('reads missing fields as null rather than substituting a plausible value', async () => {
      await write({ schema: 1 });

      const result = await readDeployInfo(path);

      expect(result.status).toBe('ok');
      expect(result.document).toEqual({
        app: { name: null, version: null, commitSha: null, ref: null },
        installedAt: null,
        updatedAt: null,
        deployedBy: null,
        domain: null,
        remote: null,
        run: null,
        lastCommand: null,
        bindPort: null,
        proxy: null,
        host: null,
        history: [],
      });
    });

    it('never invents a timestamp for a document that carries none', async () => {
      // A fabricated `new Date()` would claim this deployment was installed the
      // moment somebody opened the page — false, and unfalsifiable downstream.
      await write({ schema: 1 });

      const { document } = await readDeployInfo(path);

      expect(document?.installedAt).toBeNull();
      expect(document?.updatedAt).toBeNull();
    });

    it('keeps remote null rather than claiming zero commits behind', async () => {
      // `remote: null` means nobody has checked. `commitsBehind: 0` means
      // checked and up to date. Collapsing the first into the second asserts the
      // opposite of what is known.
      await write({ ...GOOD_DOCUMENT, remote: null });

      expect((await readDeployInfo(path)).document?.remote).toBeNull();
    });

    it('reads mistyped fields as null instead of rejecting the document', async () => {
      await write({
        schema: 1,
        app: 'not an object',
        installedAt: 1234567890,
        deployedBy: [],
        domain: false,
        remote: { commitsBehind: 'three', checkedAt: null },
      });

      const result = await readDeployInfo(path);

      expect(result.status).toBe('ok');
      expect(result.document?.app).toEqual({
        name: null,
        version: null,
        commitSha: null,
        ref: null,
      });
      expect(result.document?.installedAt).toBeNull();
      expect(result.document?.deployedBy).toBeNull();
      expect(result.document?.domain).toBeNull();
      expect(result.document?.remote).toEqual({ commitsBehind: null, checkedAt: null });
    });

    it('drops non-string entries from run.completed without failing the read', async () => {
      await write({
        ...GOOD_DOCUMENT,
        run: { completed: ['pull', 7, null, 'up'], outcome: 'success' },
      });

      expect((await readDeployInfo(path)).document?.run?.completed).toEqual(['pull', 'up']);
    });

    it('reads an unrecognised outcome as null rather than as a failure', async () => {
      await write({ ...GOOD_DOCUMENT, run: { completed: [], outcome: 'weird' } });

      const run = (await readDeployInfo(path)).document?.run;

      expect(run?.outcome).toBeNull();
    });

    // -------------------------------------------------------------------------
    // ⚠ THE THIRD STATE
    // -------------------------------------------------------------------------

    it('reads a FAILED run as a complete, ok document', async () => {
      // A run that got far enough to write this file deployed something. The
      // status stays `ok`; the failure is a fact inside the document, not a
      // reason to discard it.
      await write({
        ...GOOD_DOCUMENT,
        run: { completed: ['pull', 'migrate'], failedStep: 'up', outcome: 'failure' },
      });

      const result = await readDeployInfo(path);

      expect(result.status).toBe('ok');
      expect(result.error).toBeNull();
      expect(result.document?.run).toEqual({
        completed: ['pull', 'migrate'],
        failedStep: 'up',
        outcome: 'failure',
      });
      // Every other fact still arrives — that is the point.
      expect(result.document?.app.commitSha).toBe(GOOD_DOCUMENT.app.commitSha);
      expect(result.document?.domain).toBe('app.example.com');
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #392 — additive fields, still schema 1
  // ---------------------------------------------------------------------------

  describe('deployment details (issue #392)', () => {
    /**
     * The shared fixture the CLI's writer test also compares its output to, so
     * the two halves of the contract are pinned against one file.
     */
    const SAMPLE = JSON.parse(
      readFileSync(join(__dirname, '../../test/fixtures/deploy-info.sample.json'), 'utf8'),
    );

    const HISTORY_ENTRY = SAMPLE.history[0];

    it('the shared fixture populates every new field (so the test below means something)', () => {
      for (const key of ['lastCommand', 'bindPort', 'proxy', 'host', 'history']) {
        expect(SAMPLE[key]).not.toBeNull();
        expect(SAMPLE[key]).toBeDefined();
      }
      for (const value of Object.values(SAMPLE.proxy)) expect(value).not.toBeNull();
      for (const value of Object.values(SAMPLE.host)) expect(value).not.toBeNull();
      expect(SAMPLE.history.length).toBeGreaterThan(1);
    });

    it('parses the shared fixture as ok with every field preserved exactly', async () => {
      await write(SAMPLE);

      const result = await readDeployInfo(path);

      expect(result.status).toBe('ok');
      // Deep equality against the fixture itself (minus `schema`, which is the
      // envelope, not a reported field): nothing dropped, nothing renamed,
      // nothing re-serialised.
      const { schema: _schema, ...expected } = SAMPLE;
      expect(result.document).toEqual(expected);
    });

    it('stays schema 1 — the additions needed no version bump', async () => {
      expect(SAMPLE.schema).toBe(DEPLOY_INFO_SCHEMA_VERSION);
    });

    it('reads an invalid lastCommand and bindPort as null', async () => {
      for (const [lastCommand, bindPort] of [
        ['deploy', 0],
        [7, 65536],
        [null, 80.5],
        ['INSTALL', '3535'],
        [{}, -1],
      ]) {
        await write({ ...SAMPLE, lastCommand, bindPort });

        const result = await readDeployInfo(path);
        expect(result.status).toBe('ok');
        expect(result.document?.lastCommand).toBeNull();
        expect(result.document?.bindPort).toBeNull();
      }
    });

    it('accepts both boundary ports', async () => {
      await write({ ...SAMPLE, bindPort: 1 });
      expect((await readDeployInfo(path)).document?.bindPort).toBe(1);

      await write({ ...SAMPLE, bindPort: 65535 });
      expect((await readDeployInfo(path)).document?.bindPort).toBe(65535);
    });

    it('nulls invalid proxy sub-fields individually, keeping the valid ones', async () => {
      await write({
        ...SAMPLE,
        proxy: { mode: 'nginx', container: 42, certificateExpiresAt: 'next tuesday' },
      });

      expect((await readDeployInfo(path)).document?.proxy).toEqual({
        mode: null,
        container: null,
        certificateExpiresAt: null,
      });

      await write({ ...SAMPLE, proxy: { ...SAMPLE.proxy, mode: 'host', container: null } });

      expect((await readDeployInfo(path)).document?.proxy).toEqual({
        mode: 'host',
        container: null,
        certificateExpiresAt: SAMPLE.proxy.certificateExpiresAt,
      });
    });

    it('nulls invalid host sub-fields individually, keeping the valid ones', async () => {
      await write({
        ...SAMPLE,
        host: {
          ...SAMPLE.host,
          kernel: ['6.8'],
          cpus: 0,
          memoryBytes: -5,
          dockerVersion: true,
          capturedAt: 'yesterday-ish',
        },
      });

      const host = (await readDeployInfo(path)).document?.host;

      expect(host).toEqual({
        ...SAMPLE.host,
        kernel: null,
        cpus: null,
        memoryBytes: null,
        dockerVersion: null,
        capturedAt: null,
      });
    });

    it('reads a non-object proxy or host as null', async () => {
      await write({ ...SAMPLE, proxy: 'container', host: [SAMPLE.host] });

      const document = (await readDeployInfo(path)).document;

      expect(document?.proxy).toBeNull();
      expect(document?.host).toBeNull();
    });

    it('drops unknown keys at every level of the new fields', async () => {
      await write({
        ...SAMPLE,
        proxy: { ...SAMPLE.proxy, adminPassword: 'leak' },
        host: { ...SAMPLE.host, env: { SECRET: 'leak' } },
        history: [{ ...HISTORY_ENTRY, token: 'leak' }],
        brandNewTopLevel: 'leak',
      });

      const result = await readDeployInfo(path);

      expect(result.document?.proxy).not.toHaveProperty('adminPassword');
      expect(result.document?.host).not.toHaveProperty('env');
      expect(result.document?.history[0]).not.toHaveProperty('token');
      expect(result.document).not.toHaveProperty('brandNewTopLevel');
      expect(JSON.stringify(result)).not.toContain('leak');
    });

    it('drops history entries missing a valid at, command or success outcome', async () => {
      await write({
        ...SAMPLE,
        history: [
          HISTORY_ENTRY,
          'not an object',
          null,
          { ...HISTORY_ENTRY, at: 'not a date' },
          { ...HISTORY_ENTRY, at: undefined },
          { ...HISTORY_ENTRY, command: 'rollback' },
          { ...HISTORY_ENTRY, outcome: 'failure' },
          { ...HISTORY_ENTRY, outcome: undefined },
          SAMPLE.history[1],
        ],
      });

      const result = await readDeployInfo(path);

      expect(result.status).toBe('ok');
      expect(result.document?.history).toEqual([HISTORY_ENTRY, SAMPLE.history[1]]);
    });

    it('nulls invalid optional sub-fields of a history entry without dropping it', async () => {
      await write({
        ...SAMPLE,
        history: [
          {
            ...HISTORY_ENTRY,
            commitSha: 123,
            previousCommitSha: {},
            ref: false,
            durationMs: -10,
            cliVersion: [],
          },
        ],
      });

      expect((await readDeployInfo(path)).document?.history).toEqual([
        {
          at: HISTORY_ENTRY.at,
          command: HISTORY_ENTRY.command,
          commitSha: null,
          previousCommitSha: null,
          ref: null,
          durationMs: null,
          cliVersion: null,
          outcome: 'success',
        },
      ]);
    });

    it('caps history at 20, keeping the first (newest) valid entries', async () => {
      const entries = Array.from({ length: 30 }, (_, index) => ({
        ...HISTORY_ENTRY,
        commitSha: `sha-${index}`,
      }));
      // Invalid entries at the front must not cost valid ones their place.
      await write({ ...SAMPLE, history: [{ bogus: true }, 'x', ...entries] });

      const history = (await readDeployInfo(path)).document?.history ?? [];

      expect(DEPLOY_INFO_HISTORY_LIMIT).toBe(20);
      expect(history).toHaveLength(20);
      expect(history[0].commitSha).toBe('sha-0');
      expect(history[19].commitSha).toBe('sha-19');
    });

    it('reads a non-array history as an empty list', async () => {
      for (const history of [null, 'none', { 0: HISTORY_ENTRY }, 3]) {
        await write({ ...SAMPLE, history });
        expect((await readDeployInfo(path)).document?.history).toEqual([]);
      }
    });

    it('still reports absent for a missing file', async () => {
      const result = await readDeployInfo(join(dir, 'nope.json'));

      expect(result.status).toBe('absent');
      expect(result.document).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Re-reading — a rewrite must not need a restart
  // ---------------------------------------------------------------------------

  it('sees a rewritten document on the next call, caching nothing', async () => {
    await write(GOOD_DOCUMENT);
    expect((await readDeployInfo(path)).document?.app.commitSha).toBe(
      GOOD_DOCUMENT.app.commitSha,
    );

    // `appctl deploy update` rewrites this file in place against a running
    // container. A cached parse would serve the old SHA for the life of the
    // process, which is exactly the moment the SHA matters.
    await write({ ...GOOD_DOCUMENT, app: { ...GOOD_DOCUMENT.app, commitSha: 'deadbeef' } });

    expect((await readDeployInfo(path)).document?.app.commitSha).toBe('deadbeef');
  });
});

describe('resolveDeployInfoPath', () => {
  it('defaults to the container bind-mount location', () => {
    expect(resolveDeployInfoPath({})).toBe(DEFAULT_DEPLOY_INFO_PATH);
    expect(DEFAULT_DEPLOY_INFO_PATH).toBe('/app/deploy-info/info.json');
  });

  it('honours DEPLOY_INFO_PATH', () => {
    expect(resolveDeployInfoPath({ DEPLOY_INFO_PATH: '/elsewhere/info.json' })).toBe(
      '/elsewhere/info.json',
    );
  });

  it('treats an empty or whitespace-only override as unset', () => {
    expect(resolveDeployInfoPath({ DEPLOY_INFO_PATH: '' })).toBe(DEFAULT_DEPLOY_INFO_PATH);
    expect(resolveDeployInfoPath({ DEPLOY_INFO_PATH: '   ' })).toBe(DEFAULT_DEPLOY_INFO_PATH);
  });
});
