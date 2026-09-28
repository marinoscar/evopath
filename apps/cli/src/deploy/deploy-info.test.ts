import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEPLOY_INFO_SCHEMA_VERSION,
  buildDeployInfo,
  deployInfoPath,
  writeDeployInfo,
  type DeployInfoInput,
} from './deploy-info.js';
import type { DeploymentHistoryEntry, HostFacts } from './state.js';

// =============================================================================
// info.json against the shared fixture  (issue #392)
// =============================================================================
//
// ⚠ ASSERTED FROM BOTH SIDES. `apps/api/test/fixtures/deploy-info.sample.json`
// is a complete example of the file. The API's tests parse it and assert every
// field survives the lenient reader; THIS test builds the CLI's output and
// asserts it has exactly the fixture's key set at every level. A field added
// on one side only fails one of the two.
// =============================================================================

const FIXTURE_PATH = resolve(
  __dirname,
  '..', '..', '..', 'api', 'test', 'fixtures', 'deploy-info.sample.json',
);

const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;

/**
 * The key set of a JSON value, recursively: an object maps each key to its
 * children's shape, an array to the shape of its elements (all of which must
 * agree), and a leaf is just a leaf. Values are ignored -- `null` vs a string
 * is the lenient reader's business, a missing or extra key is this test's.
 */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    const shapes = value.map(shapeOf);
    const distinct = new Set(shapes.map((shape) => JSON.stringify(shape)));
    expect(distinct.size).toBeLessThanOrEqual(1);
    return shapes.length === 0 ? [] : [shapes[0]];
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, shapeOf((value as Record<string, unknown>)[key])]),
    );
  }
  return 'leaf';
}

const host = FIXTURE['host'] as HostFacts;
const history = FIXTURE['history'] as DeploymentHistoryEntry[];
const app = FIXTURE['app'] as Record<string, string>;
const run = FIXTURE['run'] as { completed: string[] };
const proxy = FIXTURE['proxy'] as NonNullable<DeployInfoInput['proxy']>;

/** Every input populated, from the fixture's own values. */
function fullInput(): DeployInfoInput {
  return {
    name: app['name'] as string,
    version: app['version'],
    commitSha: app['commitSha'],
    ref: app['ref'],
    installedAt: FIXTURE['installedAt'] as string,
    updatedAt: FIXTURE['updatedAt'] as string,
    cliVersion: (FIXTURE['deployedBy'] as { version: string }).version,
    domain: FIXTURE['domain'] as string,
    completed: run.completed,
    outcome: 'success',
    lastCommand: 'update',
    bindPort: FIXTURE['bindPort'] as number,
    proxy,
    host,
    history,
  };
}

describe('buildDeployInfo against the shared fixture', () => {
  it('has exactly the fixture key set at every level', () => {
    const built = buildDeployInfo(fullInput());

    // `remote` is the one object this CLI does not know (it never asks the
    // remote at deploy time) and writes as null; the fixture populates it for
    // the API side. Its KEY is still compared at the top level below.
    const { remote: _builtRemote, ...builtRest } = built;
    const { remote: _fixtureRemote, ...fixtureRest } = FIXTURE;

    expect(shapeOf(builtRest)).toEqual(shapeOf(fixtureRest));
    expect(Object.keys(built).sort()).toEqual(Object.keys(FIXTURE).sort());
  });

  it('reproduces the fixture value for value, from the fixture values', () => {
    expect(buildDeployInfo(fullInput())).toEqual({ ...FIXTURE, remote: null });
  });

  it('keeps schema at 1', () => {
    // A bump to add optional fields makes every deployed API answer `invalid`.
    expect(DEPLOY_INFO_SCHEMA_VERSION).toBe(1);
    expect(FIXTURE['schema']).toBe(1);
  });

  it('writes every top-level key even when nothing is known, as null or []', () => {
    const built = buildDeployInfo({ name: 'app' });

    expect(Object.keys(built).sort()).toEqual(Object.keys(FIXTURE).sort());
    expect(built['lastCommand']).toBeNull();
    expect(built['bindPort']).toBeNull();
    expect(built['proxy']).toBeNull();
    expect(built['host']).toBeNull();
    expect(built['history']).toEqual([]);
  });

  it('never leaks a key from an internal type into the document', () => {
    const built = buildDeployInfo({
      ...fullInput(),
      host: { ...host, secretish: 'x' } as unknown as HostFacts,
      history: [{ ...history[0], extra: 'x' } as unknown as DeploymentHistoryEntry],
      proxy: { ...proxy, domain: 'x' } as unknown as DeployInfoInput['proxy'],
    });

    expect(shapeOf(built['host'])).toEqual(shapeOf(FIXTURE['host']));
    expect(shapeOf(built['history'])).toEqual(shapeOf(FIXTURE['history']));
    expect(shapeOf(built['proxy'])).toEqual(shapeOf(FIXTURE['proxy']));
  });

  it('round-trips through writeDeployInfo with the same shape', () => {
    const root = mkdtempSync(join(tmpdir(), 'appctl-deploy-info-'));
    mkdirSync(join(root, 'deploy-info'));

    const result = writeDeployInfo(root, fullInput());
    expect(result.written).toBe(true);

    const written = JSON.parse(readFileSync(deployInfoPath(root), 'utf8')) as Record<string, unknown>;
    expect(written).toEqual({ ...FIXTURE, remote: null });
  });
});
