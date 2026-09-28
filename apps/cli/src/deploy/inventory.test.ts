import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { UsageError } from '../errors.js';
import {
  collectInventory,
  renderInventory,
  requireInventory,
  type InventoryEntry,
} from './inventory.js';
import { DEPLOY_STATE_VERSION, deployStatePath, writeState, type DeployState } from './state.js';

function makeAppsRoot(): string {
  return mkdtempSync(join(tmpdir(), 'appctl-inventory-'));
}

/** A fixture deployment: `<root>/repo/.git/` (a directory is enough) plus an `.env`. */
function addDeployment(appsRoot: string, name: string, envContents = 'APP_BIND_PORT=3535\n'): string {
  const deployRoot = join(appsRoot, name);
  mkdirSync(join(deployRoot, 'repo', '.git'), { recursive: true });
  writeFileSync(join(deployRoot, '.env'), envContents);
  return deployRoot;
}

function sampleState(deployRoot: string): DeployState {
  return {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://example.test/o/r',
    ref: 'main',
    commitSha: 'b'.repeat(40),
    domain: 'beta.example.test',
    bindPort: 4002,
    deployRoot,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-02T00:00:00.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
  };
}

// =============================================================================
// Filesystem only -- no subprocess, ever  (see inventory.ts's header comment)
// =============================================================================
//
// node:child_process's ESM namespace cannot be spied on in place (its exports
// are non-configurable), so the module is mocked wholesale: every function it
// exports throws if called at all. If `collectInventory` were ever changed to
// shell out -- `git rev-parse` to fill in a commit, say -- this test fails
// loudly instead of quietly costing the inventory a subprocess per app.
// =============================================================================
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const forbidden = (name: string) => (): never => {
    throw new Error(`collectInventory must never spawn a subprocess (called ${name})`);
  };
  return {
    ...actual,
    spawn: forbidden('spawn'),
    exec: forbidden('exec'),
    execFile: forbidden('execFile'),
    execSync: forbidden('execSync'),
    execFileSync: forbidden('execFileSync'),
    spawnSync: forbidden('spawnSync'),
  };
});

describe('collectInventory: filesystem only', () => {
  it('succeeds over a multi-app fixture even though any subprocess spawn would fail the test', () => {
    const appsRoot = makeAppsRoot();
    addDeployment(appsRoot, 'alpha', 'APP_BIND_PORT=4001\nAPP_URL=https://alpha.example.test\n');
    const betaRoot = addDeployment(appsRoot, 'beta');
    writeState(sampleState(betaRoot));

    const entries = collectInventory({ appsRoot });

    expect(entries).toHaveLength(2);
  });
});

describe('collectInventory: source attribution', () => {
  it('a deployment with no state file reports commitSha: null and source "inferred" -- not a looked-up SHA', () => {
    const appsRoot = makeAppsRoot();
    addDeployment(appsRoot, 'alpha', 'APP_BIND_PORT=4001\nAPP_URL=https://alpha.example.test\n');

    const entries = collectInventory({ appsRoot });

    expect(entries).toHaveLength(1);
    const alpha = entries[0] as InventoryEntry;
    expect(alpha.name).toBe('alpha');
    expect(alpha.source).toBe('inferred');
    expect(alpha.commitSha).toBeNull();
    expect(alpha.domain).toBe('alpha.example.test');
    expect(alpha.bindPort).toBe(4001);
  });

  it('a deployment with a valid state file reports source "record" and its recorded commit', () => {
    const appsRoot = makeAppsRoot();
    const betaRoot = addDeployment(appsRoot, 'beta');
    writeState(sampleState(betaRoot));

    const entries = collectInventory({ appsRoot });

    expect(entries).toHaveLength(1);
    const beta = entries[0] as InventoryEntry;
    expect(beta.source).toBe('record');
    expect(beta.commitSha).toBe('b'.repeat(40));
    expect(beta.domain).toBe('beta.example.test');
    expect(beta.bindPort).toBe(4002);
  });

  it('a deployment with an invalid-JSON state file reports source "unreadable" with a problem, and does not fail the whole inventory or masquerade as inferred', () => {
    const appsRoot = makeAppsRoot();
    addDeployment(appsRoot, 'alpha', 'APP_BIND_PORT=4001\n'); // healthy, inferred
    const gammaRoot = addDeployment(appsRoot, 'gamma');
    writeFileSync(deployStatePath(gammaRoot), '{ not json');

    const entries = collectInventory({ appsRoot });

    // Both rows present: the bad one did not take down the whole inventory.
    expect(entries).toHaveLength(2);

    const gamma = entries.find((entry) => entry.name === 'gamma') as InventoryEntry;
    expect(gamma.source).toBe('unreadable');
    expect(gamma.commitSha).toBeNull();
    expect(gamma.problem).toBeDefined();
    expect(gamma.problem).toMatch(/valid JSON/);

    const alpha = entries.find((entry) => entry.name === 'alpha') as InventoryEntry;
    expect(alpha.source).toBe('inferred');
  });
});

describe('renderInventory', () => {
  it('produces aligned columns', () => {
    const entries: InventoryEntry[] = [
      {
        name: 'a',
        deployRoot: '/opt/infra/apps/a',
        commitSha: 'a'.repeat(40),
        ref: 'main',
        domain: 'a.example.test',
        bindPort: 3535,
        lastDeployedAt: '2026-01-01T00:00:00.000Z',
        source: 'record',
      },
      {
        name: 'much-longer-app-name',
        deployRoot: '/opt/infra/apps/much-longer-app-name',
        commitSha: null,
        ref: null,
        domain: null,
        bindPort: null,
        lastDeployedAt: null,
        source: 'inferred',
      },
    ];

    const lines = renderInventory(entries, '/opt/infra/apps').split('\n');
    const [header, row1, row2] = lines;

    // Every data column starts at the same offset the header column does --
    // the wider name in row2 must not push its own row out of alignment.
    const nameColumnStart = (header as string).indexOf('NAME');
    expect(nameColumnStart).toBe(0);
    const commitColumnStart = (header as string).indexOf('COMMIT');
    expect((row1 as string).indexOf('a'.repeat(12))).toBe(commitColumnStart);
    expect((row2 as string).slice(commitColumnStart, commitColumnStart + 1)).toBe('-');

    const domainColumnStart = (header as string).indexOf('DOMAIN');
    expect((row1 as string).slice(domainColumnStart, domainColumnStart + 'a.example.test'.length)).toBe(
      'a.example.test',
    );
    expect((row2 as string).slice(domainColumnStart, domainColumnStart + 1)).toBe('-');
  });

  it('renders an empty inventory as a plain sentence, not an error', () => {
    const rendered = renderInventory([], '/opt/infra/apps');

    expect(rendered).toBe('No deployments found under /opt/infra/apps.');
  });
});

describe('requireInventory', () => {
  it('returns the entries when at least one deployment exists', () => {
    const appsRoot = makeAppsRoot();
    addDeployment(appsRoot, 'alpha');

    expect(requireInventory({ appsRoot })).toHaveLength(1);
  });

  it('throws UsageError when nothing is installed', () => {
    const appsRoot = makeAppsRoot();

    expect(() => requireInventory({ appsRoot })).toThrow(UsageError);
    expect(() => requireInventory({ appsRoot })).toThrow(appsRoot);
  });
});
