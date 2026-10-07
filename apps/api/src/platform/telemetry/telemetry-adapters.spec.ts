import { APP_SLUG } from '@app/shared';
import { z } from 'zod';

import { AiError } from '../../ai/core/ai-error';
import { CredentialsService } from '../../credentials/credentials.service';
import {
  TELEMETRY_AI,
  TELEMETRY_APP_INFO,
  TELEMETRY_AUDIT_SINK,
  TELEMETRY_CREDENTIAL_STORE,
  TELEMETRY_JOBS,
  TELEMETRY_SETTINGS_STORE,
} from '@marinoscar/platform-api/telemetry';
import { TelemetryAiAdapter } from './telemetry-ai.adapter';
import { TelemetryAppInfoAdapter } from './telemetry-app-info.adapter';
import { TelemetryAuditSinkAdapter } from './telemetry-audit-sink.adapter';
import { TelemetryHostModule } from './telemetry-host.module';
import { TelemetryJobsAdapter } from './telemetry-jobs.adapter';
import { TELEMETRY_OWNED_ROW_KEYS, TelemetrySettingsStoreAdapter } from './telemetry-settings-store.adapter';

// The app's adapters for the telemetry slice's host ports (marinoscar/EnterpriseAppBase#703).

describe('TelemetryHostModule', () => {
  it('binds every telemetry port to an app adapter, and exports each token', () => {
    const providers = Reflect.getMetadata('providers', TelemetryHostModule);
    const exported = Reflect.getMetadata('exports', TelemetryHostModule);

    expect(providers).toEqual([
      { provide: TELEMETRY_AUDIT_SINK, useClass: TelemetryAuditSinkAdapter },
      { provide: TELEMETRY_SETTINGS_STORE, useClass: TelemetrySettingsStoreAdapter },
      { provide: TELEMETRY_CREDENTIAL_STORE, useExisting: CredentialsService },
      { provide: TELEMETRY_JOBS, useClass: TelemetryJobsAdapter },
      { provide: TELEMETRY_AI, useClass: TelemetryAiAdapter },
      { provide: TELEMETRY_APP_INFO, useClass: TelemetryAppInfoAdapter },
    ]);
    expect(exported).toEqual([
      TELEMETRY_AUDIT_SINK,
      TELEMETRY_SETTINGS_STORE,
      TELEMETRY_CREDENTIAL_STORE,
      TELEMETRY_JOBS,
      TELEMETRY_AI,
      TELEMETRY_APP_INFO,
    ]);
  });
});

describe('TelemetryAuditSinkAdapter (TELEMETRY_AUDIT_SINK)', () => {
  it('writes the audit_events columns telemetry always wrote, meta as JSON', async () => {
    const create = jest.fn().mockResolvedValue({});
    const sink = new TelemetryAuditSinkAdapter({ auditEvent: { create } } as never);

    await sink.record({
      actorUserId: 'u1',
      action: 'telemetry:config_update',
      targetType: 'telemetry_config',
      targetId: 'telemetry',
      meta: { changedFields: ['enabled', 'retentionDays'] },
    });
    await sink.record({ actorUserId: null, action: 'a', targetType: 't', targetId: 'i' });

    expect(create.mock.calls).toEqual([
      [
        {
          data: {
            actorUserId: 'u1',
            action: 'telemetry:config_update',
            targetType: 'telemetry_config',
            targetId: 'telemetry',
            meta: { changedFields: ['enabled', 'retentionDays'] },
          },
        },
      ],
      [{ data: { actorUserId: null, action: 'a', targetType: 't', targetId: 'i' } }],
    ]);
  });
});

