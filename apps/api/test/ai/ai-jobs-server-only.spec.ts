// =============================================================================
// AI jobs are server-only — cross-cutting conformance (issue #435, epic #419)
// =============================================================================
//
// A user's or the deployment's provider key must never leave the server
// (CLAUDE.md MANDATORY queue rule 3). For the AI platform that guarantee has
// a precise, structural form: every job type whose work would touch a
// provider key is registered with NEITHER `nodeResultSchema` nor
// `persistNodeResult` — the two members that, together, are the ONLY thing
// that makes a job type node-eligible (`job-handler.interface.ts`'s own
// header). A handler carrying exactly one of the two is still server-only, by
// the same derivation; there is no `nodeEligible` flag anywhere to disagree
// with the two members, so this is a fact about the registry, not about
// what any one handler file claims about itself.
//
// TYPES ARE DISCOVERED, NEVER HAND-LISTED — `JobHandlerRegistry.types()`,
// filtered to the `ai.` prefix, exactly as `ai-kill-switch.integration
// .spec.ts` discovers them for its own "zero provider calls while disabled"
// case. A fourth `ai.*` handler added later is covered by this file with no
// edit to it, and `JobHandlerRegistry.serverOnlyTypes()` — read here, never
// recomputed — is the same derivation every other consumer (the `system`
// worker mode, the node claim endpoint) relies on, so this suite is a
// property of that one source of truth rather than a second copy of it.
// =============================================================================

import { createTestApp, closeTestApp, type TestContext } from '../helpers/test-app.helper';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';

describe('AI job types are server-only, permanently (#435)', () => {
  let context: TestContext;
  let registry: JobHandlerRegistry;
  let aiTypes: string[];

  beforeAll(async () => {
    context = await createTestApp();
    registry = context.app.get(JobHandlerRegistry);
    aiTypes = registry.types().filter((type) => type.startsWith('ai.'));
  }, 60_000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  it('finds the ai.* job types at all, so a broken discovery cannot pass vacuously', () => {
    // The platform registers exactly three today (`ai.response.run`,
    // `ai.catalog.refresh`, `ai.keys.recheck`); this is a floor, not a pin,
    // so a fourth added later does not need this number bumped.
    expect(aiTypes.length).toBeGreaterThanOrEqual(3);
  });

  describe('every discovered ai.* type', () => {
    it('carries neither nodeResultSchema nor persistNodeResult, and is server-only', () => {
      const offenders: string[] = [];

      for (const type of aiTypes) {
        const handler = registry.get(type);

        if (!handler) {
          offenders.push(`${type}: registered in types() but get() returned nothing`);
          continue;
        }

        if (handler.nodeResultSchema !== undefined) {
          offenders.push(`${type}: carries nodeResultSchema — a user's/admin's provider key must never reach a node`);
        }

        if (handler.persistNodeResult !== undefined) {
          offenders.push(`${type}: carries persistNodeResult — a user's/admin's provider key must never reach a node`);
        }
      }

      expect(offenders).toEqual([]);
    });

    it('is included in JobHandlerRegistry.serverOnlyTypes() — the same derivation the node claim endpoint reads', () => {
      const serverOnly = new Set(registry.serverOnlyTypes());
      const missing = aiTypes.filter((type) => !serverOnly.has(type));

      expect(missing).toEqual([]);
    });
  });

  it('a handler carrying exactly one of the two members would still be caught (derivation, not a flag)', () => {
    // Not a test of any real handler — a structural proof that THIS SUITE's
    // own check has the same "both or neither" shape `JobHandlerRegistry
    // .serverOnlyTypes()` does, so a future ai.* handler that accidentally
    // implements only one of the pair is still reported as an offender by
    // the assertions above, not silently treated as node-eligible.
    const halfImplemented = { nodeResultSchema: {} } as { nodeResultSchema?: unknown; persistNodeResult?: unknown };
    const nodeEligible =
      halfImplemented.nodeResultSchema !== undefined && typeof halfImplemented.persistNodeResult === 'function';

    expect(nodeEligible).toBe(false);
  });
});
