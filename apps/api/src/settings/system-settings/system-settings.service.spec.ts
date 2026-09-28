import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemSettingsService } from './system-settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';
import {
  DEFAULT_SYSTEM_SETTINGS,
  SystemSettingsValue,
} from '../../common/types/settings.types';
import { systemSettingsResponseSchema } from '../dto/system-settings-response.dto';
import { patchSystemSettingsSchema } from '../dto/update-system-settings.dto';
import { systemSettingsPatchSchema } from '../../common/schemas/settings.schema';

/**
 * The operations namespaces (#256, epic #254) with their defaults.
 *
 * Spread into the "exactly this value reached Prisma" assertions below rather
 * than written out in each of them. Every write path materialises these four
 * blocks — `readKnownSettings` fills them from `DEFAULT_SYSTEM_SETTINGS` for a
 * row that predates them, and the merge then writes them back — so what reaches
 * storage always carries all four, whatever the caller sent. Spreading keeps
 * each assertion about the one thing it was written to prove (unknown-key
 * preservation, audit meta, the closed-body rule) instead of restating
 * twenty-three defaults five times.
 */
const OPERATIONS_DEFAULTS = {
  jobs: DEFAULT_SYSTEM_SETTINGS.jobs,
  nodes: DEFAULT_SYSTEM_SETTINGS.nodes,
  databaseBackup: DEFAULT_SYSTEM_SETTINGS.databaseBackup,
  maintenance: DEFAULT_SYSTEM_SETTINGS.maintenance,
};

