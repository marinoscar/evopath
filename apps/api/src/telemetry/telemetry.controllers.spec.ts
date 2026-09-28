import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { RBAC_EXTENSION_KEY } from '../auth/decorators/auth.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { TelemetryAdminController } from './telemetry-admin.controller';
import { TelemetryConfigController } from './telemetry-config.controller';
import { TelemetryExplorerController } from './telemetry-explorer.controller';
import { TelemetryDashboardController } from './dashboard/telemetry-dashboard.controller';
import { TelemetryConnectionController } from './connection/telemetry-connection.controller';
import {
  testTelemetryConnectionSchema,
  updateTelemetryConnectionSchema,
} from './connection/dto/telemetry-connection.dto';

// `@ApiExtension` stores its value under `swagger/apiExtension`.
const API_EXTENSION = 'swagger/apiExtension';

function permissionsOf(handler: object): unknown {
  return Reflect.getMetadata(PERMISSIONS_KEY, handler);
}

function rbacOf(handler: object): unknown {
  return (Reflect.getMetadata(API_EXTENSION, handler) as Record<string, unknown> | undefined)?.[
    RBAC_EXTENSION_KEY
  ];
}

describe('Telemetry controllers — access declarations', () => {
  describe('TelemetryAdminController', () => {
    const proto = TelemetryAdminController.prototype;

    it('gates GET config on telemetry:read', () => {
      expect(permissionsOf(proto.getConfig)).toEqual([PERMISSIONS.TELEMETRY_READ]);
    });

    it('gates PUT config on telemetry:write', () => {
      expect(permissionsOf(proto.replaceConfig)).toEqual([PERMISSIONS.TELEMETRY_WRITE]);
    });

    it('gates GET status on telemetry:read', () => {
      expect(permissionsOf(proto.getStatus)).toEqual([PERMISSIONS.TELEMETRY_READ]);
    });

    it('uses the exact seeded permission strings', () => {
      expect(PERMISSIONS.TELEMETRY_READ).toBe('telemetry:read');
      expect(PERMISSIONS.TELEMETRY_WRITE).toBe('telemetry:write');
    });

    it('parses If-Match and treats an unparseable one as absent', async () => {
      const settings = { replace: jest.fn().mockResolvedValue({}) };
      const controller = new TelemetryAdminController(settings as never, {} as never);
      const body = {} as never;

      await controller.replaceConfig(body, 'user-1', '7');
      await controller.replaceConfig(body, 'user-1', 'W/"abc"');
      await controller.replaceConfig(body, 'user-1');

      expect(settings.replace.mock.calls.map((call) => call[2])).toEqual([7, undefined, undefined]);
    });
  });

  describe('TelemetryConfigController', () => {
    it('requires authentication but no permission', () => {
      const handler = TelemetryConfigController.prototype.getConfig;

      expect(rbacOf(handler)).toEqual({ authenticated: true, roles: [], permissions: [] });
      expect(permissionsOf(handler)).toBeUndefined();
    });
  });

  describe('TelemetryExplorerController', () => {
    const proto = TelemetryExplorerController.prototype;

    it.each(['query', 'getSchema', 'export'] as const)('gates %s on telemetry:query', (method) => {
      expect(permissionsOf(proto[method])).toEqual([PERMISSIONS.TELEMETRY_QUERY]);
      expect(PERMISSIONS.TELEMETRY_QUERY).toBe('telemetry:query');
    });

    it('passes the explorer source and maxRows to the query service', async () => {
      const queries = { run: jest.fn().mockResolvedValue({}) };
      const controller = new TelemetryExplorerController(queries as never, {} as never, {} as never);

      await controller.query({ sql: 'SELECT 1', maxRows: 7 } as never, 'user-1');

      expect(queries.run).toHaveBeenCalledWith('user-1', 'SELECT 1', { maxRows: 7, source: 'explorer' });
    });

    it('sends an export as an uncached attachment', async () => {
      const exports = {
        export: jest.fn().mockResolvedValue({
          buffer: Buffer.from('a\r\n'),
          contentType: 'text/csv; charset=utf-8',
          filename: 'telemetry-20260927-142501.csv',
          rowCount: 0,
          truncated: false,
        }),
      };
      const headers: Record<string, string> = {};
      const reply = {
        status: jest.fn().mockReturnThis(),
        header: jest.fn(function (this: unknown, name: string, value: string) {
          headers[name] = value;
          return this;
        }),
        send: jest.fn().mockReturnThis(),
      };
      const controller = new TelemetryExplorerController({} as never, {} as never, exports as never);

      await controller.export({ sql: 'SELECT a FROM t', format: 'csv' } as never, 'user-1', reply as never);

      expect(exports.export).toHaveBeenCalledWith('user-1', 'SELECT a FROM t', 'csv');
      expect(reply.status).toHaveBeenCalledWith(200);
      expect(headers).toEqual({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="telemetry-20260927-142501.csv"',
        'Content-Length': '3',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Telemetry-Row-Count': '0',
        'X-Telemetry-Truncated': 'false',
      });
      expect(reply.send).toHaveBeenCalledWith(Buffer.from('a\r\n'));
    });
  });

  describe('TelemetryDashboardController (issue #577)', () => {
    const proto = TelemetryDashboardController.prototype;

    it.each(['summary', 'timeseries', 'top', 'events', 'filters'] as const)('gates %s on telemetry:query', (method) => {
      expect(permissionsOf(proto[method])).toEqual([PERMISSIONS.TELEMETRY_QUERY]);
    });

    it('passes the user and the parsed query to the service', async () => {
      const dashboard = { top: jest.fn().mockResolvedValue({}) };
      const controller = new TelemetryDashboardController(dashboard as never);

      await controller.top({ kind: 'routes', range: '6h' } as never, 'user-1');

      expect(dashboard.top).toHaveBeenCalledWith('user-1', { kind: 'routes', range: '6h' });
    });
  });

  describe('TelemetryConnectionController (issue #558)', () => {
    const proto = TelemetryConnectionController.prototype;

    it('gates GET on telemetry:read', () => {
      expect(permissionsOf(proto.getConnection)).toEqual([PERMISSIONS.TELEMETRY_READ]);
    });

    it.each(['replaceConnection', 'resetConnection', 'testConnection'] as const)(
      'gates %s on telemetry:write',
      (method) => {
        expect(permissionsOf(proto[method])).toEqual([PERMISSIONS.TELEMETRY_WRITE]);
      },
    );

    it('parses If-Match and treats an unparseable one as absent, for both PUT and DELETE', async () => {
      const admin = { replace: jest.fn().mockResolvedValue({}), reset: jest.fn().mockResolvedValue({}) };
      const tester = { test: jest.fn().mockResolvedValue({}) };
      const controller = new TelemetryConnectionController(admin as never, tester as never);
      const body = {} as never;

      await controller.replaceConnection(body, 'user-1', '7');
      await controller.replaceConnection(body, 'user-1', 'W/"abc"');
      await controller.replaceConnection(body, 'user-1');
      expect(admin.replace.mock.calls.map((call) => call[2])).toEqual([7, undefined, undefined]);

      await controller.resetConnection('user-1', '3');
      await controller.resetConnection('user-1', 'not-a-number');
      await controller.resetConnection('user-1');
      expect(admin.reset.mock.calls.map((call) => call[1])).toEqual([3, undefined, undefined]);
    });

    it('POST test delegates straight to the test service', async () => {
      const admin = {};
      const tester = { test: jest.fn().mockResolvedValue({ reader: {}, admin: { skipped: true } }) };
      const controller = new TelemetryConnectionController(admin as never, tester as never);
      const body = { host: 'h' } as never;

      await controller.testConnection(body, 'user-1');

      expect(tester.test).toHaveBeenCalledWith(body, 'user-1');
    });

    describe('request bodies (issue #562)', () => {
      const MINIMAL = { readerUser: 'reader', adminUser: null };

      it.each([
        ['absent', {}],
        ['null', { host: null }],
        ['empty', { host: '' }],
        ['whitespace', { host: '   ' }],
      ])('a %s host is automatic (null) on PUT and on test', (_label, host) => {
        for (const schema of [updateTelemetryConnectionSchema, testTelemetryConnectionSchema]) {
          const parsed = schema.parse({ ...MINIMAL, ...host });

          expect(parsed.host).toBeNull();
        }
      });

      it('a non-blank host is a custom override, trimmed and validated as before', () => {
        expect(updateTelemetryConnectionSchema.parse({ ...MINIMAL, host: ' greptime.internal ' }).host).toBe(
          'greptime.internal',
        );
        expect(updateTelemetryConnectionSchema.parse({ ...MINIMAL, host: '10.0.0.5' }).host).toBe('10.0.0.5');

        for (const host of ['http://greptimedb', 'greptimedb:4003', 'a/b', 'x'.repeat(254)]) {
          expect(updateTelemetryConnectionSchema.safeParse({ ...MINIMAL, host }).success).toBe(false);
        }
      });

      it('pgPort and database default to 4003 / public when omitted, and are still validated when sent', () => {
        const parsed = updateTelemetryConnectionSchema.parse(MINIMAL);

        expect(parsed.pgPort).toBe(4003);
        expect(parsed.database).toBe('public');
        expect(updateTelemetryConnectionSchema.parse({ ...MINIMAL, pgPort: 5000, database: 'tele' })).toMatchObject({
          pgPort: 5000,
          database: 'tele',
        });
        expect(updateTelemetryConnectionSchema.safeParse({ ...MINIMAL, pgPort: 0 }).success).toBe(false);
        expect(updateTelemetryConnectionSchema.safeParse({ ...MINIMAL, database: 'bad-name' }).success).toBe(false);
      });

      it('a custom host still requires readerUser and adminUser (null allowed)', () => {
        for (const schema of [updateTelemetryConnectionSchema, testTelemetryConnectionSchema]) {
          expect(schema.safeParse({ host: 'h', adminUser: null }).success).toBe(false);
          expect(schema.safeParse({ host: 'h', readerUser: '  ', adminUser: null }).success).toBe(false);
          expect(schema.safeParse({ host: 'h', readerUser: 'reader' }).success).toBe(false);
          expect(schema.safeParse({ host: 'h', readerUser: 'reader', adminUser: null }).success).toBe(true);
        }
      });

      it('an automatic host needs nothing else, and accepts (to ignore) what older clients send (issue #570)', () => {
        for (const schema of [updateTelemetryConnectionSchema, testTelemetryConnectionSchema]) {
          const empty = schema.parse({});
          expect(empty.host).toBeNull();
          expect(empty.readerUser).toBeUndefined();
          expect(empty.adminUser).toBeUndefined();

          const blank = schema.parse({ host: '', readerUser: '', adminUser: '' });
          expect(blank.host).toBeNull();
          expect(blank.readerUser).toBeUndefined();
          expect(blank.adminUser).toBeNull();
          expect(
            schema.safeParse({ host: null, readerUser: 'r', readerPassword: 'p', adminUser: 'a', adminPassword: 'q' })
              .success,
          ).toBe(true);
        }
      });
    });
  });
});