describe('TelemetrySettingsStoreAdapter (TELEMETRY_SETTINGS_STORE)', () => {
  const UPDATED = new Date('2026-09-27T00:00:00Z');

  function setup() {
    const prisma = {
      systemSettings: {
        findUnique: jest.fn().mockResolvedValue({
          value: { host: null },
          version: 4,
          updatedAt: UPDATED,
          updatedByUser: { id: 'u1', email: 'a@example.test' },
        }),
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const systemSettings = {
      getTelemetryPolicy: jest.fn().mockResolvedValue({ enabled: true }),
      patchSettings: jest.fn().mockResolvedValue({}),
      getAiPolicy: jest.fn().mockResolvedValue({ enabled: true }),
      getMaintenancePolicy: jest.fn().mockResolvedValue({ enabled: false }),
      getDatabaseBackupPolicy: jest.fn().mockResolvedValue({ enabled: true }),
      getNotificationsPolicy: jest.fn().mockResolvedValue({ browserEnabled: false }),
      getNodesPolicy: jest.fn().mockResolvedValue({ jobSecretBrokerEnabled: true }),
    };
    return { store: new TelemetrySettingsStoreAdapter(prisma as never, systemSettings as never), prisma, systemSettings };
  }

  it('reads and replaces the telemetry namespace through SystemSettingsService', async () => {
    const { store, systemSettings } = setup();

    await expect(store.getTelemetryPolicy()).resolves.toEqual({ enabled: true });
    await store.replaceTelemetryPolicy({ enabled: false } as never, 'u1', 3);

    expect(systemSettings.patchSettings).toHaveBeenCalledWith({ telemetry: { enabled: false } }, 'u1', 3);
  });

  it("reads the global row's provenance without creating it", async () => {
    const { store, prisma } = setup();

    await expect(store.readPolicyProvenance()).resolves.toEqual({
      version: 4,
      updatedAt: UPDATED,
      updatedBy: { id: 'u1', email: 'a@example.test' },
    });
    expect(prisma.systemSettings.findUnique).toHaveBeenCalledWith({
      where: { key: 'global' },
      select: { version: true, updatedAt: true, updatedByUser: { select: { id: true, email: true } } },
    });

    prisma.systemSettings.findUnique.mockResolvedValue(null);
    await expect(store.readPolicyProvenance()).resolves.toBeNull();
  });

  it('reads, writes (version + 1) and deletes the telemetry_connection row', async () => {
    const { store, prisma } = setup();

    await expect(store.readRow('telemetry_connection')).resolves.toEqual({
      value: { host: null },
      version: 4,
      updatedAt: UPDATED,
      updatedBy: { id: 'u1', email: 'a@example.test' },
    });
    await store.writeRow('telemetry_connection', { host: null }, 'u1');
    await store.deleteRow('telemetry_connection');

    expect(prisma.systemSettings.upsert).toHaveBeenCalledWith({
      where: { key: 'telemetry_connection' },
      update: { value: { host: null }, updatedByUserId: 'u1', version: { increment: 1 } },
      create: { key: 'telemetry_connection', value: { host: null }, updatedByUserId: 'u1' },
    });
    expect(prisma.systemSettings.deleteMany).toHaveBeenCalledWith({ where: { key: 'telemetry_connection' } });
  });

  it('refuses every row telemetry does not own, before touching the database', async () => {
    const { store, prisma } = setup();

    expect(TELEMETRY_OWNED_ROW_KEYS).toEqual(['telemetry_connection']);
    await expect(store.readRow('global')).rejects.toThrow('may not access');
    await expect(store.writeRow('global', {}, 'u1')).rejects.toThrow('may not access');
    await expect(store.deleteRow('ai_keys')).rejects.toThrow('may not access');
    expect(prisma.systemSettings.findUnique).not.toHaveBeenCalled();
    expect(prisma.systemSettings.upsert).not.toHaveBeenCalled();
    expect(prisma.systemSettings.deleteMany).not.toHaveBeenCalled();
  });

  it('reads each allowlisted feature flag from its own policy', async () => {
    const { store } = setup();

    const flags = await Promise.all(
      (['ai', 'maintenanceMode', 'databaseBackup', 'browserNotifications', 'nodeJobSecretBroker'] as const).map((f) =>
        store.readFeatureFlag(f),
      ),
    );
    expect(flags).toEqual([true, false, true, false, true]);
  });
});

describe('TelemetryAiAdapter (TELEMETRY_AI)', () => {
  it('assertEnabled is AiConfigService.assertEnabled, so "AI is off" is the same 403', async () => {
    const off = new AiError('AI_DISABLED', 'AI features are disabled');
    const adapter = new TelemetryAiAdapter({} as never, { assertEnabled: jest.fn().mockRejectedValue(off) } as never);

    await expect(adapter.assertEnabled()).rejects.toBe(off);
    expect(adapter.isAiError(off)).toBe(true);
    expect(adapter.isAiError(new Error('x'))).toBe(false);
  });

  it("defineTool is the AI platform's own defineTool (name rule, argument parsing)", () => {
    const adapter = new TelemetryAiAdapter({} as never, {} as never);
    const tool = adapter.defineTool({
      name: 'list_tables',
      description: 'd',
      parameters: z.object({}).strict(),
      execute: () => 1,
    }) as unknown as { tool: { name: string; strict: boolean }; parseArguments(raw: string): { success: boolean } };

    expect(tool.tool).toMatchObject({ name: 'list_tables', strict: true });
    expect(tool.parseArguments('{}').success).toBe(true);
    expect(() =>
      adapter.defineTool({ name: 'bad name', description: 'd', parameters: z.object({}), execute: () => 1 }),
    ).toThrow(TypeError);
  });

  it('forUser runs the tool loop through AiService.forUser(userId).runTools', async () => {
    const runTools = jest.fn().mockResolvedValue({ final: { outputText: 'x' }, steps: [], stopReason: 'completed' });
    const ai = { forUser: jest.fn().mockReturnValue({ runTools }) };
    const adapter = new TelemetryAiAdapter(ai as never, {} as never);
    const signal = new AbortController().signal;

    const result = await adapter.forUser('u1').runTools(
      {
        provider: 'p',
        model: 'm',
        instructions: 'i',
        input: [],
        tools: [],
        maxSteps: 2,
        toolTimeoutMs: 1000,
        onStep: () => undefined,
      },
      { signal },
    );

    expect(ai.forUser).toHaveBeenCalledWith('u1');
    expect(runTools).toHaveBeenCalledWith(expect.objectContaining({ provider: 'p', model: 'm', maxSteps: 2 }), { signal });
    expect(result.stopReason).toBe('completed');
  });
});

describe('TelemetryAppInfoAdapter (TELEMETRY_APP_INFO)', () => {
  it("is the app's identity: APP_SLUG, its service name and version", () => {
    const info = new TelemetryAppInfoAdapter();

    expect(info.slug).toBe(APP_SLUG);
    expect(info.serviceName()).toBe(process.env.OTEL_SERVICE_NAME || `${APP_SLUG}-api`);
    expect(typeof info.apiVersion()).toBe('string');
  });
});
