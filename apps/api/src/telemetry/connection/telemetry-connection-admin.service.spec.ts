import { BadRequestException, ConflictException } from '@nestjs/common';

import { diffConnectionFieldNames, TelemetryConnectionAdminService, toResponse } from './telemetry-connection-admin.service';
import type { UpdateTelemetryConnectionInput } from './dto/telemetry-connection.dto';
import { TELEMETRY_CONNECTION_SETTINGS_KEY, TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE } from './telemetry-connection.schema';
import { TELEMETRY_RETENTION_TYPE } from '../handlers/telemetry-retention.handler';

// =============================================================================
// TelemetryConnectionAdminService — tests (issue #558, epic #528)
// =============================================================================
//
// What breaks a deployment quietly if it regresses:
//
//   1. VALIDATION — host/port/database identifier, and the 400s that guard
//      "no password to keep" and "admin user with no admin password".
//   2. BLANK PRESERVES — an omitted/blank password never wipes a stored one.
//   3. `adminUser: null` DELETES the admin credential.
//   4. If-Match 409 on PUT and DELETE, checked BEFORE anything is written.
//   5. THE AUDIT ROW NAMES FIELDS, NEVER VALUES — no password ever appears in
//      it, or anywhere in the response.
//   6. SIDE EFFECTS: refresh (so this instance and `GreptimeClient` see the new
//      connection immediately), `refreshGate()`, and the retention job queued.
//   7. DELETE removes the row and BOTH credentials.
// =============================================================================

const ROW = {
  version: 5,
  updatedAt: new Date('2026-03-03T00:00:00.000Z'),
  updatedByUser: { id: 'admin-1', email: 'admin@example.com' },
};

const STORED_VALUE = {
  host: 'old-host',
  pgPort: 4003,
  database: 'public',
  readerUser: 'old-reader',
  adminUser: 'old-admin',
};

const READER_INFO = {
  purpose: TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE,
  name: 'reader',
  hint: '••••1234',
  label: 'GreptimeDB read-only login (telemetry explorer, status)',
  updatedByUserId: 'admin-1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-02-02T00:00:00.000Z'),
};

const ADMIN_INFO = { ...READER_INFO, name: 'admin', updatedAt: new Date('2026-02-03T00:00:00.000Z') };

const DEPLOYMENT = {
  host: 'deploy-host',
  pgPort: 4003,
  database: 'public',
  readerUser: 'env-reader',
  adminUser: 'env-admin',
  readerConfigured: true,
  adminConfigured: true,
};

function input(overrides: Partial<UpdateTelemetryConnectionInput> = {}): UpdateTelemetryConnectionInput {
  return {
    host: 'new-host',
    pgPort: 4003,
    database: 'public',
    readerUser: 'new-reader',
    readerPassword: undefined,
    adminUser: 'new-admin',
    adminPassword: undefined,
    ...overrides,
  };
}

