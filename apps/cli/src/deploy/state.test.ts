import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT, exitCodeFor } from '../errors.js';
import {
  DEPLOY_STATE_FILENAME,
  DEPLOY_STATE_VERSION,
  DeployStateError,
  DEPLOY_HISTORY_LIMIT,
  NotInstalledError,
  appendHistory,
  deployStatePath,
  readState,
  requireState,
  upgradeState,
  writeState,
  type DeployState,
  type DeploymentHistoryEntry,
} from './state.js';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'appctl-state-'));
}

function sample(deployRoot: string): DeployState {
  return {
    version: DEPLOY_STATE_VERSION,
    repoUrl: 'https://github.com/example/app',
    ref: 'main',
    commitSha: 'a'.repeat(40),
    domain: 'app.example.test',
    bindPort: 3535,
    deployRoot,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-01-02T00:00:00.000Z',
    lastCommand: 'install',
    appctlVersion: '1.0.0',
  };
}

describe('writeState / readState', () => {
  it('round-trips every field', () => {
    const root = makeRoot();
    const state = sample(root);

    writeState(state);

    expect(readState(root)).toEqual(state);
  });

  it('writes the file 0600', () => {
    const root = makeRoot();
    writeState(sample(root));

    // Not a secret, but it describes the infrastructure and the repository.
    expect(statSync(deployStatePath(root)).mode & 0o777).toBe(0o600);
  });

  it('overwrites an existing state file and keeps the mode', () => {
    const root = makeRoot();
    writeState(sample(root));
    writeState({ ...sample(root), commitSha: 'b'.repeat(40), lastCommand: 'update' });

    expect(readState(root)?.commitSha).toBe('b'.repeat(40));
    expect(statSync(deployStatePath(root)).mode & 0o777).toBe(0o600);
  });

  it('leaves no temporary file behind', () => {
    const root = makeRoot();
    writeState(sample(root));

    const path = deployStatePath(root);
    expect(() => statSync(`${path}.${process.pid}.tmp`)).toThrow();
  });

  it('returns undefined when nothing is installed', () => {
    expect(readState(makeRoot())).toBeUndefined();
  });

  it('rejects a state file this build does not understand', () => {
    const root = makeRoot();
    writeFileSync(deployStatePath(root), JSON.stringify({ version: 99 }));

    // Misreading it would mean updating the wrong checkout or reporting the
    // wrong commit as deployed, so it refuses rather than guessing.
    expect(() => readState(root)).toThrow(DeployStateError);
    expect(() => readState(root)).toThrow(/state version 99/);
  });

  it('rejects an unparseable state file with a message that explains it', () => {
    const root = makeRoot();
    writeFileSync(deployStatePath(root), '{ not json');

    expect(() => readState(root)).toThrow(/not valid JSON/);
  });

  it('rejects a state file that is valid JSON but not an object', () => {
    const root = makeRoot();
    writeFileSync(deployStatePath(root), '"a string"');

    expect(() => readState(root)).toThrow(DeployStateError);
  });
});

