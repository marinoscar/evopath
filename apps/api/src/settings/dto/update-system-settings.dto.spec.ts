import {
  updateSystemSettingsSchema,
  patchSystemSettingsSchema,
} from './update-system-settings.dto';
import { MAX_DISABLED_NOTIFICATION_EVENTS } from '../../common/schemas/settings.schema';

/**
 * The `notifications` block every PUT body must now carry (#225).
 *
 * Spread into cases exercising other namespaces rather than made optional in
 * the schema: a PUT is a full replacement, and letting the block default would
 * mean an old client's PUT silently re-enables a delivery channel an operator
 * turned off. Keeping it here as a constant is what lets each of those cases go
 * on asserting the ONE thing it was written to assert.
 */
const NOTIFICATIONS = {
  browserEnabled: true,
  disabledEvents: [] as string[],
};

/**
 * A valid `jobs` namespace body (#256, epic #254), used below wherever a test
 * needs "some other real, currently-modelled namespace" — the role `ui` used
 * to play before #366 removed it.
 */
const JOBS = {
  history: { retentionDays: 30, purgeEnabled: true },
  stuckThresholdMinutes: 30,
};

/** A valid `nodes` namespace body, playing the role `features` used to. */
const NODES = {
  staleHeartbeatSeconds: 90,
  offlineStaleMultiplier: 4,
  offlineRetentionDays: 30,
  jobSecretBrokerEnabled: false,
};