describe('SystemSettingsService', () => {
  let service: SystemSettingsService;
  let mockPrisma: MockPrismaService;
  let mockConfigService: { get: jest.Mock };

  const mockUserId = 'user-123';
  const mockUser = {
    id: mockUserId,
    email: 'admin@example.com',
  };

  const mockSystemSettings = {
    id: 'settings-1',
    key: 'global',
    value: DEFAULT_SYSTEM_SETTINGS as any,
    version: 1,
    updatedAt: new Date(),
    updatedByUserId: mockUserId,
    updatedByUser: mockUser,
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    // Pass-through by default: `get(key, defaultValue)` returns `defaultValue`,
    // which mirrors ConfigService's real behaviour when nothing overrides the
    // key. Individual #148 tests below replace this with a table of real
    // values to prove the security block is read FROM config, not hardcoded.
    mockConfigService = {
      get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemSettingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<SystemSettingsService>(SystemSettingsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getSettings', () => {
    it('should return current system settings with version', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );

      const result = await service.getSettings();

      expect(result).toMatchObject({
        jobs: DEFAULT_SYSTEM_SETTINGS.jobs,
        nodes: DEFAULT_SYSTEM_SETTINGS.nodes,
        version: 1,
      });
      expect(result.updatedAt).toBeDefined();
      expect(result.updatedBy).toEqual(mockUser);
      expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledWith({
        where: { key: 'global' },
        include: {
          updatedByUser: {
            select: { id: true, email: true },
          },
        },
      });
    });

    it('should create and return default settings when none exist', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
      mockPrisma.systemSettings.create.mockResolvedValue({
        ...mockSystemSettings,
        updatedByUserId: null,
        updatedByUser: null,
      } as any);

      const result = await service.getSettings();

      expect(result).toMatchObject({
        jobs: DEFAULT_SYSTEM_SETTINGS.jobs,
        nodes: DEFAULT_SYSTEM_SETTINGS.nodes,
        version: 1,
      });
      expect(mockPrisma.systemSettings.create).toHaveBeenCalledWith({
        data: {
          key: 'global',
          value: DEFAULT_SYSTEM_SETTINGS as any,
        },
        include: {
          updatedByUser: {
            select: { id: true, email: true },
          },
        },
      });
    });
  });

  describe('replaceSettings (PUT)', () => {
    it('should replace entire settings', async () => {
      const newSettings: SystemSettingsValue = {
        ...DEFAULT_SYSTEM_SETTINGS,
        jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, stuckThresholdMinutes: 45 },
        nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
        notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
      };

      mockPrisma.systemSettings.upsert.mockResolvedValue({
        ...mockSystemSettings,
        value: newSettings as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.replaceSettings(newSettings, mockUserId);

      expect(result).toMatchObject({
        jobs: newSettings.jobs,
        nodes: newSettings.nodes,
        version: 2,
      });
      expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith({
        where: { key: 'global' },
        update: {
          value: newSettings as any,
          updatedByUserId: mockUserId,
          version: { increment: 1 },
        },
        create: {
          key: 'global',
          value: newSettings as any,
          updatedByUserId: mockUserId,
        },
        include: {
          updatedByUser: {
            select: { id: true, email: true },
          },
        },
      });
    });

    it('should increment version on update', async () => {
      const newSettings: SystemSettingsValue = {
        ...DEFAULT_SYSTEM_SETTINGS,
        jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, stuckThresholdMinutes: 10 },
        notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
      };

      mockPrisma.systemSettings.upsert.mockResolvedValue({
        ...mockSystemSettings,
        value: newSettings as any,
        version: 5,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.replaceSettings(newSettings, mockUserId);

      expect(result.version).toBe(5);
      expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            version: { increment: 1 },
          }),
        }),
      );
    });

    it('should create audit event on replace', async () => {
      const newSettings: SystemSettingsValue = {
        ...DEFAULT_SYSTEM_SETTINGS,
        nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
        notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
      };

      mockPrisma.systemSettings.upsert.mockResolvedValue({
        ...mockSystemSettings,
        value: newSettings as any,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.replaceSettings(newSettings, mockUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: mockUserId,
          action: 'system_settings:replace',
          targetType: 'system_settings',
          targetId: mockSystemSettings.id,
          meta: {
            newValue: newSettings,
          } as any,
        },
      });
    });
  });

  describe('patchSettings (PATCH)', () => {
    beforeEach(() => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );
    });

    it('should merge partial settings with existing settings', async () => {
      const partialUpdate = {
        nodes: { jobSecretBrokerEnabled: true },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.patchSettings(partialUpdate, mockUserId);

      expect(result.nodes.jobSecretBrokerEnabled).toBe(true);
      expect(result.jobs).toEqual(DEFAULT_SYSTEM_SETTINGS.jobs);
    });

    it('should merge a nested jobs.history field, leaving its sibling untouched', async () => {
      const existingWithJobs = {
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: {
            history: { retentionDays: 60, purgeEnabled: false },
            stuckThresholdMinutes: 30,
          },
        } as any,
      };

      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        existingWithJobs as any,
      );

      const partialUpdate = {
        jobs: { stuckThresholdMinutes: 99 },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: {
            history: { retentionDays: 60, purgeEnabled: false },
            stuckThresholdMinutes: 99,
          },
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.patchSettings(partialUpdate, mockUserId);

      expect(result.jobs).toEqual({
        history: { retentionDays: 60, purgeEnabled: false },
        stuckThresholdMinutes: 99,
      });
    });

    // =========================================================================
    // storage.forcePathStyle: the one nullable field in the storage merge (#374)
    // =========================================================================
    //
    // The merge uses `!== undefined` for this field and `??` for its string
    // neighbours, and these three cases are the difference. `null` is a value a
    // caller can legitimately SEND (it means "use this vendor's convention"),
    // so `??` would fold it into "absent" and leave the stored `true` in place
    // — leaving no request body able to undo a path-style override once one had
    // been saved. Only `undefined` may mean "leave it alone".

    describe('storage.forcePathStyle (tri-state)', () => {
      function storedWithForcePathStyle(value: boolean | null) {
        return {
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            storage: {
              ...DEFAULT_SYSTEM_SETTINGS.storage,
              provider: 's3compatible',
              bucket: 'my-bucket',
              endpoint: 'https://minio.internal:9000',
              accessKeyId: 'AKIAEXAMPLE',
              forcePathStyle: value,
            },
          } as any,
        };
      }

      /** The `storage` block that actually reached Prisma. */
      function writtenStorage(): Record<string, unknown> {
        expect(mockPrisma.systemSettings.update).toHaveBeenCalledTimes(1);

        const call = mockPrisma.systemSettings.update.mock.calls[0][0] as {
          data: { value: { storage: Record<string, unknown> } };
        };

        return call.data.value.storage;
      }

      beforeEach(() => {
        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);
      });

      it('can be PATCHed back to null over a stored true', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue(
          storedWithForcePathStyle(true) as any,
        );

        await service.patchSettings(
          { storage: { forcePathStyle: null } },
          mockUserId,
        );

        expect(writtenStorage().forcePathStyle).toBeNull();
        // Nothing else in the namespace moved.
        expect(writtenStorage().bucket).toBe('my-bucket');
      });

      it('leaves a stored true alone when the key is absent from the body', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue(
          storedWithForcePathStyle(true) as any,
        );

        await service.patchSettings(
          { storage: { bucket: 'other-bucket' } },
          mockUserId,
        );

        expect(writtenStorage().forcePathStyle).toBe(true);
        expect(writtenStorage().bucket).toBe('other-bucket');
      });

      it('accepts an explicit false over a stored null', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue(
          storedWithForcePathStyle(null) as any,
        );

        await service.patchSettings(
          { storage: { forcePathStyle: false } },
          mockUserId,
        );

        // `false` is an operator's answer, not an absent value — a `||` here
        // would discard it and keep the vendor convention.
        expect(writtenStorage().forcePathStyle).toBe(false);
      });
    });

    it('should throw ConflictException when If-Match version mismatch', async () => {
      const partialUpdate = {
        nodes: { jobSecretBrokerEnabled: true },
      };

      // Current version is 1, but expected version is 2
      await expect(
        service.patchSettings(partialUpdate, mockUserId, 2),
      ).rejects.toThrow(ConflictException);

      await expect(
        service.patchSettings(partialUpdate, mockUserId, 2),
      ).rejects.toThrow(
        'Settings version mismatch. Expected 2, found 1',
      );

      // Should not call update when version mismatch
      expect(mockPrisma.systemSettings.update).not.toHaveBeenCalled();
    });

    it('should succeed when If-Match version matches', async () => {
      const partialUpdate = {
        nodes: { jobSecretBrokerEnabled: true },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      // Current version is 1, expected version is 1
      const result = await service.patchSettings(
        partialUpdate,
        mockUserId,
        1,
      );

      expect(result).toBeDefined();
      expect(result.version).toBe(2);
      expect(mockPrisma.systemSettings.update).toHaveBeenCalled();
    });

    it('should increment version on patch', async () => {
      const partialUpdate = {
        nodes: { jobSecretBrokerEnabled: true },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.patchSettings(partialUpdate, mockUserId);

      expect(result.version).toBe(2);
      expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            version: { increment: 1 },
          }),
        }),
      );
    });

    it('should create audit event on patch', async () => {
      const partialUpdate = {
        nodes: { jobSecretBrokerEnabled: true },
      };

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
        } as any,
        version: 2,
      } as any);

      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.patchSettings(partialUpdate, mockUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: mockUserId,
          action: 'system_settings:patch',
          targetType: 'system_settings',
          targetId: mockSystemSettings.id,
          meta: expect.objectContaining({
            changes: partialUpdate,
            resultingValue: expect.any(Object),
          }) as any,
        },
      });
    });
  });

  // ===========================================================================
  // #130 — unknown keys in the 'global' row must survive a save.
  //
  // The rule pinned here: REQUEST BODIES STAY CLOSED; THE STORED VALUE IS
  // NEVER NARROWED. Two independent guarantees, tested separately on purpose
  // — proving only one would let a later change collapse them back together.
  //
  // `jobs`/`nodes` stand in as "a known namespace" throughout this section —
  // the same role `ui`/`features` played before #366 removed them — because
  // the point of every test here is the PRESERVATION MECHANISM, not any one
  // namespace's business meaning.
  // ===========================================================================
  describe('#130 unknown key preservation', () => {
    describe('the stored value is preserved (never narrowed)', () => {
      it('PATCH preserves an unknown top-level key while changing a known namespace', async () => {
        const storedValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          branding: { logoUrl: 'https://example.com/logo.png' },
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: storedValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
            branding: { logoUrl: 'https://example.com/logo.png' },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.patchSettings(
          { nodes: { jobSecretBrokerEnabled: true } },
          mockUserId,
        );

        expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              value: {
                ...OPERATIONS_DEFAULTS,
                nodes: {
                  ...DEFAULT_SYSTEM_SETTINGS.nodes,
                  jobSecretBrokerEnabled: true,
                },
                notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
                storage: DEFAULT_SYSTEM_SETTINGS.storage,
                ai: DEFAULT_SYSTEM_SETTINGS.ai,
                telemetry: DEFAULT_SYSTEM_SETTINGS.telemetry,
                branding: { logoUrl: 'https://example.com/logo.png' },
              },
            }),
          }),
        );

        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              meta: expect.objectContaining({
                preservedKeys: ['branding'],
              }),
            }),
          }),
        );
      });

      it('PATCH preserves an unknown key nested under jobs (a closed nested object)', async () => {
        const storedValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, extraKnob: 'legacy-value' },
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: storedValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            jobs: {
              ...DEFAULT_SYSTEM_SETTINGS.jobs,
              stuckThresholdMinutes: 10,
              extraKnob: 'legacy-value',
            },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.patchSettings(
          { jobs: { stuckThresholdMinutes: 10 } },
          mockUserId,
        );

        expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              value: {
                ...OPERATIONS_DEFAULTS,
                jobs: {
                  ...DEFAULT_SYSTEM_SETTINGS.jobs,
                  stuckThresholdMinutes: 10,
                  extraKnob: 'legacy-value',
                },
                notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
                storage: DEFAULT_SYSTEM_SETTINGS.storage,
                ai: DEFAULT_SYSTEM_SETTINGS.ai,
                telemetry: DEFAULT_SYSTEM_SETTINGS.telemetry,
              },
            }),
          }),
        );

        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              meta: expect.objectContaining({
                preservedKeys: ['jobs.extraKnob'],
              }),
            }),
          }),
        );
      });

      it('PUT preserves unknown stored keys while replacing the known ones', async () => {
        const storedValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: false },
          branding: { logoUrl: 'https://example.com/logo.png' },
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          value: storedValue,
        } as any);

        const newSettings: SystemSettingsValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
          notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
        };

        mockPrisma.systemSettings.upsert.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...newSettings,
            branding: { logoUrl: 'https://example.com/logo.png' },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.replaceSettings(newSettings, mockUserId);

        const expectedValue = {
          branding: { logoUrl: 'https://example.com/logo.png' },
          ...newSettings,
        };

        expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            update: expect.objectContaining({ value: expectedValue }),
            create: expect.objectContaining({ value: expectedValue }),
          }),
        );

        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              meta: expect.objectContaining({
                preservedKeys: ['branding'],
              }),
            }),
          }),
        );
      });

      it('known keys still win the merge — jobs and nodes match the caller byte for byte', async () => {
        const storedValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, stuckThresholdMinutes: 5 },
          legacyBlob: { untouched: 1 },
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          value: storedValue,
        } as any);

        const newSettings: SystemSettingsValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, stuckThresholdMinutes: 120 },
          notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
        };

        mockPrisma.systemSettings.upsert.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...newSettings,
            legacyBlob: storedValue.legacyBlob,
          } as any,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.replaceSettings(newSettings, mockUserId);

        const upsertArgs = mockPrisma.systemSettings.upsert.mock.calls[0][0] as any;

        // Known keys are the caller's validated values, byte for byte — not
        // the stale stored ones — while the unknown key still survives.
        expect(upsertArgs.update.value.jobs).toEqual(newSettings.jobs);
        expect(upsertArgs.update.value.jobs.stuckThresholdMinutes).toBe(120);
        expect(upsertArgs.update.value.legacyBlob).toEqual({ untouched: 1 });
      });

      it('PUT against a missing row writes exactly the validated body, with no preserved keys', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue(null as any);

        const newSettings: SystemSettingsValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
          notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
        };

        mockPrisma.systemSettings.upsert.mockResolvedValue({
          ...mockSystemSettings,
          value: newSettings as any,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.replaceSettings(newSettings, mockUserId);

        expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            update: expect.objectContaining({ value: newSettings }),
            create: expect.objectContaining({ value: newSettings }),
          }),
        );

        // No preservedKeys entry at all — not even an empty array — matching
        // the "should create audit event on replace" contract above.
        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
          data: {
            actorUserId: mockUserId,
            action: 'system_settings:replace',
            targetType: 'system_settings',
            targetId: mockSystemSettings.id,
            meta: { newValue: newSettings } as any,
          },
        });
      });

      it.each([
        ['a non-object (string)', 'not-an-object' as unknown],
        ['null', null as unknown],
      ])(
        'PUT does not break the save when the stored value is %s',
        async (_label, malformed) => {
          mockPrisma.systemSettings.findUnique.mockResolvedValue({
            value: malformed,
          } as any);

          const newSettings: SystemSettingsValue = {
            ...DEFAULT_SYSTEM_SETTINGS,
            notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
          };

          mockPrisma.systemSettings.upsert.mockResolvedValue({
            ...mockSystemSettings,
            value: newSettings as any,
          } as any);
          mockPrisma.auditEvent.create.mockResolvedValue({} as any);

          await expect(
            service.replaceSettings(newSettings, mockUserId),
          ).resolves.toBeDefined();

          expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
              update: expect.objectContaining({ value: newSettings }),
            }),
          );
        },
      );

      // Was a skipped repro ("BUG: PATCH throws on a null stored value
      // instead of tolerating it") written against the first #130 commit:
      // patchSettings dereferenced the RAW stored value directly —
      // `currentValue.ui.allowUserThemeOverride` and
      // `{ ...currentValue.features }` — to build `merged`, before
      // mergePreservingUnknown (and its defensive collectUnknownKeys guard)
      // ever ran. A malformed `system_settings.value` made PATCH throw an
      // unhandled TypeError instead of tolerating it. Fixed in a287737:
      // every read of the column now goes through the guarded
      // `readKnownSettings`/`asPlainObject` accessors, so this is now a
      // guarantee, not a defect — renamed and un-skipped accordingly.
      it.each([
        ['null', null as unknown],
        ['a string', 'not-an-object' as unknown],
        ['a number', 42 as unknown],
        ['an array', ['a', 'b'] as unknown],
      ])(
        'PATCH tolerates a stored value that is %s and falls back to defaults',
        async (_label, malformed) => {
          mockPrisma.systemSettings.findUnique.mockResolvedValue({
            ...mockSystemSettings,
            value: malformed as any,
          } as any);

          mockPrisma.systemSettings.update.mockResolvedValue({
            ...mockSystemSettings,
            value: {
              ...DEFAULT_SYSTEM_SETTINGS,
              nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
            } as any,
            version: 2,
          } as any);
          mockPrisma.auditEvent.create.mockResolvedValue({} as any);

          const result = await service.patchSettings(
            { nodes: { jobSecretBrokerEnabled: true } },
            mockUserId,
          );

          expect(result).toBeDefined();
          expect(result.jobs).toEqual(DEFAULT_SYSTEM_SETTINGS.jobs);
          expect(result.nodes.jobSecretBrokerEnabled).toBe(true);

          // An array is an object to `typeof` — spreading one would write
          // `{'0':'a'}` into the row. Assert it does not.
          const updateArgs = mockPrisma.systemSettings.update.mock
            .calls[0][0] as any;
          expect(updateArgs.data.value).not.toHaveProperty('0');
          expect(updateArgs.data.value.nodes.jobSecretBrokerEnabled).toBe(true);
        },
      );
    });

    describe('a malformed stored value degrades field by field, not wholesale', () => {
      it('preserves a good nodes value when only jobs is malformed', async () => {
        const storedValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: 'garbage' as unknown,
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: storedValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, stuckThresholdMinutes: 45 },
            nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.patchSettings(
          { jobs: { stuckThresholdMinutes: 45 } },
          mockUserId,
        );

        // The malformed half (jobs) fell back to the default and then took
        // the caller's change; the good half (nodes) survived untouched.
        expect(result.jobs.stuckThresholdMinutes).toBe(45);
        expect(result.nodes).toEqual({
          ...DEFAULT_SYSTEM_SETTINGS.nodes,
          jobSecretBrokerEnabled: true,
        });
      });

      it('preserves a good jobs value when only nodes is malformed', async () => {
        const storedValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, stuckThresholdMinutes: 20 },
          nodes: 'garbage' as unknown,
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: storedValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, stuckThresholdMinutes: 20 },
            nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.patchSettings(
          { nodes: { jobSecretBrokerEnabled: true } },
          mockUserId,
        );

        // The good half (jobs) survived untouched — a whole-object fallback
        // would have silently discarded it along with the malformed
        // nodes value.
        expect(result.jobs.stuckThresholdMinutes).toBe(20);
        expect(result.nodes.jobSecretBrokerEnabled).toBe(true);
      });
    });

    describe('a partly malformed row still preserves unknown keys', () => {
      it('recovers top-level and jobs.* unknown keys from the raw row even when nodes is unusable', async () => {
        const storedValue = {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, extraKnob: 'legacy-value' },
          nodes: 'garbage' as unknown,
          branding: { logoUrl: 'https://example.com/logo.png' },
        };

        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: storedValue as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, extraKnob: 'legacy-value' },
            nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
            branding: { logoUrl: 'https://example.com/logo.png' },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.patchSettings(
          { nodes: { jobSecretBrokerEnabled: true } },
          mockUserId,
        );

        // Preservation reads the RAW row, not the readKnownSettings
        // projection, so the unknown keys survive even though `nodes`
        // itself could not be parsed.
        expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              value: {
                ...OPERATIONS_DEFAULTS,
                jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, extraKnob: 'legacy-value' },
                nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
                notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
                storage: DEFAULT_SYSTEM_SETTINGS.storage,
                ai: DEFAULT_SYSTEM_SETTINGS.ai,
                telemetry: DEFAULT_SYSTEM_SETTINGS.telemetry,
                branding: { logoUrl: 'https://example.com/logo.png' },
              },
            }),
          }),
        );

        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              meta: expect.objectContaining({
                preservedKeys: ['branding', 'jobs.extraKnob'],
              }),
            }),
          }),
        );
      });
    });

    describe('the closed-body rule holds on the error path too', () => {
      it('an unknown key in the PATCH body never reaches storage when the stored value is malformed', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: null as any,
        } as any);

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const dtoWithUnknownKey = {
          nodes: { jobSecretBrokerEnabled: true },
          evilKey: 'should not be stored',
        };

        await service.patchSettings(dtoWithUnknownKey as any, mockUserId);

        const updateArgs = mockPrisma.systemSettings.update.mock
          .calls[0][0] as any;
        expect(updateArgs.data.value).not.toHaveProperty('evilKey');
      });
    });

    describe('request bodies stay closed', () => {
      it('an unknown key in a PUT body never reaches storage', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          value: { ...DEFAULT_SYSTEM_SETTINGS },
        } as any);

        mockPrisma.systemSettings.upsert.mockResolvedValue({
          ...mockSystemSettings,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const dtoWithUnknownKey = {
          nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
          notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
          evilKey: 'should not be stored',
        };

        await service.replaceSettings(dtoWithUnknownKey as any, mockUserId);

        const upsertArgs = mockPrisma.systemSettings.upsert.mock.calls[0][0] as any;
        // Assert on what was actually PERSISTED, not on the return value —
        // the point is that the write itself is clean.
        expect(upsertArgs.update.value).not.toHaveProperty('evilKey');
        expect(upsertArgs.create.value).not.toHaveProperty('evilKey');
      });

      it('an unknown key in a PATCH body never reaches storage', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue(
          mockSystemSettings as any,
        );

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const dtoWithUnknownKey = {
          nodes: { jobSecretBrokerEnabled: true },
          evilKey: 'should not be stored',
        };

        await service.patchSettings(dtoWithUnknownKey as any, mockUserId);

        const updateArgs = mockPrisma.systemSettings.update.mock.calls[0][0] as any;
        expect(updateArgs.data.value).not.toHaveProperty('evilKey');
      });
    });

    describe('audit meta reporting', () => {
      it('omits preservedKeys from the audit meta on a normal patch save', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue(
          mockSystemSettings as any,
        );

        const partialUpdate = { nodes: { jobSecretBrokerEnabled: true } };

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        await service.patchSettings(partialUpdate, mockUserId);

        // Exact match, same contract as "should create audit event on
        // replace" above: an always-present preservedKeys key would litter
        // every audit row, so it must be entirely absent on a normal save.
        expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
          data: {
            actorUserId: mockUserId,
            action: 'system_settings:patch',
            targetType: 'system_settings',
            targetId: mockSystemSettings.id,
            meta: {
              changes: partialUpdate,
              resultingValue: {
                ...OPERATIONS_DEFAULTS,
                nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
                notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
                storage: DEFAULT_SYSTEM_SETTINGS.storage,
                ai: DEFAULT_SYSTEM_SETTINGS.ai,
                telemetry: DEFAULT_SYSTEM_SETTINGS.telemetry,
              },
            } as any,
          },
        });
      });
    });
  });

  // ===========================================================================
  // #366 — the removed `ui`/`features` namespaces. A row written before this
  // change genuinely still carries them on disk, and #130's contract ("the
  // stored value is never narrowed") means they must survive exactly like any
  // other key this build no longer models — following the identical
  // preservation pattern proven above with `branding`/`legacyBlob` — while
  // the RESPONSE, which has never included unmodelled keys, continues to omit
  // them. Symmetrically, a caller that still sends them gets nothing back:
  // they are unknown REQUEST keys, stripped like `evilKey` above, never
  // unknown STORED keys.
  // ===========================================================================
  describe('legacy ui/features namespaces (#366)', () => {
    it('a stored row with legacy ui/features data is preserved on write but never surfaces in the response', async () => {
      const storedValue = {
        ...DEFAULT_SYSTEM_SETTINGS,
        ui: { allowUserThemeOverride: false },
        features: { oldFlag: true },
      };

      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: storedValue as any,
      } as any);

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          jobs: { ...DEFAULT_SYSTEM_SETTINGS.jobs, stuckThresholdMinutes: 45 },
          ui: { allowUserThemeOverride: false },
          features: { oldFlag: true },
        } as any,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.patchSettings(
        { jobs: { stuckThresholdMinutes: 45 } },
        mockUserId,
      );

      // Storage still carries both legacy namespaces forward — the exact
      // #130 guarantee `branding` and `legacyBlob` pin above, applied to the
      // namespaces #366 actually removed.
      expect(mockPrisma.systemSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            value: expect.objectContaining({
              ui: { allowUserThemeOverride: false },
              features: { oldFlag: true },
            }),
          }),
        }),
      );
      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            meta: expect.objectContaining({
              preservedKeys: expect.arrayContaining(['ui', 'features']),
            }),
          }),
        }),
      );

      // But neither is part of the represented resource any more: the
      // response `getSettings`/PUT/PATCH share never surfaces them.
      expect(result).not.toHaveProperty('ui');
      expect(result).not.toHaveProperty('features');
    });

    it('a PUT/PATCH body carrying legacy ui/features keys does not reintroduce them — they are stripped as unknown request keys', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: DEFAULT_SYSTEM_SETTINGS as any,
      } as any);
      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const dtoWithLegacyKeys = {
        ui: { allowUserThemeOverride: false },
        features: { newFlag: true },
      };

      const result = await service.patchSettings(
        dtoWithLegacyKeys as any,
        mockUserId,
      );

      // The stored row had neither key, so nothing is preserved: the merge
      // never reads `dto.ui`/`dto.features` (the service only reads the
      // namespaces `systemSettingsSchema` still declares), so they never
      // reach the persisted value or the response.
      const updateArgs = mockPrisma.systemSettings.update.mock.calls[0][0] as any;
      expect(updateArgs.data.value).not.toHaveProperty('ui');
      expect(updateArgs.data.value).not.toHaveProperty('features');
      expect(result).not.toHaveProperty('ui');
      expect(result).not.toHaveProperty('features');
    });
  });

  // ===========================================================================
  // #148 — `systemSettingsResponseSchema` has always declared `security`, and
  // nothing ever populated it: GET, PUT and PATCH all omitted the key the
  // published OpenAPI contract promised. Fixed by `toResponse`, the one
  // projection now shared by all three methods, and `readSecurityPolicy`,
  // which reads `jwt.accessTtlMinutes` / `jwt.refreshTtlDays` off
  // ConfigService rather than the stored row.
  //
  // Covered on all three methods on purpose, per the bug: one hand-built
  // response shape wrong in three places at once means a test that only
  // covers GET cannot tell you PUT and PATCH are fixed too.
  // ===========================================================================
  describe('security block (#148)', () => {
    async function callGetSettings() {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );
      return service.getSettings();
    }

    async function callReplaceSettings() {
      const newSettings: SystemSettingsValue = {
        ...DEFAULT_SYSTEM_SETTINGS,
        notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
      };
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: DEFAULT_SYSTEM_SETTINGS,
      } as any);
      mockPrisma.systemSettings.upsert.mockResolvedValue({
        ...mockSystemSettings,
        value: newSettings as any,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);
      return service.replaceSettings(newSettings, mockUserId);
    }

    async function callPatchSettings() {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );
      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        value: DEFAULT_SYSTEM_SETTINGS as any,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);
      return service.patchSettings({}, mockUserId);
    }

    const methods: Array<
      [string, () => ReturnType<typeof callGetSettings>]
    > = [
      ['getSettings', callGetSettings],
      ['replaceSettings (PUT)', callReplaceSettings],
      ['patchSettings (PATCH)', callPatchSettings],
    ];

    describe('the values are read from ConfigService, not hardcoded', () => {
      it.each(methods)(
        '%s surfaces the exact non-default numbers ConfigService returns',
        async (_name, call) => {
          mockConfigService.get.mockImplementation(
            (key: string, defaultValue?: unknown) => {
              if (key === 'jwt.accessTtlMinutes') return 45;
              if (key === 'jwt.refreshTtlDays') return 30;
              return defaultValue;
            },
          );

          const result = await call();

          expect(result.security).toEqual({
            jwtAccessTtlMinutes: 45,
            refreshTtlDays: 30,
          });
        },
      );

      it.each(methods)(
        '%s asks ConfigService for the exact keys jwt.accessTtlMinutes and jwt.refreshTtlDays',
        async (_name, call) => {
          mockConfigService.get.mockImplementation(
            (_key: string, defaultValue?: unknown) => defaultValue,
          );

          await call();

          expect(mockConfigService.get).toHaveBeenCalledWith(
            'jwt.accessTtlMinutes',
            15,
          );
          expect(mockConfigService.get).toHaveBeenCalledWith(
            'jwt.refreshTtlDays',
            14,
          );
        },
      );
    });

    describe('the documented defaults (15/14) are used when ConfigService has nothing configured', () => {
      it.each(methods)(
        '%s still returns numbers, never undefined, for a response field typed z.number()',
        async (_name, call) => {
          mockConfigService.get.mockImplementation(
            (_key: string, defaultValue?: unknown) => defaultValue,
          );

          const result = await call();

          expect(result.security).toEqual({
            jwtAccessTtlMinutes: 15,
            refreshTtlDays: 14,
          });
          expect(result.security.jwtAccessTtlMinutes).not.toBeUndefined();
          expect(result.security.refreshTtlDays).not.toBeUndefined();
        },
      );
    });

    describe('it is read-only: a security block in the request body is discarded, not persisted', () => {
      it('replaceSettings (PUT): a submitted security block never reaches the persisted value, and the response still reflects config', async () => {
        mockConfigService.get.mockImplementation(
          (key: string, defaultValue?: unknown) => {
            if (key === 'jwt.accessTtlMinutes') return 45;
            if (key === 'jwt.refreshTtlDays') return 30;
            return defaultValue;
          },
        );
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          value: DEFAULT_SYSTEM_SETTINGS,
        } as any);

        // The malicious/naive body: a client that read the OpenAPI contract
        // and assumed `security` was writable because the DTO declares it.
        const dtoWithSecurity = {
          notifications: DEFAULT_SYSTEM_SETTINGS.notifications,
          security: { jwtAccessTtlMinutes: 9999, refreshTtlDays: 9999 },
        };

        mockPrisma.systemSettings.upsert.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        // Goes through the REAL validation path: systemSettingsSchema.parse
        // inside replaceSettings, exercised exactly as it is in production —
        // not a standalone assertion about what we assume zod does.
        const result = await service.replaceSettings(
          dtoWithSecurity as any,
          mockUserId,
        );

        const upsertArgs = mockPrisma.systemSettings.upsert.mock
          .calls[0][0] as any;
        expect(upsertArgs.update.value).not.toHaveProperty('security');
        expect(upsertArgs.create.value).not.toHaveProperty('security');

        // The response carries config's numbers, not the submitted 9999s.
        expect(result.security).toEqual({
          jwtAccessTtlMinutes: 45,
          refreshTtlDays: 30,
        });
      });

      it('patchSettings (PATCH): a submitted security block never reaches the persisted value, and the response still reflects config', async () => {
        mockConfigService.get.mockImplementation(
          (key: string, defaultValue?: unknown) => {
            if (key === 'jwt.accessTtlMinutes') return 45;
            if (key === 'jwt.refreshTtlDays') return 30;
            return defaultValue;
          },
        );
        mockPrisma.systemSettings.findUnique.mockResolvedValue(
          mockSystemSettings as any,
        );

        const dtoWithSecurity = {
          nodes: { jobSecretBrokerEnabled: true },
          security: { jwtAccessTtlMinutes: 9999, refreshTtlDays: 9999 },
        };

        mockPrisma.systemSettings.update.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            ...DEFAULT_SYSTEM_SETTINGS,
            nodes: { ...DEFAULT_SYSTEM_SETTINGS.nodes, jobSecretBrokerEnabled: true },
          } as any,
          version: 2,
        } as any);
        mockPrisma.auditEvent.create.mockResolvedValue({} as any);

        const result = await service.patchSettings(
          dtoWithSecurity as any,
          mockUserId,
        );

        const updateArgs = mockPrisma.systemSettings.update.mock
          .calls[0][0] as any;
        expect(updateArgs.data.value).not.toHaveProperty('security');

        expect(result.security).toEqual({
          jwtAccessTtlMinutes: 45,
          refreshTtlDays: 30,
        });
      });
    });

    describe('the response satisfies systemSettingsResponseSchema', () => {
      it.each(methods)(
        '%s output parses cleanly through the response schema the OpenAPI contract publishes',
        async (_name, call) => {
          mockConfigService.get.mockImplementation(
            (_key: string, defaultValue?: unknown) => defaultValue,
          );

          const result = await call();

          // Mirror the one normalisation a real HTTP response performs that
          // a plain object does not: `updatedAt` travels the wire as JSON,
          // which turns the Date into the ISO string
          // `systemSettingsResponseSchema` (z.iso.datetime()) declares.
          //
          // `updatedBy.id` is swapped for a real UUID for the same reason:
          // `mockUserId` ('user-123') is a fixture convenience used
          // throughout this file for equality checks, not a value meant to
          // satisfy `z.string().uuid()`. Substituting it here tests the
          // shape this change is responsible for — the security block and
          // the rest of the response — without this fixture's id format
          // being what's under test.
          const serialized = {
            ...result,
            updatedAt: result.updatedAt.toISOString(),
            updatedBy: result.updatedBy && {
              ...result.updatedBy,
              id: '11111111-1111-4111-8111-111111111111',
            },
          };

          expect(() =>
            systemSettingsResponseSchema.parse(serialized),
          ).not.toThrow();
        },
      );
    });
  });

  // ===========================================================================
  // #225, epic #215 — the `notifications` block: a MODELLED gate rather than a
  // key in an open record, so it must survive the same treatment every other
  // namespace gets. Nothing consumes these values yet (#226 adds the
  // enforcement); what is under test here is purely that the row can hold
  // them, degrade gracefully, and stay repairable through the API.
  // ===========================================================================
  describe('notifications block (#225)', () => {
    it('defaults to browser notifications ON with nothing suppressed', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(
        mockSystemSettings as any,
      );

      const result = await service.getSettings();

      expect(result.notifications).toEqual({
        browserEnabled: true,
        disabledEvents: [],
      });
    });

    it('is part of the documented response shape, not just the stored value', async () => {
      // The published contract is what a generated client sees. Asserted
      // against the schema itself rather than a live response because
      // `getSettings` returns a `Date` for `updatedAt` that only becomes the
      // ISO string the schema demands once it is serialised — the end-to-end
      // conformance check lives in the integration suite, over real HTTP.
      expect(systemSettingsResponseSchema.shape.notifications).toBeDefined();

      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        updatedByUser: null,
      } as any);

      const result = await service.getSettings();

      expect(() =>
        systemSettingsResponseSchema.parse({
          ...result,
          updatedAt: result.updatedAt.toISOString(),
        }),
      ).not.toThrow();
    });

    it('PATCH merges the two halves independently: sending one leaves the other stored value alone', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          notifications: {
            browserEnabled: true,
            disabledEvents: ['security.role_changed'],
          },
        } as any,
      } as any);
      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.patchSettings(
        { notifications: { browserEnabled: false } },
        mockUserId,
      );

      const updateArgs = mockPrisma.systemSettings.update.mock
        .calls[0][0] as any;
      expect(updateArgs.data.value.notifications).toEqual({
        browserEnabled: false,
        disabledEvents: ['security.role_changed'],
      });
    });

    it('PATCH REPLACES disabledEvents rather than merging, so a suppression can actually be lifted', async () => {
      // A merging list could only ever grow. Unchecking the last box on the
      // admin page sends `[]`, and `[]` must mean "suppress nothing".
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          notifications: {
            browserEnabled: true,
            disabledEvents: ['security.role_changed', 'user.welcome'],
          },
        } as any,
      } as any);
      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.patchSettings(
        { notifications: { disabledEvents: [] } },
        mockUserId,
      );

      const updateArgs = mockPrisma.systemSettings.update.mock
        .calls[0][0] as any;
      expect(updateArgs.data.value.notifications.disabledEvents).toEqual([]);
      // The half that was not sent is still the stored one.
      expect(updateArgs.data.value.notifications.browserEnabled).toBe(true);
    });

    it.each([
      ['missing entirely', undefined],
      ['a string', 'nope'],
      ['null', null],
      ['an array', ['security.role_changed']],
    ])(
      'degrades a stored notifications block that is %s to the defaults instead of throwing',
      async (_label, malformed) => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
          ...mockSystemSettings,
          value: {
            jobs: DEFAULT_SYSTEM_SETTINGS.jobs,
            nodes: DEFAULT_SYSTEM_SETTINGS.nodes,
            ...(malformed === undefined ? {} : { notifications: malformed }),
          } as any,
        } as any);

        const result = await service.getSettings();

        expect(result.notifications).toEqual({
          browserEnabled: true,
          disabledEvents: [],
        });
      },
    );

    it('drops stored disabledEvents entries the schema would reject, keeping the row repairable', async () => {
      // Same rule as "non-boolean feature values are dropped": carrying an
      // unparseable entry into the merge would turn a damaged row into a
      // ZodError on every save, and only a hand-edit of JSONB could fix it.
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          notifications: {
            browserEnabled: false,
            disabledEvents: [
              'security.role_changed',
              'NOT A KEY',
              42,
              null,
              'user.welcome',
            ],
          },
        } as any,
      } as any);

      const result = await service.getSettings();

      expect(result.notifications).toEqual({
        browserEnabled: false,
        disabledEvents: ['security.role_changed', 'user.welcome'],
      });
    });

    it('does not hand out the shared DEFAULT_SYSTEM_SETTINGS array, which a caller could mutate', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          jobs: DEFAULT_SYSTEM_SETTINGS.jobs,
          nodes: DEFAULT_SYSTEM_SETTINGS.nodes,
        } as any,
      } as any);

      const result = await service.getSettings();

      expect(result.notifications.disabledEvents).not.toBe(
        DEFAULT_SYSTEM_SETTINGS.notifications.disabledEvents,
      );
    });

    it('preserves an unknown key nested under notifications, the second closed nested object', async () => {
      // Exactly the #130 guarantee `jobs.extraKnob` pins above, on the block
      // this issue adds: a rollback across the addition of a sibling key must
      // not destroy it. `notifications` is closed (unlike an open record), so
      // without its own known-key list it would be narrowed on every write.
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          jobs: DEFAULT_SYSTEM_SETTINGS.jobs,
          nodes: DEFAULT_SYSTEM_SETTINGS.nodes,
          notifications: {
            browserEnabled: false,
            disabledEvents: [],
            pushEnabled: true,
          },
        } as any,
      } as any);
      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.patchSettings(
        { nodes: { jobSecretBrokerEnabled: true } },
        mockUserId,
      );

      const updateArgs = mockPrisma.systemSettings.update.mock
        .calls[0][0] as any;
      expect(updateArgs.data.value.notifications.pushEnabled).toBe(true);
      expect(updateArgs.data.value.notifications.browserEnabled).toBe(false);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            meta: expect.objectContaining({
              preservedKeys: ['notifications.pushEnabled'],
            }),
          }),
        }),
      );
    });
  });

  // ===========================================================================
  // AI platform policy (#423, epic #419, umbrella #418)
  // ===========================================================================
  //
  // Schema only: nothing in this build reads `ai.enabled` to gate a route.
  // What is under test here mirrors `getStoragePolicy`'s own coverage —
  // the narrow accessor's defaults, and the nested PATCH merge — plus the
  // guarantee that no API key field can ever reach this row.
  describe('getAiPolicy (#423)', () => {
    it('returns the defaults when no row exists', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);

      const result = await service.getAiPolicy();

      expect(result).toEqual(DEFAULT_SYSTEM_SETTINGS.ai);
      expect(result.enabled).toBe(false);
      expect(result.keyPolicy).toBe('byok');
    });

    it('does not create a row as a side effect of reading the policy', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);

      await service.getAiPolicy();

      expect(mockPrisma.systemSettings.create).not.toHaveBeenCalled();
    });

    it('degrades to the defaults when the stored value is malformed', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: 'not-an-object' as any,
      } as any);

      const result = await service.getAiPolicy();

      expect(result).toEqual(DEFAULT_SYSTEM_SETTINGS.ai);
    });

    it('reads a stored value straight through when it validates', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: {
          ai: {
            enabled: true,
            keyPolicy: 'byok_with_org_fallback',
            providers: { openai: { enabled: true, baseUrl: 'https://proxy.internal/v1' } },
            defaults: { maxOutputTokensCap: 4096, allowBackgroundRuns: false },
            logPromptContent: true,
          },
        } as any,
      } as any);

      const result = await service.getAiPolicy();

      expect(result).toEqual({
        enabled: true,
        keyPolicy: 'byok_with_org_fallback',
        // The row predates the `anthropic` (#446) and `gemini` (#447) slots:
        // each takes its default, and the stored OpenAI slot survives untouched.
        providers: {
          openai: { enabled: true, baseUrl: 'https://proxy.internal/v1' },
          anthropic: { enabled: false },
          gemini: { enabled: false },
          'azure-openai': { enabled: false },
          'openai-compatible': { enabled: false },
        },
        // `allowRealtime` is absent from the stored row (written before #449):
        // it reads as `false`, and the cap and switch beside it survive.
        defaults: { maxOutputTokensCap: 4096, allowBackgroundRuns: false, allowRealtime: false },
        logPromptContent: true,
        // Absent from the stored row (written before #443) -> the default,
        // without disturbing any sibling field.
        usageRetentionDays: 180,
        hostedTools: {
          web_search: false,
          file_search: false,
          code_interpreter: false,
          image_generation: false,
          mcp: false,
          mcpAllowedHosts: [],
        },
        // Absent from the stored row (written before #450) -> no limits.
        limits: {},
      });
    });

    it('degrades a corrupt ai.limits to {} (unlimited) without touching its siblings (#450)', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: {
          ai: {
            ...DEFAULT_SYSTEM_SETTINGS.ai,
            enabled: true,
            limits: { perUser: { requestsPerMinute: -1 } },
          },
        } as any,
      } as any);

      const result = await service.getAiPolicy();

      expect(result.limits).toEqual({});
      expect(result.enabled).toBe(true);
    });
  });

  describe('ai.providers is salvaged per provider (#446)', () => {
    it('keeps a valid slot when a sibling slot is damaged', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: {
          ai: {
            enabled: true,
            providers: {
              openai: { enabled: true, baseUrl: 'https://proxy.internal/v1' },
              anthropic: { enabled: 'yes', baseUrl: 42 },
            },
          },
        } as any,
      } as any);

      const result = await service.getAiPolicy();

      expect(result.enabled).toBe(true);
      expect(result.providers).toEqual({
        openai: { enabled: true, baseUrl: 'https://proxy.internal/v1' },
        anthropic: { enabled: false },
        gemini: { enabled: false },
        'azure-openai': { enabled: false },
        'openai-compatible': { enabled: false },
      });
    });

    it('salvages defaults field by field: a damaged allowRealtime costs nothing beside it (#449)', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: {
          ai: {
            enabled: true,
            keyPolicy: 'byok',
            providers: { openai: { enabled: true } },
            defaults: { maxOutputTokensCap: 1024, allowBackgroundRuns: false, allowRealtime: 'yes' },
            logPromptContent: false,
          },
        } as any,
      } as any);

      const result = await service.getAiPolicy();

      expect(result.defaults).toEqual({ maxOutputTokensCap: 1024, allowBackgroundRuns: false, allowRealtime: false });
    });

    it('reads a stored allowRealtime: true straight through (#449)', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: {
          ai: {
            enabled: true,
            keyPolicy: 'byok',
            providers: { openai: { enabled: true } },
            defaults: { allowBackgroundRuns: true, allowRealtime: true },
            logPromptContent: false,
          },
        } as any,
      } as any);

      const result = await service.getAiPolicy();

      expect(result.defaults).toEqual({ allowBackgroundRuns: true, allowRealtime: true });
      expect(result.defaults).not.toHaveProperty('maxOutputTokensCap');
    });

    it('keeps a stored anthropic slot and drops an unknown provider key', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: {
          ai: {
            providers: {
              anthropic: { enabled: true, baseUrl: 'https://anthropic-gw.internal' },
              someday: { enabled: true },
            },
          },
        } as any,
      } as any);

      const result = await service.getAiPolicy();

      expect(result.providers).toEqual({
        openai: { enabled: false },
        anthropic: { enabled: true, baseUrl: 'https://anthropic-gw.internal' },
        gemini: { enabled: false },
        'azure-openai': { enabled: false },
        'openai-compatible': { enabled: false },
      });
    });

    it('keeps a stored gemini slot beside its siblings (#447)', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: {
          ai: {
            providers: {
              openai: { enabled: true },
              gemini: { enabled: true, baseUrl: 'https://gemini-gw.internal' },
            },
          },
        } as any,
      } as any);

      const result = await service.getAiPolicy();

      expect(result.providers).toEqual({
        openai: { enabled: true },
        anthropic: { enabled: false },
        gemini: { enabled: true, baseUrl: 'https://gemini-gw.internal' },
        'azure-openai': { enabled: false },
        'openai-compatible': { enabled: false },
      });
    });

    it('keeps valid #448 slots and resets one that fails its own endpoint rules (#448)', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: {
          ai: {
            providers: {
              openai: { enabled: true },
              'azure-openai': {
                enabled: true,
                baseUrl: 'https://contoso.openai.azure.com',
                apiVersion: '2025-04-01-preview',
                apiStyle: 'chat_completions',
                deployments: { 'gpt-4o': 'prod-4o' },
              },
              // Plain http is refused for Azure; the slot falls back to its default.
              'openai-compatible': { enabled: true, baseUrl: 'http://user:pw@ollama.internal:11434/v1' },
            },
          },
        } as any,
      } as any);

      const result = await service.getAiPolicy();

      expect(result.providers['azure-openai']).toEqual({
        enabled: true,
        baseUrl: 'https://contoso.openai.azure.com',
        apiVersion: '2025-04-01-preview',
        apiStyle: 'chat_completions',
        deployments: { 'gpt-4o': 'prod-4o' },
      });
      // Credentials embedded in the URL: the whole slot resets to its default.
      expect(result.providers['openai-compatible']).toEqual({ enabled: false });
      expect(result.providers.openai).toEqual({ enabled: true });
    });
  });

  describe('PATCH merges ai.providers.openai.enabled without clobbering its siblings (#423)', () => {
    beforeEach(() => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          ai: {
            enabled: true,
            keyPolicy: 'byok',
            providers: {
              openai: { enabled: false, baseUrl: 'https://proxy.internal/v1' },
            },
            defaults: { maxOutputTokensCap: 2048, allowBackgroundRuns: true },
            logPromptContent: false,
          },
        } as any,
      } as any);

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);
    });

    /** The `ai` block that actually reached Prisma. */
    function writtenAi(): Record<string, unknown> {
      expect(mockPrisma.systemSettings.update).toHaveBeenCalledTimes(1);

      const call = mockPrisma.systemSettings.update.mock.calls[0][0] as {
        data: { value: { ai: Record<string, unknown> } };
      };

      return call.data.value.ai;
    }

    it('flips providers.openai.enabled while leaving baseUrl, defaults and enabled untouched', async () => {
      await service.patchSettings(
        { ai: { providers: { openai: { enabled: true } } } },
        mockUserId,
      );

      const ai = writtenAi() as any;
      expect(ai.providers.openai.enabled).toBe(true);
      expect(ai.providers.openai.baseUrl).toBe('https://proxy.internal/v1');
      expect(ai.defaults).toEqual({
        maxOutputTokensCap: 2048,
        allowBackgroundRuns: true,
        allowRealtime: false,
      });
      expect(ai.enabled).toBe(true);
      expect(ai.keyPolicy).toBe('byok');
      expect(ai.logPromptContent).toBe(false);
    });

    it('enables providers.anthropic on a row that predates the slot, leaving openai untouched (#446)', async () => {
      await service.patchSettings(
        { ai: { providers: { anthropic: { enabled: true, baseUrl: 'https://anthropic-gw.internal' } } } },
        mockUserId,
      );

      const ai = writtenAi() as any;
      expect(ai.providers.anthropic).toEqual({ enabled: true, baseUrl: 'https://anthropic-gw.internal' });
      expect(ai.providers.openai).toEqual({ enabled: false, baseUrl: 'https://proxy.internal/v1' });
    });

    it('enables providers.gemini on a row that predates the slot, leaving the others untouched (#447)', async () => {
      await service.patchSettings(
        { ai: { providers: { gemini: { enabled: true, baseUrl: 'https://gemini-gw.internal' } } } },
        mockUserId,
      );

      const ai = writtenAi() as any;
      expect(ai.providers.gemini).toEqual({ enabled: true, baseUrl: 'https://gemini-gw.internal' });
      expect(ai.providers.openai).toEqual({ enabled: false, baseUrl: 'https://proxy.internal/v1' });
      expect(ai.providers.anthropic).toEqual({ enabled: false, baseUrl: undefined });
    });

    it('merges the #448 slots field by field: null removes, deployments replace whole (#448)', async () => {
      await service.patchSettings(
        {
          ai: {
            providers: {
              'azure-openai': {
                enabled: true,
                baseUrl: 'https://contoso.openai.azure.com',
                deployments: { 'gpt-4o': 'prod-4o' },
              },
              'openai-compatible': { baseUrl: 'http://ollama.internal:11434/v1', requiresKey: false },
            },
          },
        },
        mockUserId,
      );

      const ai = writtenAi() as any;
      expect(ai.providers['azure-openai']).toEqual({
        enabled: true,
        baseUrl: 'https://contoso.openai.azure.com',
        apiVersion: undefined,
        apiStyle: undefined,
        deployments: { 'gpt-4o': 'prod-4o' },
      });
      expect(ai.providers['openai-compatible']).toEqual({
        enabled: false,
        baseUrl: 'http://ollama.internal:11434/v1',
        apiStyle: undefined,
        requiresKey: false,
      });
      expect(ai.providers.openai).toEqual({ enabled: false, baseUrl: 'https://proxy.internal/v1' });
    });

    it('merges one hostedTools switch, defaulting the rest when the stored row predates them (#442)', async () => {
      await service.patchSettings({ ai: { hostedTools: { web_search: true } } }, mockUserId);

      const ai = writtenAi() as any;
      expect(ai.hostedTools).toEqual({
        web_search: true,
        file_search: false,
        code_interpreter: false,
        image_generation: false,
        mcp: false,
        mcpAllowedHosts: [],
      });
      expect(ai.providers.openai.baseUrl).toBe('https://proxy.internal/v1');
    });

    it('replaces hostedTools.mcpAllowedHosts wholesale and leaves the switches alone (#442)', async () => {
      await service.patchSettings(
        { ai: { hostedTools: { mcp: true, mcpAllowedHosts: ['mcp.example.com', '*.tools.example.org'] } } },
        mockUserId,
      );

      const ai = writtenAi() as any;
      expect(ai.hostedTools).toMatchObject({
        web_search: false,
        mcp: true,
        mcpAllowedHosts: ['mcp.example.com', '*.tools.example.org'],
      });
    });

    it('refuses a malformed MCP host entry (#442)', async () => {
      await expect(
        service.patchSettings({ ai: { hostedTools: { mcpAllowedHosts: ['https://mcp.example.com/'] } } } as any, mockUserId),
      ).rejects.toThrow();
      expect(mockPrisma.systemSettings.update).not.toHaveBeenCalled();
    });

    it('defaults limits to {} (unlimited) when the stored row predates them (#450)', async () => {
      await service.patchSettings({ ai: { enabled: false } }, mockUserId);

      expect((writtenAi() as any).limits).toEqual({});
    });

    it('replaces ai.limits WHOLESALE — the submitted object is the new value (#450)', async () => {
      await service.patchSettings(
        {
          ai: {
            limits: {
              perUser: { requestsPerMinute: 10 },
              perModel: { 'openai:gpt-4.1-mini': { maxOutputTokens: 512 } },
            },
          },
        },
        mockUserId,
      );
      expect((writtenAi() as any).limits).toEqual({
        perUser: { requestsPerMinute: 10 },
        perModel: { 'openai:gpt-4.1-mini': { maxOutputTokens: 512 } },
      });

      // A second PATCH naming only orgKey drops the rest: absent = unlimited.
      mockPrisma.systemSettings.update.mockClear();
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          ai: { ...DEFAULT_SYSTEM_SETTINGS.ai, limits: { perUser: { requestsPerMinute: 10 } } },
        } as any,
      } as any);

      await service.patchSettings({ ai: { limits: { orgKey: { tokensPerDayPerUser: 50_000 } } } }, mockUserId);

      expect((writtenAi() as any).limits).toEqual({ orgKey: { tokensPerDayPerUser: 50_000 } });
    });

    it('keeps the stored limits when a PATCH does not name them (#450)', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          ai: { ...DEFAULT_SYSTEM_SETTINGS.ai, limits: { perUser: { requestsPerDay: 99 } } },
        } as any,
      } as any);

      await service.patchSettings({ ai: { logPromptContent: true } }, mockUserId);

      expect((writtenAi() as any).limits).toEqual({ perUser: { requestsPerDay: 99 } });
    });

    it.each([
      ['a zero limit', { perUser: { requestsPerMinute: 0 } }],
      ['a per-model key with no provider', { perModel: { 'gpt-4.1-mini': { maxOutputTokens: 1 } } }],
    ])('refuses %s (#450)', async (_name, limits) => {
      await expect(service.patchSettings({ ai: { limits } } as any, mockUserId)).rejects.toThrow();
      expect(mockPrisma.systemSettings.update).not.toHaveBeenCalled();
    });

    it('merges a defaults field without touching providers', async () => {
      await service.patchSettings(
        { ai: { defaults: { allowBackgroundRuns: false } } },
        mockUserId,
      );

      const ai = writtenAi() as any;
      expect(ai.defaults).toEqual({
        maxOutputTokensCap: 2048,
        allowBackgroundRuns: false,
        allowRealtime: false,
      });
      expect(ai.providers).toEqual({
        openai: { enabled: false, baseUrl: 'https://proxy.internal/v1' },
        anthropic: { enabled: false, baseUrl: undefined },
        gemini: { enabled: false, baseUrl: undefined },
        'azure-openai': { enabled: false, baseUrl: undefined, apiVersion: undefined, apiStyle: undefined, deployments: undefined },
        'openai-compatible': { enabled: false, baseUrl: undefined, apiStyle: undefined, requiresKey: undefined },
      });
    });

    it('switches defaults.allowRealtime on without touching the cap or allowBackgroundRuns (#449)', async () => {
      await service.patchSettings(
        { ai: { defaults: { allowRealtime: true } } },
        mockUserId,
      );

      const ai = writtenAi() as any;
      expect(ai.defaults).toEqual({
        maxOutputTokensCap: 2048,
        allowBackgroundRuns: true,
        allowRealtime: true,
      });
    });

    it('removes providers.openai.baseUrl when the patch sends null (#428)', async () => {
      await service.patchSettings(
        { ai: { providers: { openai: { baseUrl: null } } } },
        mockUserId,
      );

      const ai = writtenAi() as any;
      expect(ai.providers.openai).toEqual({ enabled: false });
      expect(JSON.parse(JSON.stringify(ai)).providers.openai).not.toHaveProperty('baseUrl');
      // Siblings untouched.
      expect(ai.defaults.maxOutputTokensCap).toBe(2048);
    });

    it('removes defaults.maxOutputTokensCap when the patch sends null (#428)', async () => {
      await service.patchSettings(
        { ai: { defaults: { maxOutputTokensCap: null } } },
        mockUserId,
      );

      const ai = writtenAi() as any;
      expect(ai.defaults).toEqual({ allowBackgroundRuns: true, allowRealtime: false });
      expect(ai.providers.openai.baseUrl).toBe('https://proxy.internal/v1');
    });

    it.each([
      ['wire DTO', patchSystemSettingsSchema],
      ['canonical patch schema', systemSettingsPatchSchema],
    ] as const)('%s accepts null for the two optional ai fields (#428)', (_name, schema) => {
      const body = {
        ai: { providers: { openai: { baseUrl: null } }, defaults: { maxOutputTokensCap: null } },
      };

      expect(schema.parse(body)).toEqual(body);
      // A required field still refuses null.
      expect(schema.safeParse({ ai: { enabled: null } }).success).toBe(false);
    });

    it('replaces an optional field with a new value, and keeps it when absent', async () => {
      await service.patchSettings(
        {
          ai: {
            providers: { openai: { baseUrl: 'https://other.internal/v1' } },
            defaults: { allowBackgroundRuns: false },
          },
        },
        mockUserId,
      );

      const ai = writtenAi() as any;
      expect(ai.providers.openai.baseUrl).toBe('https://other.internal/v1');
      expect(ai.defaults.maxOutputTokensCap).toBe(2048);
    });

    it('carries no API key field through the merge, whatever the caller sends', async () => {
      // `patchSystemSettingsSchema` strips any key it does not declare
      // before the service ever sees the body — asserted here on the actual
      // write, not merely on the schema, so a future refactor of the merge
      // itself would also be caught.
      await service.patchSettings(
        {
          ai: { enabled: true },
          evilApiKey: 'sk-should-not-be-stored',
        } as any,
        mockUserId,
      );

      const ai = writtenAi();
      expect(ai).not.toHaveProperty('apiKey');
      expect(ai).not.toHaveProperty('secret');
      expect(ai).not.toHaveProperty('evilApiKey');
    });
  });

  describe('getTelemetryPolicy (epic #528, story #533)', () => {
    it('returns the defaults when no row exists', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);

      const result = await service.getTelemetryPolicy();

      expect(result).toEqual(DEFAULT_SYSTEM_SETTINGS.telemetry);
      expect(result.enabled).toBe(false);
      expect(result.assistant.enabled).toBe(false);
    });

    it('does not create a row as a side effect of reading the policy', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue(null);

      await service.getTelemetryPolicy();

      expect(mockPrisma.systemSettings.create).not.toHaveBeenCalled();
    });

    it('degrades to the defaults when the stored value is malformed', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: 'not-an-object' as any,
      } as any);

      const result = await service.getTelemetryPolicy();

      expect(result).toEqual(DEFAULT_SYSTEM_SETTINGS.telemetry);
    });

    it('reads a stored value straight through when it validates (a legacy row that predates the namespace)', async () => {
      // A row written before this namespace existed has no `telemetry` key at
      // all — `readKnownSettings` must still answer with the full shape,
      // defaults throughout, rather than throwing or leaving fields absent.
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          telemetry: undefined,
        } as any,
      } as any);

      const result = await service.getTelemetryPolicy();

      expect(result).toEqual(DEFAULT_SYSTEM_SETTINGS.telemetry);
    });

    it('reads a fully-configured stored value straight through', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: {
          telemetry: {
            enabled: true,
            retentionDays: 90,
            query: { maxRows: 500, timeoutSeconds: 10 },
            assistant: {
              enabled: true,
              provider: 'openai',
              modelId: 'gpt-5',
              shareResults: false,
              maxResultRowsToModel: 50,
              maxSteps: 3,
            },
          },
        } as any,
      } as any);

      const result = await service.getTelemetryPolicy();

      expect(result).toEqual({
        enabled: true,
        retentionDays: 90,
        // #565: this stored row predates `instanceId`, so it reads back as the
        // `null` default ("follow APP_SLUG") — no migration.
        instanceId: null,
        query: { maxRows: 500, timeoutSeconds: 10 },
        assistant: {
          enabled: true,
          provider: 'openai',
          modelId: 'gpt-5',
          shareResults: false,
          maxResultRowsToModel: 50,
          maxSteps: 3,
        },
      });
    });

    it('reads a stored instanceId straight through, and a malformed one as the null default (#565)', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: { telemetry: { ...DEFAULT_SYSTEM_SETTINGS.telemetry, instanceId: 'prod-eu' } } as any,
      } as any);
      await expect(service.getTelemetryPolicy()).resolves.toMatchObject({ instanceId: 'prod-eu' });

      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: {
          telemetry: { ...DEFAULT_SYSTEM_SETTINGS.telemetry, enabled: true, instanceId: 'NOT OK' },
        } as any,
      } as any);
      const result = await service.getTelemetryPolicy();
      expect(result.instanceId).toBeNull();
      expect(result.enabled).toBe(true);
    });

    it('salvages field by field: a malformed assistant block degrades without disturbing enabled/retentionDays beside it', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        value: {
          telemetry: {
            enabled: true,
            retentionDays: 90,
            query: { maxRows: 500, timeoutSeconds: 10 },
            assistant: { enabled: 'not-a-boolean', maxSteps: -1 },
          },
        } as any,
      } as any);

      const result = await service.getTelemetryPolicy();

      expect(result.enabled).toBe(true);
      expect(result.retentionDays).toBe(90);
      expect(result.query).toEqual({ maxRows: 500, timeoutSeconds: 10 });
      expect(result.assistant).toEqual(DEFAULT_SYSTEM_SETTINGS.telemetry.assistant);
    });
  });

  describe('PATCH merges telemetry without clobbering its siblings (epic #528, story #533)', () => {
    beforeEach(() => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          telemetry: {
            enabled: true,
            retentionDays: 90,
            query: { maxRows: 500, timeoutSeconds: 10 },
            assistant: {
              enabled: true,
              provider: 'openai',
              modelId: 'gpt-5',
              shareResults: false,
              maxResultRowsToModel: 50,
              maxSteps: 3,
            },
          },
        } as any,
      } as any);

      mockPrisma.systemSettings.update.mockResolvedValue({
        ...mockSystemSettings,
        version: 2,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);
    });

    /** The `telemetry` block that actually reached Prisma. */
    function writtenTelemetry(): Record<string, unknown> {
      expect(mockPrisma.systemSettings.update).toHaveBeenCalledTimes(1);

      const call = mockPrisma.systemSettings.update.mock.calls[0][0] as {
        data: { value: { telemetry: Record<string, unknown> } };
      };

      return call.data.value.telemetry;
    }

    it('flips enabled while leaving retentionDays, query and assistant untouched', async () => {
      await service.patchSettings({ telemetry: { enabled: false } }, mockUserId);

      const telemetry = writtenTelemetry() as any;
      expect(telemetry.enabled).toBe(false);
      expect(telemetry.retentionDays).toBe(90);
      expect(telemetry.query).toEqual({ maxRows: 500, timeoutSeconds: 10 });
      expect(telemetry.assistant).toEqual({
        enabled: true,
        provider: 'openai',
        modelId: 'gpt-5',
        shareResults: false,
        maxResultRowsToModel: 50,
        maxSteps: 3,
      });
    });

    it('merges query.maxRows alone, leaving query.timeoutSeconds untouched', async () => {
      await service.patchSettings(
        { telemetry: { query: { maxRows: 999 } } },
        mockUserId,
      );

      const telemetry = writtenTelemetry() as any;
      expect(telemetry.query).toEqual({ maxRows: 999, timeoutSeconds: 10 });
    });

    it('sets instanceId, leaving everything else untouched (#565)', async () => {
      await service.patchSettings({ telemetry: { instanceId: 'prod-eu' } }, mockUserId);

      const telemetry = writtenTelemetry() as any;
      expect(telemetry.instanceId).toBe('prod-eu');
      expect(telemetry.enabled).toBe(true);
      expect(telemetry.retentionDays).toBe(90);
    });

    it('resolves a stored row without instanceId to null, and keeps it when the patch omits it (#565)', async () => {
      await service.patchSettings({ telemetry: { enabled: false } }, mockUserId);

      expect((writtenTelemetry() as any).instanceId).toBeNull();
    });

    it('clears instanceId back to null with an explicit null (#565)', async () => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        ...mockSystemSettings,
        value: {
          ...DEFAULT_SYSTEM_SETTINGS,
          telemetry: { ...DEFAULT_SYSTEM_SETTINGS.telemetry, instanceId: 'prod-eu' },
        } as any,
      } as any);

      await service.patchSettings({ telemetry: { instanceId: null } }, mockUserId);

      expect((writtenTelemetry() as any).instanceId).toBeNull();
    });

    it('clears assistant.provider with an explicit null, distinct from omitting it', async () => {
      await service.patchSettings(
        { telemetry: { assistant: { provider: null } } },
        mockUserId,
      );

      const telemetry = writtenTelemetry() as any;
      expect(telemetry.assistant.provider).toBeNull();
      // Untouched siblings, including modelId, survive the clear.
      expect(telemetry.assistant.modelId).toBe('gpt-5');
      expect(telemetry.assistant.enabled).toBe(true);
    });

    it('leaves assistant.provider alone when the patch omits it', async () => {
      await service.patchSettings(
        { telemetry: { assistant: { enabled: false } } },
        mockUserId,
      );

      const telemetry = writtenTelemetry() as any;
      expect(telemetry.assistant.provider).toBe('openai');
      expect(telemetry.assistant.enabled).toBe(false);
    });

    it('carries no credential field through the merge, whatever the caller sends', async () => {
      await service.patchSettings(
        {
          telemetry: { enabled: true },
          evilApiKey: 'sk-should-not-be-stored',
        } as any,
        mockUserId,
      );

      const telemetry = writtenTelemetry();
      expect(telemetry).not.toHaveProperty('apiKey');
      expect(telemetry).not.toHaveProperty('secret');
      expect(telemetry).not.toHaveProperty('evilApiKey');
    });
  });
});
