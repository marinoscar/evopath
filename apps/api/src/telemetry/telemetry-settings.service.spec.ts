import { ConflictException } from '@nestjs/common';
import { APP_SLUG } from '@app/shared';

import { telemetryGate } from '../common/otel/telemetry-gate';
import type { SystemTelemetryValue } from '../common/schemas/settings.schema';
import { DEFAULT_SYSTEM_SETTINGS } from '../common/types/settings.types';
import { TELEMETRY_RETENTION_TYPE } from './handlers/telemetry-retention.handler';
import {
  diffTelemetryFieldNames,
  TELEMETRY_CONFIG_AUDIT_ACTION,
  TELEMETRY_GATE_REFRESH_MS,
  TelemetrySettingsService,
} from './telemetry-settings.service';

const DEFAULTS: SystemTelemetryValue = structuredClone(DEFAULT_SYSTEM_SETTINGS.telemetry);

function build(options: { configured?: boolean; policy?: SystemTelemetryValue; version?: number } = {}) {
  const policy = { current: structuredClone(options.policy ?? DEFAULTS) };

  const prisma = {
    systemSettings: {
      findUnique: jest.fn().mockResolvedValue(
        options.version === undefined
          ? null
          : { version: options.version, updatedAt: new Date('2026-09-27T00:00:00Z'), updatedByUser: null },
      ),
    },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
    job: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const systemSettings = {
    getTelemetryPolicy: jest.fn(async () => structuredClone(policy.current)),
    patchSettings: jest.fn(async (dto: { telemetry: SystemTelemetryValue }) => {
      policy.current = structuredClone(dto.telemetry);
      return {};
    }),
  };
  const greptime = {
    isConfigured: jest.fn().mockReturnValue(options.configured ?? true),
    isAdminConfigured: jest.fn().mockReturnValue(options.configured ?? true),
  };
  const jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };

  const service = new TelemetrySettingsService(
    prisma as never,
    systemSettings as never,
    greptime as never,
    jobs as never,
  );

  return { service, prisma, systemSettings, greptime, jobs, policy };
}