describe('UpdateSystemSettingsDto (PUT)', () => {
  describe('jobs field', () => {
    it('should accept a valid jobs settings object', () => {
      const result = updateSystemSettingsSchema.parse({
        jobs: JOBS,
        notifications: NOTIFICATIONS,
      });

      expect(result.jobs).toEqual(JOBS);
    });

    it('should accept a different stuckThresholdMinutes value', () => {
      const result = updateSystemSettingsSchema.parse({
        jobs: { ...JOBS, stuckThresholdMinutes: 120 },
        notifications: NOTIFICATIONS,
      });

      expect(result.jobs?.stuckThresholdMinutes).toBe(120);
    });

    it('should reject a jobs object missing its required nested fields', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          jobs: {},
          notifications: NOTIFICATIONS,
        }),
      ).toThrow();
    });

    it('should reject a non-boolean purgeEnabled', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          jobs: {
            history: { retentionDays: 30, purgeEnabled: 'true' },
            stuckThresholdMinutes: 30,
          },
          notifications: NOTIFICATIONS,
        }),
      ).toThrow();
    });

    it('should make the jobs field optional on a PUT body', () => {
      // Unlike `notifications`, `jobs` ships ahead of every consumer (#256),
      // so a PUT that omits it must not 400 — `replaceSettings` carries the
      // stored value forward instead. See update-system-settings.dto.ts.
      expect(() =>
        updateSystemSettingsSchema.parse({
          notifications: NOTIFICATIONS,
        }),
      ).not.toThrow();
    });
  });

  describe('nodes field', () => {
    it('should accept a valid nodes settings object', () => {
      const result = updateSystemSettingsSchema.parse({
        nodes: NODES,
        notifications: NOTIFICATIONS,
      });

      expect(result.nodes).toEqual(NODES);
    });

    it('should accept jobSecretBrokerEnabled set to true', () => {
      const result = updateSystemSettingsSchema.parse({
        nodes: { ...NODES, jobSecretBrokerEnabled: true },
        notifications: NOTIFICATIONS,
      });

      expect(result.nodes?.jobSecretBrokerEnabled).toBe(true);
    });

    it('should reject a nodes object with a non-boolean jobSecretBrokerEnabled', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          nodes: { ...NODES, jobSecretBrokerEnabled: 'yes' },
          notifications: NOTIFICATIONS,
        }),
      ).toThrow();
    });

    it('should require nodes.staleHeartbeatSeconds when nodes is provided', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          nodes: {
            offlineStaleMultiplier: 4,
            offlineRetentionDays: 30,
            jobSecretBrokerEnabled: false,
          },
          notifications: NOTIFICATIONS,
        }),
      ).toThrow();
    });

    it('should make the nodes field optional on a PUT body', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          notifications: NOTIFICATIONS,
        }),
      ).not.toThrow();
    });
  });

  /**
   * Issue #225, epic #215. The block is MODELLED — a real object with a real
   * type — so it gets real validation, which is what these cases pin.
   */
  describe('notifications field', () => {
    it('accepts the block with browser notifications on and nothing suppressed', () => {
      const result = updateSystemSettingsSchema.parse({
        jobs: JOBS,
        notifications: { browserEnabled: true, disabledEvents: [] },
      });

      expect(result.notifications).toEqual({
        browserEnabled: true,
        disabledEvents: [],
      });
    });

    it('accepts a list of event keys to suppress', () => {
      const result = updateSystemSettingsSchema.parse({
        jobs: JOBS,
        notifications: {
          browserEnabled: false,
          disabledEvents: ['security.role_changed', 'user.welcome'],
        },
      });

      expect(result.notifications.disabledEvents).toEqual([
        'security.role_changed',
        'user.welcome',
      ]);
    });

    it('is REQUIRED: a body that omits it is rejected rather than defaulted', () => {
      // The whole point of requiring it. A PUT from a client that predates the
      // block would otherwise reset `browserEnabled` to `true` — silently
      // undoing an operator's decision to turn the channel off.
      expect(() =>
        updateSystemSettingsSchema.parse({
          jobs: JOBS,
        }),
      ).toThrow();
    });

    it('rejects a non-boolean browserEnabled', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          jobs: JOBS,
          notifications: { browserEnabled: 'yes', disabledEvents: [] },
        }),
      ).toThrow();
    });

    it('rejects an event key that breaks the <area>.<event> shape', () => {
      // Same syntactic bound the per-user preference keys use — an uppercase
      // segment is not a key the registry can produce.
      expect(() =>
        updateSystemSettingsSchema.parse({
          jobs: JOBS,
          notifications: {
            browserEnabled: true,
            disabledEvents: ['Security.Role_Changed'],
          },
        }),
      ).toThrow();
    });

    it('rejects an empty-string event key', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          jobs: JOBS,
          notifications: { browserEnabled: true, disabledEvents: [''] },
        }),
      ).toThrow();
    });

    it('rejects a non-string entry', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          jobs: JOBS,
          notifications: { browserEnabled: true, disabledEvents: [42] },
        }),
      ).toThrow();
    });

    it('caps the list, so an unbounded array cannot be written into the row', () => {
      const overCap = Array.from(
        { length: MAX_DISABLED_NOTIFICATION_EVENTS + 1 },
        (_, index) => `area.event_${index}`,
      );

      expect(() =>
        updateSystemSettingsSchema.parse({
          jobs: JOBS,
          notifications: { browserEnabled: true, disabledEvents: overCap },
        }),
      ).toThrow();

      expect(() =>
        updateSystemSettingsSchema.parse({
          jobs: JOBS,
          notifications: {
            browserEnabled: true,
            disabledEvents: overCap.slice(0, MAX_DISABLED_NOTIFICATION_EVENTS),
          },
        }),
      ).not.toThrow();
    });
  });

  describe('legacy ui/features keys (#366)', () => {
    // The two namespaces removed by #366. A caller that still sends them
    // (an old client, a stale bookmarked request) must not have them
    // reappear anywhere in the parsed result — they are unknown REQUEST
    // keys now, stripped by the schema exactly like any other unrecognised
    // field, never carried through like an unknown STORED key would be.
    it('strips a legacy ui key from a PUT body instead of validating or echoing it', () => {
      const result = updateSystemSettingsSchema.parse({
        ui: { allowUserThemeOverride: true },
        notifications: NOTIFICATIONS,
      });

      expect(result).not.toHaveProperty('ui');
    });

    it('strips a legacy features key from a PUT body instead of validating or echoing it', () => {
      const result = updateSystemSettingsSchema.parse({
        features: { anyFlag: true },
        notifications: NOTIFICATIONS,
      });

      expect(result).not.toHaveProperty('features');
    });
  });

  describe('telemetry field (epic #528, story #533)', () => {
    const TELEMETRY = {
      enabled: true,
      retentionDays: 30,
      instanceId: null as string | null,
      query: { maxRows: 10000, timeoutSeconds: 30 },
      assistant: {
        enabled: false,
        provider: null as string | null,
        modelId: null as string | null,
        shareResults: true,
        maxResultRowsToModel: 100,
        maxSteps: 6,
      },
    };

    it('should accept a valid telemetry settings object', () => {
      const result = updateSystemSettingsSchema.parse({
        telemetry: TELEMETRY,
        notifications: NOTIFICATIONS,
      });

      expect(result.telemetry).toEqual(TELEMETRY);
    });

    it('should make the telemetry field optional on a PUT body', () => {
      // Ships ahead of every consumer, like `jobs`/`ai` above: a PUT that
      // omits it must not 400 — `replaceSettings` carries the stored value
      // forward instead.
      expect(() =>
        updateSystemSettingsSchema.parse({
          notifications: NOTIFICATIONS,
        }),
      ).not.toThrow();
    });

    it('should reject a retentionDays of 0', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          telemetry: { ...TELEMETRY, retentionDays: 0 },
          notifications: NOTIFICATIONS,
        }),
      ).toThrow();
    });

    it('should reject a retentionDays over 3650', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          telemetry: { ...TELEMETRY, retentionDays: 3651 },
          notifications: NOTIFICATIONS,
        }),
      ).toThrow();
    });

    it('should reject a query.maxRows over 100000', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          telemetry: {
            ...TELEMETRY,
            query: { ...TELEMETRY.query, maxRows: 100001 },
          },
          notifications: NOTIFICATIONS,
        }),
      ).toThrow();
    });

    it('should reject an assistant.maxResultRowsToModel over 100', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          telemetry: {
            ...TELEMETRY,
            assistant: { ...TELEMETRY.assistant, maxResultRowsToModel: 101 },
          },
          notifications: NOTIFICATIONS,
        }),
      ).toThrow();
    });

    it('should accept an assistant.maxSteps of 20', () => {
      const result = updateSystemSettingsSchema.parse({
        telemetry: {
          ...TELEMETRY,
          assistant: { ...TELEMETRY.assistant, maxSteps: 20 },
        },
        notifications: NOTIFICATIONS,
      });

      expect(result.telemetry?.assistant.maxSteps).toBe(20);
    });

    it('should reject an assistant.maxSteps over 20', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          telemetry: {
            ...TELEMETRY,
            assistant: { ...TELEMETRY.assistant, maxSteps: 21 },
          },
          notifications: NOTIFICATIONS,
        }),
      ).toThrow();
    });

    it('should accept a nullable assistant.provider/modelId', () => {
      const result = updateSystemSettingsSchema.parse({
        telemetry: {
          ...TELEMETRY,
          assistant: { ...TELEMETRY.assistant, provider: 'openai', modelId: 'gpt-5' },
        },
        notifications: NOTIFICATIONS,
      });

      expect(result.telemetry?.assistant.provider).toBe('openai');
      expect(result.telemetry?.assistant.modelId).toBe('gpt-5');
    });

    it('should accept an instanceId override (#565)', () => {
      const result = updateSystemSettingsSchema.parse({
        telemetry: { ...TELEMETRY, instanceId: 'prod-eu.1' },
        notifications: NOTIFICATIONS,
      });

      expect(result.telemetry?.instanceId).toBe('prod-eu.1');
    });

    it.each(['Prod', '-prod', '', 'has space', 'a'.repeat(64)])(
      'should reject the instanceId %p (#565)',
      (instanceId) => {
        expect(() =>
          updateSystemSettingsSchema.parse({
            telemetry: { ...TELEMETRY, instanceId },
            notifications: NOTIFICATIONS,
          }),
        ).toThrow();
      },
    );
  });

  describe('complete settings object', () => {
    it('should accept valid complete settings', () => {
      const result = updateSystemSettingsSchema.parse({
        jobs: JOBS,
        nodes: NODES,
        notifications: {
          browserEnabled: false,
          disabledEvents: ['security.role_changed'],
        },
      });

      expect(result).toEqual({
        jobs: JOBS,
        nodes: NODES,
        notifications: {
          browserEnabled: false,
          disabledEvents: ['security.role_changed'],
        },
      });
    });
  });
});