describe('TelemetryConnectionAdminService', () => {
  let service: TelemetryConnectionAdminService;
  let prisma: any;
  let credentials: {
    setSecret: jest.Mock;
    deleteSecret: jest.Mock;
  };
  let connection: {
    refresh: jest.Mock;
    isConfigured: jest.Mock;
    isAdminConfigured: jest.Mock;
    deploymentHost: string;
    describeDeployment: jest.Mock;
    configurationProblem: jest.Mock;
  };
  let settings: { refreshGate: jest.Mock };
  let jobs: { enqueue: jest.Mock };

  /** The state `connection.refresh()` reports — stored, with both credentials present. */
  function state(overrides: Partial<{ row: typeof ROW | null; storedRow: boolean; readerInfo: any; adminInfo: any }> = {}) {
    const hasRow = overrides.storedRow ?? true;
    const readerInfo = overrides.readerInfo !== undefined ? overrides.readerInfo : READER_INFO;
    const adminInfo = overrides.adminInfo !== undefined ? overrides.adminInfo : ADMIN_INFO;
    return {
      snapshot: {
        source: hasRow ? 'stored' : 'environment',
        host: hasRow ? STORED_VALUE.host : 'env-host',
        hostMode: hasRow ? 'custom' : 'auto',
        deploymentManaged: !hasRow,
        reader: { user: STORED_VALUE.readerUser, passwordSet: readerInfo !== null, version: readerInfo?.updatedAt.toISOString() ?? null },
        admin: hasRow && STORED_VALUE.adminUser
          ? { user: STORED_VALUE.adminUser, passwordSet: adminInfo !== null, version: adminInfo?.updatedAt.toISOString() ?? null }
          : null,
      },
      stored: hasRow ? STORED_VALUE : null,
      row: overrides.row !== undefined ? overrides.row : hasRow ? ROW : null,
      credentials: {
        reader: readerInfo,
        admin: adminInfo,
      },
    };
  }

  beforeEach(() => {
    prisma = {
      systemSettings: { upsert: jest.fn().mockResolvedValue({}), deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
      job: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    credentials = {
      setSecret: jest.fn().mockResolvedValue(undefined),
      deleteSecret: jest.fn().mockResolvedValue(undefined),
    };

    connection = {
      refresh: jest.fn().mockResolvedValue(state()),
      isConfigured: jest.fn().mockReturnValue(true),
      isAdminConfigured: jest.fn().mockReturnValue(true),
      deploymentHost: 'deploy-host',
      describeDeployment: jest.fn().mockReturnValue(DEPLOYMENT),
      configurationProblem: jest.fn().mockReturnValue(null),
    };

    settings = { refreshGate: jest.fn().mockResolvedValue(true) };
    jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    service = new TelemetryConnectionAdminService(
      prisma as never,
      credentials as never,
      connection as never,
      settings as never,
      jobs as never,
    );
  });

  // ==========================================================================
  // Validation (schema-level, exercised through the value objects the DTO produces)
  // ==========================================================================

  describe('validation', () => {
    it('400s a PUT with no stored reader password and none supplied', async () => {
      connection.refresh.mockResolvedValue(state({ readerInfo: null }));

      await expect(service.replace(input({ readerPassword: undefined }), 'admin-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.systemSettings.upsert).not.toHaveBeenCalled();
      expect(credentials.setSecret).not.toHaveBeenCalled();
    });

    it('400s a PUT with an adminUser set but no stored admin password and none supplied', async () => {
      connection.refresh.mockResolvedValue(state({ adminInfo: null }));

      await expect(
        service.replace(input({ adminUser: 'new-admin', adminPassword: undefined }), 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.systemSettings.upsert).not.toHaveBeenCalled();
    });

    it('accepts a PUT with adminUser null and no admin password at all', async () => {
      connection.refresh.mockResolvedValue(state({ adminInfo: null }));

      await service.replace(
        input({ readerPassword: 'reader-pw', adminUser: null, adminPassword: undefined }),
        'admin-1',
      );

      expect(prisma.systemSettings.upsert).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Automatic host (issue #562)
  // ==========================================================================

  describe('automatic host (issues #562, #570)', () => {
    it('stores the automatic marker only — never the resolved deployment host, users, port or database', async () => {
      await service.replace(input({ host: null }), 'admin-1');

      const call = prisma.systemSettings.upsert.mock.calls[0][0];
      expect(call.update.value).toEqual({ host: null });
      expect(call.create.value).toEqual({ host: null });
      expect(JSON.stringify(call)).not.toContain('deploy-host');
      expect(JSON.stringify(call)).not.toContain('new-reader');
    });

    it('accepts and ignores submitted credentials: nothing is written to the credential store', async () => {
      await service.replace(
        input({ host: null, readerPassword: 'guessed-reader-pw', adminPassword: 'guessed-admin-pw' }),
        'admin-1',
      );

      expect(credentials.setSecret).not.toHaveBeenCalled();
      const data = prisma.auditEvent.create.mock.calls[0][0].data;
      expect(data.meta.ignoredFields).toEqual(['readerUser', 'readerPassword', 'adminUser', 'adminPassword']);
      expect(JSON.stringify(data)).not.toContain('guessed-reader-pw');
      expect(JSON.stringify(data)).not.toContain('guessed-admin-pw');
    });

    it('clears both stored passwords so no stale secret lingers, and audits it', async () => {
      await service.replace(input({ host: null }), 'admin-1');

      expect(credentials.deleteSecret).toHaveBeenCalledWith(TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE, 'reader');
      expect(credentials.deleteSecret).toHaveBeenCalledWith(TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE, 'admin');
      const meta = prisma.auditEvent.create.mock.calls[0][0].data.meta;
      expect(meta.credentials).toEqual({ reader: 'cleared', admin: 'cleared' });
      expect(meta.hostMode).toBe('auto');
    });

    it('never 400s for a missing password, and deletes only what was stored', async () => {
      connection.refresh.mockResolvedValue(state({ readerInfo: null, adminInfo: null }));

      await expect(
        service.replace(input({ host: null, readerUser: undefined, adminUser: undefined }), 'admin-1'),
      ).resolves.toBeDefined();

      expect(credentials.deleteSecret).not.toHaveBeenCalled();
      expect(prisma.systemSettings.upsert).toHaveBeenCalled();
      expect(prisma.auditEvent.create.mock.calls[0][0].data.meta).not.toHaveProperty('ignoredFields');
    });

    it('stores a custom host as the literal it is, with its logins', async () => {
      await service.replace(input({ host: 'custom-host' }), 'admin-1');

      expect(prisma.systemSettings.upsert.mock.calls[0][0].update.value).toEqual({
        host: 'custom-host',
        pgPort: 4003,
        database: 'public',
        readerUser: 'new-reader',
        adminUser: 'new-admin',
      });
      expect(prisma.auditEvent.create.mock.calls[0][0].data.meta.hostMode).toBe('custom');
    });

    it('audits a switch from a custom host to automatic as every stored field changing', async () => {
      await service.replace(input({ host: null, readerUser: 'old-reader', adminUser: 'old-admin' }), 'admin-1');

      expect(prisma.auditEvent.create.mock.calls[0][0].data.meta.changedFields).toEqual([
        'host',
        'pgPort',
        'database',
        'readerUser',
        'adminUser',
      ]);
    });
  });

  // ==========================================================================
  // Blank preserves
  // ==========================================================================

  describe('blank password preserves', () => {
    it.each([
      ['omitted', undefined],
      ['the empty string', ''],
    ] as Array<[string, string | undefined]>)('%s leaves the stored reader password alone', async (_label, readerPassword) => {
      await service.replace(input({ readerPassword }), 'admin-1');

      expect(credentials.setSecret).not.toHaveBeenCalledWith(
        TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE,
        'reader',
        expect.anything(),
        expect.anything(),
      );
    });

    it('a non-blank reader password rotates the credential', async () => {
      await service.replace(input({ readerPassword: 'brand-new-secret' }), 'admin-1');

      expect(credentials.setSecret).toHaveBeenCalledWith(
        TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE,
        'reader',
        'brand-new-secret',
        expect.objectContaining({ updatedByUserId: 'admin-1' }),
      );
    });
  });

  // ==========================================================================
  // adminUser: null deletes the admin credential
  // ==========================================================================

  describe('adminUser: null', () => {
    it('deletes the stored admin credential', async () => {
      await service.replace(input({ adminUser: null, adminPassword: undefined }), 'admin-1');

      expect(credentials.deleteSecret).toHaveBeenCalledWith(TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE, 'admin');
    });

    it('does not try to delete an admin credential that was never stored', async () => {
      connection.refresh.mockResolvedValue(state({ adminInfo: null }));

      await service.replace(input({ adminUser: null, adminPassword: undefined }), 'admin-1');

      expect(credentials.deleteSecret).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // If-Match
  // ==========================================================================

  describe('optimistic concurrency', () => {
    it('PUT 409s on a stale If-Match, before anything is written', async () => {
      await expect(service.replace(input(), 'admin-1', 99)).rejects.toThrow(ConflictException);
      expect(prisma.systemSettings.upsert).not.toHaveBeenCalled();
      expect(credentials.setSecret).not.toHaveBeenCalled();
    });

    it('PUT accepts a matching If-Match', async () => {
      await service.replace(input(), 'admin-1', ROW.version);
      expect(prisma.systemSettings.upsert).toHaveBeenCalled();
    });

    it('DELETE 409s on a stale If-Match, before anything is deleted', async () => {
      await expect(service.reset('admin-1', 99)).rejects.toThrow(ConflictException);
      expect(prisma.systemSettings.deleteMany).not.toHaveBeenCalled();
      expect(credentials.deleteSecret).not.toHaveBeenCalled();
    });

    it('DELETE accepts a matching If-Match', async () => {
      await service.reset('admin-1', ROW.version);
      expect(prisma.systemSettings.deleteMany).toHaveBeenCalled();
    });

    it('treats an absent expectedVersion as unconditional, using 0 when nothing is stored', async () => {
      connection.refresh.mockResolvedValue(state({ storedRow: false, row: null }));

      await expect(service.reset('admin-1', 0)).resolves.toBeDefined();
    });
  });

  // ==========================================================================
  // Auditing — field NAMES only, never values
  // ==========================================================================

  describe('auditing', () => {
    it('records changed field NAMES and credential changes, never a password', async () => {
      await service.replace(
        input({ host: 'new-host', readerPassword: 'super-secret-reader-pw', adminPassword: 'super-secret-admin-pw' }),
        'admin-1',
      );

      expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1);
      const data = prisma.auditEvent.create.mock.calls[0][0].data;

      expect(data.action).toBe('telemetry:connection_update');
      expect(data.actorUserId).toBe('admin-1');
      expect(data.targetType).toBe('system_settings');
      expect(data.targetId).toBe(TELEMETRY_CONNECTION_SETTINGS_KEY);
      expect(data.meta.changedFields).toEqual(expect.arrayContaining(['host']));
      expect(data.meta.credentials).toEqual({ reader: 'set', admin: 'set' });

      // ⚠ The assertion that matters: no password string appears anywhere in
      // the audit row, or in the response returned to the caller.
      expect(JSON.stringify(data)).not.toContain('super-secret-reader-pw');
      expect(JSON.stringify(data)).not.toContain('super-secret-admin-pw');
    });

    it('a DELETE also audits without any password, and names the previous/next source', async () => {
      await service.reset('admin-1');

      const data = prisma.auditEvent.create.mock.calls[0][0].data;
      expect(data.action).toBe('telemetry:connection_reset');
      expect(data.meta.credentialsCleared).toEqual(expect.arrayContaining(['reader', 'admin']));
    });
  });

  // ==========================================================================
  // Response never contains a password
  // ==========================================================================

  describe('the response', () => {
    it('never contains a password, however it got in via the credential change tracking', async () => {
      const result = await service.replace(
        input({ readerPassword: 'response-must-not-contain-this', adminPassword: 'nor-this-one-either' }),
        'admin-1',
      );

      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain('response-must-not-contain-this');
      expect(serialised).not.toContain('nor-this-one-either');
      expect(result).not.toHaveProperty('readerPassword');
      expect(result).not.toHaveProperty('adminPassword');
    });
  });

  // ==========================================================================
  // Side effects
  // ==========================================================================

  describe('side effects', () => {
    it('refreshes the connection on this instance, calls refreshGate, and enqueues the retention job — on PUT', async () => {
      await service.replace(input(), 'admin-1');

      // Once before the write (to check If-Match) and once after (to pick up
      // the new snapshot before anything else touches it).
      expect(connection.refresh).toHaveBeenCalledTimes(2);
      expect(settings.refreshGate).toHaveBeenCalledTimes(1);
      expect(jobs.enqueue).toHaveBeenCalledTimes(1);
      expect(jobs.enqueue.mock.calls[0][0]).toMatchObject({ type: TELEMETRY_RETENTION_TYPE });
    });

    it('does the same side effects on DELETE', async () => {
      await service.reset('admin-1');

      expect(settings.refreshGate).toHaveBeenCalledTimes(1);
      expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    });

    it('does not enqueue a duplicate retention job when one is already active', async () => {
      prisma.job.findFirst.mockResolvedValue({ id: 'already-active' });

      await service.replace(input(), 'admin-1');

      expect(jobs.enqueue).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // DELETE removes the row AND both credentials
  // ==========================================================================

  describe('reset', () => {
    it('removes the stored row and both credentials', async () => {
      await service.reset('admin-1');

      expect(prisma.systemSettings.deleteMany).toHaveBeenCalledWith({
        where: { key: TELEMETRY_CONNECTION_SETTINGS_KEY },
      });
      expect(credentials.deleteSecret).toHaveBeenCalledWith(TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE, 'reader');
      expect(credentials.deleteSecret).toHaveBeenCalledWith(TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE, 'admin');
    });

    it('only clears the credentials that were actually stored', async () => {
      connection.refresh.mockResolvedValue(state({ adminInfo: null }));

      await service.reset('admin-1');

      expect(credentials.deleteSecret).toHaveBeenCalledWith(TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE, 'reader');
      expect(credentials.deleteSecret).not.toHaveBeenCalledWith(TELEMETRY_GREPTIME_CREDENTIAL_PURPOSE, 'admin');
    });
  });

  // ==========================================================================
  // Helper functions exported for the controller/response mapping
  // ==========================================================================

  describe('diffConnectionFieldNames', () => {
    it('reports every field when nothing was stored before', () => {
      expect(diffConnectionFieldNames(null, { ...STORED_VALUE })).toEqual([
        'host',
        'pgPort',
        'database',
        'readerUser',
        'adminUser',
      ]);
    });

    it('reports only the fields that differ', () => {
      expect(
        diffConnectionFieldNames(STORED_VALUE, { ...STORED_VALUE, host: 'changed-host' }),
      ).toEqual(['host']);
    });

    it('counts a host moving between automatic (null) and a literal as a change, both ways', () => {
      const automatic = { host: null };
      const all = ['host', 'pgPort', 'database', 'readerUser', 'adminUser'];

      expect(diffConnectionFieldNames(STORED_VALUE, automatic)).toEqual(all);
      expect(diffConnectionFieldNames(automatic, STORED_VALUE)).toEqual(all);
      expect(diffConnectionFieldNames(automatic, { host: null })).toEqual([]);
      expect(diffConnectionFieldNames(null, automatic)).toEqual(['host']);
    });

    it('reports nothing when nothing changed', () => {
      expect(diffConnectionFieldNames(STORED_VALUE, { ...STORED_VALUE })).toEqual([]);
    });
  });

  describe('toResponse', () => {
    it('never exposes a password, and reports configured/adminConfigured from the service', () => {
      const result = toResponse(state() as never, {
        isConfigured: () => true,
        isAdminConfigured: () => false,
        deploymentHost: 'deploy-host',
        describeDeployment: () => DEPLOYMENT,
        configurationProblem: () => null,
      });

      expect(result.configured).toBe(true);
      expect(result.adminConfigured).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/password/i);
    });

    const connectionView = {
      isConfigured: () => true,
      isAdminConfigured: () => true,
      deploymentHost: 'deploy-host',
      describeDeployment: () => DEPLOYMENT,
      configurationProblem: (): string | null => null,
    };

    it('a custom stored host: host is the literal, hostMode custom, effectiveHost the same literal', () => {
      const result = toResponse(state() as never, connectionView);

      expect(result).toMatchObject({
        host: 'old-host',
        hostMode: 'custom',
        effectiveHost: 'old-host',
        deploymentManaged: false,
        credentials: { reader: { configured: true, hint: '••••1234' } },
      });
    });

    it('an automatic stored host: deployment-managed, and a stale stored password is not described', () => {
      const base = state();
      const automatic = {
        ...base,
        stored: { host: null },
        snapshot: {
          ...base.snapshot,
          host: 'deploy-host',
          hostMode: 'auto',
          deploymentManaged: true,
          reader: { user: 'env-reader', passwordSet: true, version: 'environment' },
          admin: { user: 'env-admin', passwordSet: false, version: null },
        },
      };

      const result = toResponse(automatic as never, connectionView);

      expect(result).toMatchObject({
        source: 'stored',
        host: null,
        hostMode: 'auto',
        effectiveHost: 'deploy-host',
        deploymentManaged: true,
        deployment: DEPLOYMENT,
        readerUser: 'env-reader',
        // From the deployment, never the credential store's (stale) hint.
        credentials: {
          reader: { configured: true, hint: null, updatedAt: null },
          admin: { configured: false, hint: null },
        },
      });
    });

    it('the environment source is the deployment: automatic and deployment-managed', () => {
      const result = toResponse(state({ storedRow: false, row: null }) as never, connectionView);

      expect(result).toMatchObject({
        source: 'environment',
        host: null,
        hostMode: 'auto',
        effectiveHost: 'env-host',
        deploymentManaged: true,
        problem: null,
      });
    });

    it('reports the deployment\'s gaps as `problem`, and whether it provisions each login', () => {
      const missing = { ...DEPLOYMENT, readerConfigured: false };
      const problem = 'The GreptimeDB deployed with this application has no reader login configured.';

      const result = toResponse(state({ storedRow: false, row: null }) as never, {
        ...connectionView,
        describeDeployment: () => missing,
        configurationProblem: () => problem,
      });

      expect(result.problem).toBe(problem);
      expect(result.deployment).toEqual(missing);
      expect(JSON.stringify(result)).not.toMatch(/password/i);
    });

    it('source none: host null, hostMode auto, effectiveHost the deployment host an automatic host would use', () => {
      const none = {
        snapshot: {
          source: 'none',
          host: '',
          hostMode: 'auto',
          deploymentManaged: false,
          pgPort: 4003,
          database: 'public',
          reader: { user: '', passwordSet: false, version: null },
          admin: null,
        },
        stored: null,
        row: null,
        credentials: { reader: null, admin: null },
      };

      const result = toResponse(none as never, { ...connectionView, isConfigured: () => false });

      expect(result).toMatchObject({
        source: 'none',
        host: null,
        hostMode: 'auto',
        effectiveHost: 'deploy-host',
        deploymentManaged: false,
      });
    });
  });
});