describe('TelemetrySettingsService', () => {
  beforeEach(() => {
    telemetryGate.setEnabled(false);
    telemetryGate.setInstanceId(APP_SLUG);
  });

  afterEach(() => {
    telemetryGate.setEnabled(false);
    telemetryGate.setInstanceId(APP_SLUG);
    jest.useRealTimers();
  });

  describe('getPolicy', () => {
    it('caches for five seconds, and fresh bypasses the cache', async () => {
      const { service, systemSettings } = build();

      await service.getPolicy();
      await service.getPolicy();
      expect(systemSettings.getTelemetryPolicy).toHaveBeenCalledTimes(1);

      await service.getPolicy({ fresh: true });
      expect(systemSettings.getTelemetryPolicy).toHaveBeenCalledTimes(2);
    });
  });

  describe('refreshGate', () => {
    it('opens the gate when enabled and GreptimeDB is configured', async () => {
      const { service } = build({ policy: { ...DEFAULTS, enabled: true } });

      await expect(service.refreshGate()).resolves.toBe(true);
      expect(telemetryGate.isEnabled()).toBe(true);
    });

    it('keeps the gate closed when enabled but GreptimeDB is not configured', async () => {
      const { service } = build({ configured: false, policy: { ...DEFAULTS, enabled: true } });

      await expect(service.refreshGate()).resolves.toBe(false);
    });

    it('closes the gate when disabled', async () => {
      telemetryGate.setEnabled(true);
      const { service } = build({ policy: { ...DEFAULTS, enabled: false } });

      await expect(service.refreshGate()).resolves.toBe(false);
    });

    it('keeps the last value when the settings read fails, and never throws', async () => {
      telemetryGate.setEnabled(true);
      const { service, systemSettings } = build();
      systemSettings.getTelemetryPolicy.mockRejectedValue(new Error('db down'));

      await expect(service.refreshGate()).resolves.toBe(true);
      expect(telemetryGate.isEnabled()).toBe(true);
    });

    it('pushes APP_SLUG as the instance id while telemetry.instanceId is null', async () => {
      telemetryGate.setInstanceId('stale');
      const { service } = build({ policy: { ...DEFAULTS, instanceId: null } });

      await service.refreshGate();

      expect(telemetryGate.instanceId()).toBe(APP_SLUG);
    });

    it('pushes an administrator-set instance id, whatever the gate state', async () => {
      const { service } = build({ configured: false, policy: { ...DEFAULTS, instanceId: 'prod-eu.1' } });

      await expect(service.refreshGate()).resolves.toBe(false);
      expect(telemetryGate.instanceId()).toBe('prod-eu.1');
    });

    it('keeps the last instance id when the settings read fails', async () => {
      telemetryGate.setInstanceId('prod-eu');
      const { service, systemSettings } = build();
      systemSettings.getTelemetryPolicy.mockRejectedValue(new Error('db down'));

      await service.refreshGate();

      expect(telemetryGate.instanceId()).toBe('prod-eu');
    });

    it('is applied on init and then on an interval, stopped on destroy', async () => {
      jest.useFakeTimers();
      const { service, systemSettings } = build({ policy: { ...DEFAULTS, enabled: true } });

      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(systemSettings.getTelemetryPolicy).toHaveBeenCalledTimes(1);
      expect(telemetryGate.isEnabled()).toBe(true);

      await jest.advanceTimersByTimeAsync(TELEMETRY_GATE_REFRESH_MS);
      expect(systemSettings.getTelemetryPolicy).toHaveBeenCalledTimes(2);

      service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(TELEMETRY_GATE_REFRESH_MS * 3);
      expect(systemSettings.getTelemetryPolicy).toHaveBeenCalledTimes(2);
    });
  });

  describe('replace', () => {
    const NEXT: SystemTelemetryValue = {
      ...DEFAULTS,
      enabled: true,
      retentionDays: 7,
      assistant: { ...DEFAULTS.assistant, provider: 'openai' },
    };

    it('refuses an If-Match mismatch with 409 before writing anything', async () => {
      const { service, systemSettings, prisma, jobs } = build({ version: 5 });

      await expect(service.replace(NEXT, 'user-1', 4)).rejects.toBeInstanceOf(ConflictException);

      expect(systemSettings.patchSettings).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('writes the namespace, passing the expected version on to patchSettings', async () => {
      const { service, systemSettings } = build({ version: 5 });

      await service.replace(NEXT, 'user-1', 5);

      expect(systemSettings.patchSettings).toHaveBeenCalledWith({ telemetry: NEXT }, 'user-1', 5);
    });

    it('audits telemetry:config_update with changed field names only', async () => {
      const { service, prisma } = build({ version: 1 });

      await service.replace(NEXT, 'user-1');

      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: 'user-1',
          action: TELEMETRY_CONFIG_AUDIT_ACTION,
          targetType: 'telemetry_config',
          targetId: 'telemetry',
          meta: { changedFields: ['enabled', 'retentionDays', 'assistant.provider'] },
        },
      });
    });

    it('refreshes the gate from the new value on this instance', async () => {
      const { service } = build({ version: 1 });

      await service.replace(NEXT, 'user-1');

      expect(telemetryGate.isEnabled()).toBe(true);
    });

    it('applies a new instance id on this instance, and audits the field name', async () => {
      const { service, prisma } = build({ version: 1 });

      await service.replace({ ...DEFAULTS, instanceId: 'staging' }, 'user-1');

      expect(telemetryGate.instanceId()).toBe('staging');
      expect(prisma.auditEvent.create.mock.calls[0][0].data.meta).toEqual({ changedFields: ['instanceId'] });
    });

    it('null returns the instance id to the APP_SLUG default', async () => {
      const { service, systemSettings } = build({ version: 1, policy: { ...DEFAULTS, instanceId: 'staging' } });

      const view = await service.replace({ ...DEFAULTS, instanceId: null }, 'user-1');

      expect(systemSettings.patchSettings.mock.calls[0][0].telemetry.instanceId).toBeNull();
      expect(telemetryGate.instanceId()).toBe(APP_SLUG);
      expect(view).toMatchObject({ instanceId: null, instanceIdDefault: APP_SLUG, instanceIdEffective: APP_SLUG });
    });

    it('an absent instanceId keeps the stored value (a client that predates the field cannot reset it)', async () => {
      const { service, systemSettings, prisma } = build({ version: 1, policy: { ...DEFAULTS, instanceId: 'staging' } });
      const { instanceId: _omitted, ...withoutInstanceId } = DEFAULTS;

      const view = await service.replace(withoutInstanceId, 'user-1');

      expect(systemSettings.patchSettings.mock.calls[0][0].telemetry.instanceId).toBe('staging');
      expect(prisma.auditEvent.create.mock.calls[0][0].data.meta).toEqual({ changedFields: [] });
      expect(view.instanceIdEffective).toBe('staging');
    });

    it('enqueues the retention job as low-priority housekeeping', async () => {
      const { service, jobs } = build({ version: 1 });

      await service.replace(NEXT, 'user-1');

      expect(jobs.enqueue).toHaveBeenCalledWith({
        type: TELEMETRY_RETENTION_TYPE,
        reason: 'backfill',
        priority: 100,
      });
    });

    it('does not fail the save when the retention enqueue fails', async () => {
      const { service, jobs } = build({ version: 1 });
      jobs.enqueue.mockRejectedValue(new Error('queue down'));

      await expect(service.replace(NEXT, 'user-1')).resolves.toMatchObject({ enabled: true, retentionDays: 7 });
    });

    it('returns the admin view of the new value', async () => {
      const { service } = build({ version: 1 });

      const view = await service.replace(NEXT, 'user-1');

      expect(view).toMatchObject({
        ...NEXT,
        available: true,
        retentionApplicable: true,
        version: 1,
        updatedAt: '2026-09-27T00:00:00.000Z',
        updatedBy: null,
      });
    });
  });

  describe('describePublic', () => {
    it('reports availability from GreptimeDB config and the two switches', async () => {
      const { service } = build({
        configured: false,
        policy: { ...DEFAULTS, enabled: true, assistant: { ...DEFAULTS.assistant, enabled: true } },
      });

      await expect(service.describePublic()).resolves.toEqual({
        available: false,
        enabled: true,
        assistantEnabled: true,
      });
    });
  });

  describe('describeForAdmin', () => {
    it('reports version 0 when no settings row exists', async () => {
      const { service } = build();

      await expect(service.describeForAdmin()).resolves.toMatchObject({
        ...DEFAULTS,
        version: 0,
        updatedAt: null,
        updatedBy: null,
      });
    });

    it('reports the APP_SLUG default and, with no override, it as the effective instance id', async () => {
      const { service } = build();

      await expect(service.describeForAdmin()).resolves.toMatchObject({
        instanceId: null,
        instanceIdDefault: APP_SLUG,
        instanceIdEffective: APP_SLUG,
      });
    });

    it('reports an override as the effective instance id, keeping the default beside it', async () => {
      const { service } = build({ policy: { ...DEFAULTS, instanceId: 'prod-eu' } });

      await expect(service.describeForAdmin()).resolves.toMatchObject({
        instanceId: 'prod-eu',
        instanceIdDefault: APP_SLUG,
        instanceIdEffective: 'prod-eu',
      });
    });
  });

  it('diffTelemetryFieldNames names nothing for identical policies', () => {
    expect(diffTelemetryFieldNames(DEFAULTS, structuredClone(DEFAULTS))).toEqual([]);
  });
});