describe('requireState', () => {
  it('returns the state when a deployment exists', () => {
    const root = makeRoot();
    writeState(sample(root));

    expect(requireState(root).ref).toBe('main');
  });

  it('names the install command and the path when nothing is there', () => {
    const root = makeRoot();
    const error = (() => {
      try {
        requireState(root);
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(NotInstalledError);
    expect((error as Error).message).toContain('deploy install');
    expect((error as Error).message).toContain(root);
    expect((error as Error).message).toContain('--root');
    // A usage problem, not a broken CLI: the remedy is a different command.
    expect(exitCodeFor(error)).toBe(EXIT.USAGE);
  });
});

// =============================================================================
// The two rules a "simplify" pass deletes  (issue #407, epic #397)
// =============================================================================
//
// Both of these are refusals to CHANGE something, which means neither has any
// code enforcing it and neither fails when broken — here. They fail on a
// server, months later, for every deployment at once. That asymmetry is
// exactly why they are pinned: the cost of breaking them is paid somewhere the
// person breaking them will not be looking.
// =============================================================================

describe('the state contract with deployments already in the field', () => {
  it('keeps the state version at 2, with a migration path from 1', () => {
    // ⚠ A BUMP WITHOUT A MIGRATION MAKES THIS CLI REFUSE EVERY STATE FILE ON
    // EVERY LIVE SERVER. `readState` rejects a version it does not understand —
    // right for a file from the FUTURE and catastrophic as a migration
    // strategy: `update` would stop working on every deployment simultaneously.
    //
    // Issue #392 bumped to 2 only because `upgradeState` was written first and
    // carries every v1 record forward. A further bump needs the same: a branch
    // in `upgradeState` for every version this CLI ever wrote.
    expect(DEPLOY_STATE_VERSION).toBe(2);
    expect(upgradeState({ version: 1 }).version).toBe(2);
  });

  it('keeps the state filename', () => {
    // ⚠ THIS NAME IS READ OFF LIVE SERVERS. Renaming it orphans every existing
    // deployment: the new CLI finds no record, and the evidence predicate is
    // what saves it from being treated as a fresh install — which is a
    // recovery, not a plan.
    //
    // Operator-facing copy is where a nicer name belongs; the literal filename
    // appears in the journal, `--json` and path lists, and nowhere else.
    expect(DEPLOY_STATE_FILENAME).toBe('.appctl-deploy.json');
  });

  it('reads a state file written before any of the optional fields existed', () => {
    const root = makeRoot();

    // Exactly what an early install wrote: no proxyRoot, no composeProject, no
    // groups, no completedSteps, no lastOutcome.
    writeFileSync(
      deployStatePath(root),
      JSON.stringify({
        version: 1,
        repoUrl: 'https://github.com/example/app',
        ref: 'main',
        commitSha: 'b'.repeat(40),
        bindPort: 3535,
        deployRoot: root,
        installedAt: '2026-01-01T00:00:00.000Z',
        lastDeployedAt: '2026-01-01T00:00:00.000Z',
        lastCommand: 'install',
        appctlVersion: '0.1.0',
      }),
    );

    const state = readState(root);

    // ⚠ READ, NOT REJECTED. This is the file on every server installed before
    // this epic, and `update` has to work on it untouched.
    expect(state?.commitSha).toBe('b'.repeat(40));
    expect(state?.proxyRoot).toBeUndefined();
    expect(state?.composeProject).toBeUndefined();
  });
});

// =============================================================================
// State v2: read-forward, refuse-the-future, success-only history  (issue #392)
// =============================================================================

function v1Record(deployRoot: string): Record<string, unknown> {
  return {
    version: 1,
    repoUrl: 'https://github.com/example/app',
    ref: 'main',
    commitSha: 'c'.repeat(40),
    domain: 'app.example.test',
    bindPort: 3535,
    deployRoot,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastDeployedAt: '2026-02-01T00:00:00.000Z',
    lastCommand: 'update',
    appctlVersion: '1.5.0',
    proxyMode: 'container',
    proxyContainer: 'edge-proxy',
    lastOutcome: 'success',
  };
}

function entry(n: number): DeploymentHistoryEntry {
  return {
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    command: 'update',
    commitSha: String(n).padStart(40, '0'),
    previousCommitSha: null,
    ref: 'main',
    durationMs: 1000 + n,
    cliVersion: '1.6.0',
    outcome: 'success',
  };
}

describe('upgradeState', () => {
  it('reads a v1 file forward to v2, keeping every field and adding an empty history', () => {
    const root = makeRoot();
    const v1 = v1Record(root);
    writeFileSync(deployStatePath(root), JSON.stringify(v1));

    const state = readState(root);

    expect(state).toEqual({ ...v1, version: 2, history: [] });
    // ⚠ Not fabricated: nothing has observed the host or the certificate yet,
    // so they stay ABSENT until the next successful run records them.
    expect(state?.host).toBeUndefined();
    expect(state?.proxy).toBeUndefined();
  });

  it('does not rewrite the file on read -- the next writeState persists v2', () => {
    const root = makeRoot();
    const raw = JSON.stringify(v1Record(root));
    writeFileSync(deployStatePath(root), raw);

    readState(root);

    expect(readFileSync(deployStatePath(root), 'utf8')).toBe(raw);
  });

  it('is pure and leaves a v2 record as it is', () => {
    const root = makeRoot();
    const v2 = { ...sample(root), history: [entry(1)] };
    expect(upgradeState(v2)).toBe(v2);
  });

  it('refuses a version from the future rather than guessing', () => {
    const root = makeRoot();
    writeFileSync(deployStatePath(root), JSON.stringify({ ...v1Record(root), version: 3 }));

    expect(() => readState(root)).toThrow(DeployStateError);
    expect(() => readState(root)).toThrow(/state version 3/);
  });

  it('refuses a record with no version at all', () => {
    expect(() => upgradeState({ repoUrl: 'x' })).toThrow(/state version undefined/);
  });

  it('refuses something that is not a record', () => {
    expect(() => upgradeState([])).toThrow(DeployStateError);
    expect(() => upgradeState(null)).toThrow(DeployStateError);
  });
});

describe('appendHistory', () => {
  it('puts the newest run first', () => {
    const history = appendHistory(appendHistory(undefined, entry(1)), entry(2));
    expect(history.map((item) => item.durationMs)).toEqual([1002, 1001]);
  });

  it(`caps the list at ${DEPLOY_HISTORY_LIMIT}, dropping the oldest`, () => {
    let history: DeploymentHistoryEntry[] = [];
    for (let n = 1; n <= DEPLOY_HISTORY_LIMIT + 5; n += 1) {
      history = appendHistory(history, entry(n));
    }

    expect(DEPLOY_HISTORY_LIMIT).toBe(20);
    expect(history).toHaveLength(20);
    expect(history[0]).toEqual(entry(DEPLOY_HISTORY_LIMIT + 5));
    expect(history.at(-1)).toEqual(entry(6));
  });

  it('does not mutate the list it was given', () => {
    const original = [entry(1)];
    appendHistory(original, entry(2));
    expect(original).toEqual([entry(1)]);
  });
});
