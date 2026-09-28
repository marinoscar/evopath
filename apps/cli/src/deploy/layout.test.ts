import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { UsageError } from '../errors.js';
import { isDeployment } from './deployment-evidence.js';
import {
  DEFAULT_APPS_ROOT,
  DEPLOY_ROOT_MARKER,
  deployRootFor,
  deploymentContaining,
  enumerateDeployments,
  locateApp,
} from './layout.js';

function makeAppsRoot(): string {
  return mkdtempSync(join(tmpdir(), 'appctl-layout-'));
}

/** A fixture deployment: `<root>/repo/.git/` (a directory is enough) plus an `.env`. */
function addDeployment(appsRoot: string, name: string, envContents = 'APP_BIND_PORT=3535\n'): string {
  const deployRoot = join(appsRoot, name);
  mkdirSync(join(deployRoot, 'repo', '.git'), { recursive: true });
  writeFileSync(join(deployRoot, '.env'), envContents);
  return deployRoot;
}

/** Same shape, but marked as this CLI's own -- carries `DEPLOY_ROOT` in `.env`. */
function addMarkedDeployment(appsRoot: string, name: string): string {
  return addDeployment(appsRoot, name, `${DEPLOY_ROOT_MARKER}=${name}\nAPP_BIND_PORT=3535\n`);
}

describe('locateApp: the five resolution ranks, in order', () => {
  it('rank 1: --root wins over everything, and does NOT require the path to exist', () => {
    const appsRoot = makeAppsRoot();
    addDeployment(appsRoot, 'alpha');
    // install legitimately names a root that does not exist yet.
    const notYetCreated = join(appsRoot, 'not-yet-created');

    const located = locateApp({ appsRoot, root: notYetCreated, name: 'alpha', cwd: appsRoot });

    expect(located.via).toBe('root');
    expect(located.deployRoot).toBe(notYetCreated);
  });

  it('rank 2: --name wins over cwd -- stops "--name other" from inside myapp/ meaning myapp', () => {
    const appsRoot = makeAppsRoot();
    addDeployment(appsRoot, 'alpha');
    const betaRoot = addDeployment(appsRoot, 'beta');

    const located = locateApp({ appsRoot, name: 'alpha', cwd: betaRoot });

    expect(located.via).toBe('name');
    expect(located.name).toBe('alpha');
    expect(located.deployRoot).toBe(deployRootFor(appsRoot, 'alpha'));
  });

  it('rank 3 (the headline rank): standing inside a deployment resolves it, BEFORE the ambiguity refusal', () => {
    const appsRoot = makeAppsRoot();
    addDeployment(appsRoot, 'alpha');
    const betaRoot = addDeployment(appsRoot, 'beta');
    // Two apps installed -- without rank 3 landing first, this would refuse as
    // ambiguous even though the operator is standing inside one of them.
    const nestedCwd = join(betaRoot, 'repo', 'infra');
    mkdirSync(nestedCwd, { recursive: true });

    const located = locateApp({ appsRoot, cwd: nestedCwd });

    expect(located.via).toBe('cwd');
    expect(located.name).toBe('beta');
    expect(located.deployRoot).toBe(betaRoot);
  });

  it('rank 4: the sole installed deployment resolves with via "sole"', () => {
    const appsRoot = makeAppsRoot();
    addDeployment(appsRoot, 'alpha');
    const elsewhere = mkdtempSync(join(tmpdir(), 'appctl-elsewhere-'));

    const located = locateApp({ appsRoot, cwd: elsewhere });

    expect(located.via).toBe('sole');
    expect(located.name).toBe('alpha');
  });

  it('rank 5: zero deployments throws UsageError mentioning the apps root', () => {
    const appsRoot = makeAppsRoot();
    const elsewhere = mkdtempSync(join(tmpdir(), 'appctl-elsewhere-'));

    expect(() => locateApp({ appsRoot, cwd: elsewhere })).toThrow(UsageError);
    expect(() => locateApp({ appsRoot, cwd: elsewhere })).toThrow(appsRoot);
  });
});

