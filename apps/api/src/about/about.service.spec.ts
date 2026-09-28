// =============================================================================
// Unit tests for AboutService (issue #401, epic #397)
// =============================================================================
//
// What this file is responsible for: the ASSEMBLY rules — that three
// independent facts are gathered inside three independent failure boundaries,
// and that a failure in any one of them becomes a field rather than an
// exception. `deploy-info.spec.ts` owns the document parsing; the guard stack is
// `test/about/about.integration.spec.ts`'s job and CANNOT be proven here, for
// the reason that file's header gives.
//
// The health indicator is substituted because the real one runs `SELECT 1`
// through Prisma, and the interesting case is the one where that FAILS — which
// a real indicator against a real database will not do on demand.
// =============================================================================

import { readFileSync } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { AboutService } from './about.service';
import { aboutResponseSchema } from './dto/about-response.dto';
import type { DatabaseHealthIndicator } from '../health/indicators/database.indicator';

const GOOD_DOCUMENT = {
  schema: 1,
  app: { name: 'EnterpriseAppBase', version: '1.4.0', commitSha: 'abc123', ref: 'main' },
  installedAt: '2026-01-04T09:00:00.000Z',
  updatedAt: '2026-09-12T18:30:00.000Z',
  deployedBy: { cli: 'appctl', version: '1.4.0' },
  domain: 'app.example.com',
  remote: { commitsBehind: 3, checkedAt: '2026-09-14T06:00:00.000Z' },
  run: { completed: ['pull', 'migrate', 'up'], outcome: 'success' },
};