describe('PatchSystemSettingsDto (PATCH)', () => {
  describe('jobs field', () => {
    it('should make jobs field optional', () => {
      const result = patchSystemSettingsSchema.parse({});

      expect(result.jobs).toBeUndefined();
    });

    it('should accept jobs with only stuckThresholdMinutes', () => {
      const result = patchSystemSettingsSchema.parse({
        jobs: { stuckThresholdMinutes: 45 },
      });

      expect(result.jobs?.stuckThresholdMinutes).toBe(45);
    });

    it('should make history optional within a jobs patch', () => {
      const result = patchSystemSettingsSchema.parse({
        jobs: {},
      });

      expect(result.jobs).toEqual({});
    });

    it('should reject a non-numeric stuckThresholdMinutes', () => {
      expect(() =>
        patchSystemSettingsSchema.parse({
          jobs: { stuckThresholdMinutes: 'soon' },
        }),
      ).toThrow();
    });
  });

  describe('nodes field', () => {
    it('should make nodes field optional', () => {
      const result = patchSystemSettingsSchema.parse({});

      expect(result.nodes).toBeUndefined();
    });

    it('should accept nodes with boolean and numeric fields', () => {
      const result = patchSystemSettingsSchema.parse({
        nodes: { jobSecretBrokerEnabled: true, offlineRetentionDays: 10 },
      });

      expect(result.nodes).toEqual({
        jobSecretBrokerEnabled: true,
        offlineRetentionDays: 10,
      });
    });

    it('should reject nodes with a wrong-typed value', () => {
      expect(() =>
        patchSystemSettingsSchema.parse({
          nodes: { jobSecretBrokerEnabled: 'yes' },
        }),
      ).toThrow();
    });
  });

  describe('notifications field', () => {
    it('is optional, like every other branch of a PATCH body', () => {
      const result = patchSystemSettingsSchema.parse({});

      expect(result.notifications).toBeUndefined();
    });

    it('accepts the global toggle on its own, leaving the list untouched', () => {
      // This is what the admin page sends when only the switch moved: the
      // service falls back to the stored `disabledEvents` for the absent half.
      const result = patchSystemSettingsSchema.parse({
        notifications: { browserEnabled: false },
      });

      expect(result.notifications).toEqual({ browserEnabled: false });
      expect(result.notifications?.disabledEvents).toBeUndefined();
    });

    it('accepts the list on its own', () => {
      const result = patchSystemSettingsSchema.parse({
        notifications: { disabledEvents: ['security.role_changed'] },
      });

      expect(result.notifications).toEqual({
        disabledEvents: ['security.role_changed'],
      });
    });

    it('accepts an empty list, which is how the last suppression is lifted', () => {
      // `disabledEvents` REPLACES rather than merges, so `[]` is a meaningful
      // body and must not be confused with "absent".
      const result = patchSystemSettingsSchema.parse({
        notifications: { disabledEvents: [] },
      });

      expect(result.notifications?.disabledEvents).toEqual([]);
    });

    it('applies the same event-key validation as the PUT schema', () => {
      expect(() =>
        patchSystemSettingsSchema.parse({
          notifications: { disabledEvents: ['NOT A KEY'] },
        }),
      ).toThrow();
    });

    it('applies the same cap as the PUT schema', () => {
      const overCap = Array.from(
        { length: MAX_DISABLED_NOTIFICATION_EVENTS + 1 },
        (_, index) => `area.event_${index}`,
      );

      expect(() =>
        patchSystemSettingsSchema.parse({
          notifications: { disabledEvents: overCap },
        }),
      ).toThrow();
    });

    it('rejects a non-boolean browserEnabled', () => {
      expect(() =>
        patchSystemSettingsSchema.parse({
          notifications: { browserEnabled: 1 },
        }),
      ).toThrow();
    });
  });

  describe('legacy ui/features keys (#366)', () => {
    it('strips a legacy ui key from a PATCH body instead of validating or echoing it', () => {
      const result = patchSystemSettingsSchema.parse({
        ui: { allowUserThemeOverride: true },
      });

      expect(result).not.toHaveProperty('ui');
    });

    it('strips a legacy features key from a PATCH body instead of validating or echoing it', () => {
      const result = patchSystemSettingsSchema.parse({
        features: { anyFlag: true },
      });

      expect(result).not.toHaveProperty('features');
    });
  });

  describe('partial updates', () => {
    it('should accept empty object (all fields optional)', () => {
      const result = patchSystemSettingsSchema.parse({});

      expect(result).toEqual({});
    });

    it('should accept update with only jobs field', () => {
      const result = patchSystemSettingsSchema.parse({
        jobs: { stuckThresholdMinutes: 60 },
      });

      expect(result).toEqual({
        jobs: { stuckThresholdMinutes: 60 },
      });
    });

    it('should accept update with only nodes field', () => {
      const result = patchSystemSettingsSchema.parse({
        nodes: { offlineRetentionDays: 14 },
      });

      expect(result).toEqual({
        nodes: { offlineRetentionDays: 14 },
      });
    });

    it('should accept combination of partial fields', () => {
      const result = patchSystemSettingsSchema.parse({
        jobs: { stuckThresholdMinutes: 60 },
        nodes: { jobSecretBrokerEnabled: true },
        notifications: {
          browserEnabled: false,
          disabledEvents: ['security.role_changed'],
        },
      });

      expect(result).toEqual({
        jobs: { stuckThresholdMinutes: 60 },
        nodes: { jobSecretBrokerEnabled: true },
        notifications: {
          browserEnabled: false,
          disabledEvents: ['security.role_changed'],
        },
      });
    });

    // =========================================================================
    // storage.forcePathStyle is TRI-STATE on the wire too (#374)
    // =========================================================================
    //
    // THE SILENT-NO-OP TRAP, IN ITS EXACT SHAPE. These bodies are parsed by the
    // global ZodValidationPipe before the service ever runs, so a
    // `z.boolean().optional()` here would strip an explicit `null` and hand the
    // service a body with the caller's change already deleted — 200, no error,
    // no audit entry, and no request able to put the field back to "use this
    // vendor's convention". `null` and absent are DIFFERENT instructions and
    // both have to survive this parse to be told apart in the merge.

    it('keeps an explicit storage.forcePathStyle null in a PATCH body', () => {
      const result = patchSystemSettingsSchema.parse({
        storage: { forcePathStyle: null },
      });

      expect(result).toEqual({ storage: { forcePathStyle: null } });
      expect(result.storage).toHaveProperty('forcePathStyle');
    });

    it('distinguishes an absent storage.forcePathStyle from an explicit null', () => {
      const result = patchSystemSettingsSchema.parse({
        storage: { bucket: 'my-bucket' },
      });

      expect(result.storage).not.toHaveProperty('forcePathStyle');
    });

    it('keeps an explicit storage.forcePathStyle false in a PATCH body', () => {
      const result = patchSystemSettingsSchema.parse({
        storage: { forcePathStyle: false },
      });

      expect(result).toEqual({ storage: { forcePathStyle: false } });
    });

    it('accepts a null storage.forcePathStyle in a PUT body', () => {
      const result = updateSystemSettingsSchema.parse({
        notifications: NOTIFICATIONS,
        storage: {
          provider: 's3compatible',
          bucket: 'my-bucket',
          region: '',
          endpoint: 'https://minio.internal:9000',
          accountId: '',
          accessKeyId: 'AKIAEXAMPLE',
          forcePathStyle: null,
        },
      });

      expect(result.storage?.forcePathStyle).toBeNull();
    });

    // =========================================================================
    // telemetry (epic #528, story #533)
    // =========================================================================

    it('should make the telemetry field optional on a PATCH body', () => {
      const result = patchSystemSettingsSchema.parse({});

      expect(result.telemetry).toBeUndefined();
    });

    it('should accept telemetry with only enabled', () => {
      const result = patchSystemSettingsSchema.parse({
        telemetry: { enabled: true },
      });

      expect(result.telemetry).toEqual({ enabled: true });
    });

    it('should reject a telemetry.retentionDays of 0', () => {
      expect(() =>
        patchSystemSettingsSchema.parse({
          telemetry: { retentionDays: 0 },
        }),
      ).toThrow();
    });

    it('should reject a telemetry.retentionDays over 3650', () => {
      expect(() =>
        patchSystemSettingsSchema.parse({
          telemetry: { retentionDays: 3651 },
        }),
      ).toThrow();
    });

    it('should reject a telemetry.query.maxRows over 100000', () => {
      expect(() =>
        patchSystemSettingsSchema.parse({
          telemetry: { query: { maxRows: 100001 } },
        }),
      ).toThrow();
    });

    it('should reject a telemetry.assistant.maxResultRowsToModel over 100', () => {
      expect(() =>
        patchSystemSettingsSchema.parse({
          telemetry: { assistant: { maxResultRowsToModel: 101 } },
        }),
      ).toThrow();
    });

    it('keeps an explicit telemetry.assistant.provider null in a PATCH body', () => {
      // Nullable, not optional (`systemTelemetryPatchSchema`): `null` clears
      // the stored provider back to "not configured", absent leaves it alone
      // — the same tri-state contract `storage.forcePathStyle` needs above.
      const result = patchSystemSettingsSchema.parse({
        telemetry: { assistant: { provider: null } },
      });

      expect(result.telemetry?.assistant).toHaveProperty('provider');
      expect(result.telemetry?.assistant?.provider).toBeNull();
    });

    it('distinguishes an absent telemetry.assistant.provider from an explicit null', () => {
      const result = patchSystemSettingsSchema.parse({
        telemetry: { assistant: { enabled: true } },
      });

      expect(result.telemetry?.assistant).not.toHaveProperty('provider');
    });

    it('keeps telemetry.instanceId tri-state in a PATCH body (#565)', () => {
      expect(
        patchSystemSettingsSchema.parse({ telemetry: { instanceId: null } }).telemetry,
      ).toEqual({ instanceId: null });
      expect(
        patchSystemSettingsSchema.parse({ telemetry: { instanceId: 'staging' } }).telemetry,
      ).toEqual({ instanceId: 'staging' });
      expect(
        patchSystemSettingsSchema.parse({ telemetry: { enabled: true } }).telemetry,
      ).not.toHaveProperty('instanceId');
    });

    it('should reject a malformed telemetry.instanceId in a PATCH body (#565)', () => {
      expect(() =>
        patchSystemSettingsSchema.parse({ telemetry: { instanceId: 'Not_Valid!' } }),
      ).toThrow();
    });
  });
});