describe('locateApp: ambiguity refuses and NEVER prefers', () => {
  it('throws listing BOTH names when only one of two deployments carries the marker (does not silently pick the marked one)', () => {
    const appsRoot = makeAppsRoot();
    addMarkedDeployment(appsRoot, 'alpha');
    addDeployment(appsRoot, 'beta'); // no DEPLOY_ROOT marker
    const outside = mkdtempSync(join(tmpdir(), 'appctl-outside-'));

    let error: unknown;
    try {
      locateApp({ appsRoot, cwd: outside });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UsageError);
    const message = (error as Error).message;
    expect(message).toContain('alpha');
    expect(message).toContain('beta');
    // The refusal must flag which row lacks a marker, not silently prefer the
    // marked one.
    expect(message).toMatch(/beta.*no deployment marker/s);
  });
});

describe('deploymentContaining: bounded strictly inside the apps root', () => {
  it('never returns a deployment-looking directory ABOVE the apps root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'appctl-parent-'));
    // A deployment-looking directory that is the PARENT of the apps root.
    mkdirSync(join(parent, 'repo', '.git'), { recursive: true });
    writeFileSync(join(parent, '.env'), 'APP_BIND_PORT=3535\n');

    const appsRoot = join(parent, 'apps');
    mkdirSync(appsRoot, { recursive: true });
    // Standing inside the apps root, with nothing installed there.
    const cwd = mkdtempSync(join(appsRoot, 'nowhere-'));

    expect(deploymentContaining(cwd, appsRoot)).toBeUndefined();
  });
});

describe('enumerateDeployments: the apps root may itself be a deployment', () => {
  it('returns exactly one entry (the root) and does not offer repo/ or logs/ as apps', () => {
    const appsRoot = makeAppsRoot();
    mkdirSync(join(appsRoot, 'repo', '.git'), { recursive: true });
    writeFileSync(join(appsRoot, '.env'), 'APP_BIND_PORT=3535\n');
    // A subdirectory that would look like an app name if the root were walked.
    mkdirSync(join(appsRoot, 'logs'), { recursive: true });

    const found = enumerateDeployments(appsRoot);

    expect(found).toHaveLength(1);
    expect(found[0]?.deployRoot).toBe(appsRoot);
    expect(found.map((entry) => entry.name)).not.toContain('repo');
    expect(found.map((entry) => entry.name)).not.toContain('logs');
  });
});

describe('enumerateDeployments / deploymentContaining: agree with the shared predicate', () => {
  it('enumerates exactly the fixture directories for which isDeployment is true', () => {
    const appsRoot = makeAppsRoot();
    const alpha = addDeployment(appsRoot, 'alpha');
    // A directory that is NOT a deployment (no .git checkout).
    mkdirSync(join(appsRoot, 'not-an-app'), { recursive: true });
    writeFileSync(join(appsRoot, 'not-an-app', '.env'), 'X=1\n');
    const beta = addDeployment(appsRoot, 'beta');

    expect(isDeployment(alpha)).toBe(true);
    expect(isDeployment(beta)).toBe(true);
    expect(isDeployment(join(appsRoot, 'not-an-app'))).toBe(false);

    const found = enumerateDeployments(appsRoot).map((entry) => entry.deployRoot).sort();
    expect(found).toEqual([alpha, beta].sort());
  });

  it('deploymentContaining finds an unrecorded deployment the same way isDeployment does (no state file, no marker)', () => {
    const appsRoot = makeAppsRoot();
    const beta = addDeployment(appsRoot, 'beta');
    const nested = join(beta, 'repo', 'infra');
    mkdirSync(nested, { recursive: true });

    expect(isDeployment(beta)).toBe(true);
    expect(deploymentContaining(nested, appsRoot)).toBe(beta);
  });
});

describe('DEFAULT_APPS_ROOT / deployRootFor', () => {
  it('deployRootFor joins the apps root and the app name', () => {
    expect(deployRootFor('/opt/infra/apps', 'demo')).toBe(join('/opt/infra/apps', 'demo'));
  });

  it('DEFAULT_APPS_ROOT is the documented default', () => {
    expect(DEFAULT_APPS_ROOT).toBe('/opt/infra/apps');
    expect(dirname(deployRootFor(DEFAULT_APPS_ROOT, 'demo'))).toBe(DEFAULT_APPS_ROOT);
  });
});