describe('AboutService', () => {
  let dir: string;
  let path: string;
  let service: AboutService;
  let isHealthy: jest.Mock;

  const originalPath = process.env.DEPLOY_INFO_PATH;
  const originalVersion = process.env.APP_VERSION;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'about-service-'));
    path = join(dir, 'info.json');
    process.env.DEPLOY_INFO_PATH = path;
    process.env.APP_VERSION = '9.9.9';

    isHealthy = jest.fn().mockResolvedValue({
      database: { status: 'up', responseTime: '3ms' },
    });

    service = new AboutService({
      isHealthy,
    } as unknown as DatabaseHealthIndicator);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });

    if (originalPath === undefined) delete process.env.DEPLOY_INFO_PATH;
    else process.env.DEPLOY_INFO_PATH = originalPath;

    if (originalVersion === undefined) delete process.env.APP_VERSION;
    else process.env.APP_VERSION = originalVersion;
  });

  const write = (value: unknown) => writeFile(path, JSON.stringify(value), 'utf8');

  // ---------------------------------------------------------------------------
  // The API's own version — the one fact that never depends on anything
  // ---------------------------------------------------------------------------

  it('reports the API version resolved by openapi/version.ts', async () => {
    const report = await service.describe();

    expect(report.api.version).toBe('9.9.9');
  });

  it('still reports the API version with no document and no database', async () => {
    isHealthy.mockRejectedValue(new Error('down'));

    const report = await service.describe();

    expect(report.api.version).toBe('9.9.9');
    expect(report.deployInfoStatus).toBe('absent');
    expect(report.database).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // State 1 — ok
  // ---------------------------------------------------------------------------

  describe('state: ok', () => {
    it('surfaces every field of a complete, successful document', async () => {
      await write(GOOD_DOCUMENT);

      const report = await service.describe();

      expect(report.deployInfoStatus).toBe('ok');
      expect(report.deployInfoError).toBeNull();
      expect(report.deployInfoPath).toBe(path);
      expect(report.app).toEqual(GOOD_DOCUMENT.app);
      expect(report.installedAt).toBe(GOOD_DOCUMENT.installedAt);
      expect(report.updatedAt).toBe(GOOD_DOCUMENT.updatedAt);
      expect(report.deployedBy).toEqual(GOOD_DOCUMENT.deployedBy);
      expect(report.domain).toBe('app.example.com');
      expect(report.run?.outcome).toBe('success');
    });

    it('copies remote from the document without refreshing it', async () => {
      // ⚠ No network I/O anywhere in this endpoint. `commitsBehind` is as old as
      // `checkedAt` says, and the two always travel together for that reason.
      await write(GOOD_DOCUMENT);

      expect((await service.describe()).remote).toEqual(GOOD_DOCUMENT.remote);
    });
  });

  // ---------------------------------------------------------------------------
  // State 2 — absent (today: everywhere)
  // ---------------------------------------------------------------------------

  describe('state: absent', () => {
    it('answers absent with every document field null, and does not throw', async () => {
      const report = await service.describe();

      expect(report.deployInfoStatus).toBe('absent');
      expect(report.deployInfoError).toBeNull();
      expect(report.app).toBeNull();
      expect(report.installedAt).toBeNull();
      expect(report.updatedAt).toBeNull();
      expect(report.deployedBy).toBeNull();
      expect(report.domain).toBeNull();
      expect(report.remote).toBeNull();
      expect(report.run).toBeNull();
    });

    it('reports the path it looked at and asserts nothing beyond that', async () => {
      // ⚠ The absent answer must NOT mean "this was not deployed with the CLI".
      // That claim is false for a mis-set path, an unattached bind mount, or a
      // run that stopped early. The path is the fact that distinguishes them,
      // and the wording is the client's to choose.
      const report = await service.describe();

      expect(report.deployInfoPath).toBe(path);

      const body = JSON.stringify(report).toLowerCase();
      expect(body).not.toContain('not deployed');
      expect(body).not.toContain('was not installed');
    });

    it('never substitutes the current time for a timestamp no disk carries', async () => {
      const report = await service.describe();

      expect(report.installedAt).toBeNull();
      expect(report.updatedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // State 3 — the one people forget: complete document, FAILED run
  // ---------------------------------------------------------------------------

  describe('state: complete document describing a failed run', () => {
    const FAILED = {
      ...GOOD_DOCUMENT,
      run: { completed: ['pull', 'migrate'], failedStep: 'up', outcome: 'failure' },
    };

    it('is ok, not invalid, and not an error', async () => {
      await write(FAILED);

      const report = await service.describe();

      expect(report.deployInfoStatus).toBe('ok');
      expect(report.deployInfoError).toBeNull();
    });

    it('surfaces the failure as a distinct, explicit part of the response', async () => {
      await write(FAILED);

      const report = await service.describe();

      expect(report.run).toEqual({
        completed: ['pull', 'migrate'],
        failedStep: 'up',
        outcome: 'failure',
      });
    });

    it('still reports EVERY other fact it has', async () => {
      // A run that got far enough to write this file deployed something: there
      // is a commit on that box and steps that really ran. Reporting the failure
      // by withholding those facts would be the bug.
      await write(FAILED);

      const report = await service.describe();

      expect(report.app).toEqual(GOOD_DOCUMENT.app);
      expect(report.domain).toBe('app.example.com');
      expect(report.deployedBy).toEqual(GOOD_DOCUMENT.deployedBy);
      expect(report.remote).toEqual(GOOD_DOCUMENT.remote);
      expect(report.run?.completed).toEqual(['pull', 'migrate']);
    });
  });

  // ---------------------------------------------------------------------------
  // invalid
  // ---------------------------------------------------------------------------

  describe('state: invalid', () => {
    it('reports schema 2 as invalid with a reason, and still reports the API version', async () => {
      await write({ ...GOOD_DOCUMENT, schema: 2 });

      const report = await service.describe();

      expect(report.deployInfoStatus).toBe('invalid');
      expect(report.deployInfoError).toBeTruthy();
      expect(report.app).toBeNull();
      expect(report.api.version).toBe('9.9.9');
    });

    it('reports malformed JSON as invalid', async () => {
      await writeFile(path, '{ not json', 'utf8');

      expect((await service.describe()).deployInfoStatus).toBe('invalid');
    });
  });

  // ---------------------------------------------------------------------------
  // The database is a fact of its own, and its failure is a field
  // ---------------------------------------------------------------------------

  describe('database probe', () => {
    it('reports the indicator result when the database answers', async () => {
      const report = await service.describe();

      expect(report.database).toEqual({ status: 'up', responseTime: '3ms' });
      expect(report.databaseError).toBeNull();
      expect(isHealthy).toHaveBeenCalledWith('database');
    });

    it('reports database: null plus databaseError when the probe throws', async () => {
      // ⚠ Never a 503. The indicator throws by design — that is right for
      // Terminus and wrong here.
      isHealthy.mockRejectedValue(new Error("Can't reach database server"));

      const report = await service.describe();

      expect(report.database).toBeNull();
      expect(report.databaseError).toBe("Can't reach database server");
    });

    it('reports the underlying cause, not the indicator\'s generic wrapper message', async () => {
      // ⚠ `HealthCheckError.message` is the constant `'Database check failed'`.
      // Reporting that would tell an operator only what they already know; the
      // diagnosis they came for is in `causes`.
      const wrapped = Object.assign(new Error('Database check failed'), {
        causes: { database: { status: 'down', message: "Can't reach database server" } },
      });
      isHealthy.mockRejectedValue(wrapped);

      const report = await service.describe();

      expect(report.database).toBeNull();
      expect(report.databaseError).toBe("Can't reach database server");
    });

    it('falls back to the wrapper message when no cause carries one', async () => {
      const wrapped = Object.assign(new Error('Database check failed'), {
        causes: { database: { status: 'down' } },
      });
      isHealthy.mockRejectedValue(wrapped);

      expect((await service.describe()).databaseError).toBe('Database check failed');
    });

    it('still reports the whole deploy document when the database is down', async () => {
      await write(GOOD_DOCUMENT);
      isHealthy.mockRejectedValue(new Error('down'));

      const report = await service.describe();

      expect(report.deployInfoStatus).toBe('ok');
      expect(report.app).toEqual(GOOD_DOCUMENT.app);
      expect(report.database).toBeNull();
    });

    it('degrades a thrown non-Error into a message rather than propagating it', async () => {
      isHealthy.mockRejectedValue('a bare string');

      const report = await service.describe();

      expect(report.database).toBeNull();
      expect(typeof report.databaseError).toBe('string');
    });

    it('never leaks a stack trace into the response', async () => {
      const error = new Error('boom');
      error.stack = 'Error: boom\n    at somewhere/secret.ts:12:3';
      isHealthy.mockRejectedValue(error);

      const report = await service.describe();

      expect(report.databaseError).toBe('boom');
      expect(JSON.stringify(report)).not.toContain('secret.ts');
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #392 — deployment details and the live runtime object
  // ---------------------------------------------------------------------------

  describe('deployment details (issue #392)', () => {
    const SAMPLE = JSON.parse(
      readFileSync(join(__dirname, '../../test/fixtures/deploy-info.sample.json'), 'utf8'),
    );

    it('surfaces every new field of the shared fixture unchanged', async () => {
      await write(SAMPLE);

      const report = await service.describe();

      expect(report.deployInfoStatus).toBe('ok');
      expect(report.lastCommand).toBe(SAMPLE.lastCommand);
      expect(report.bindPort).toBe(SAMPLE.bindPort);
      expect(report.proxy).toEqual(SAMPLE.proxy);
      expect(report.host).toEqual(SAMPLE.host);
      expect(report.history).toEqual(SAMPLE.history);
    });

    it('produces a report that satisfies the response schema, fixture or not', async () => {
      await write(SAMPLE);
      expect(aboutResponseSchema.safeParse(await service.describe()).success).toBe(true);

      await rm(path);
      expect(aboutResponseSchema.safeParse(await service.describe()).success).toBe(true);
    });

    it('nulls invalid sub-fields rather than failing the report', async () => {
      await write({
        ...SAMPLE,
        bindPort: 99999,
        proxy: { ...SAMPLE.proxy, mode: 'sidecar' },
        host: { ...SAMPLE.host, cpus: 'four' },
      });

      const report = await service.describe();

      expect(report.deployInfoStatus).toBe('ok');
      expect(report.bindPort).toBeNull();
      expect(report.proxy?.mode).toBeNull();
      expect(report.proxy?.container).toBe(SAMPLE.proxy.container);
      expect(report.host?.cpus).toBeNull();
      expect(report.host?.hostname).toBe(SAMPLE.host.hostname);
    });

    it('reports history as [] for a document without one, and null with no document', async () => {
      await write(GOOD_DOCUMENT);
      expect((await service.describe()).history).toEqual([]);

      await rm(path);
      const report = await service.describe();
      expect(report.deployInfoStatus).toBe('absent');
      expect(report.history).toBeNull();
      expect(report.lastCommand).toBeNull();
      expect(report.bindPort).toBeNull();
      expect(report.proxy).toBeNull();
      expect(report.host).toBeNull();
    });

    describe('runtime', () => {
      const originalEnv = process.env.NODE_ENV;

      afterEach(() => {
        if (originalEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalEnv;
      });

      it('is present even when the document is absent and the database is down', async () => {
        isHealthy.mockRejectedValue(new Error('down'));

        const { runtime, deployInfoStatus } = await service.describe();

        expect(deployInfoStatus).toBe('absent');
        expect(runtime.nodeVersion).toBe(process.version);
        expect(typeof runtime.processStartedAt).toBe('string');
      });

      it('reports a process start time in the past, stable across calls', async () => {
        const first = (await service.describe()).runtime.processStartedAt;
        const second = (await service.describe()).runtime.processStartedAt;

        expect(new Date(first).toISOString()).toBe(first);
        expect(Date.parse(first)).toBeLessThanOrEqual(Date.now());
        expect(second).toBe(first);
      });

      it('reports NODE_ENV, or null when it is unset', async () => {
        process.env.NODE_ENV = 'production';
        expect((await service.describe()).runtime.environment).toBe('production');

        delete process.env.NODE_ENV;
        expect((await service.describe()).runtime.environment).toBeNull();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Caching
  // ---------------------------------------------------------------------------

  it('re-reads the document on every call, so a rewrite needs no restart', async () => {
    await write(GOOD_DOCUMENT);
    expect((await service.describe()).app?.commitSha).toBe('abc123');

    await write({ ...GOOD_DOCUMENT, app: { ...GOOD_DOCUMENT.app, commitSha: 'def456' } });

    expect((await service.describe()).app?.commitSha).toBe('def456');
  });

  it('follows a changed DEPLOY_INFO_PATH without a restart', async () => {
    await write(GOOD_DOCUMENT);
    expect((await service.describe()).deployInfoStatus).toBe('ok');

    process.env.DEPLOY_INFO_PATH = join(dir, 'somewhere-else.json');

    const report = await service.describe();
    expect(report.deployInfoStatus).toBe('absent');
    expect(report.deployInfoPath).toBe(join(dir, 'somewhere-else.json'));
  });
});
