import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  describeEvidence,
  envPathFor,
  hasGitCheckout,
  hasReadableEnvFile,
  isDeployment,
  legacyEnvPathFor,
  resolveEnvPath,
} from './deployment-evidence.js';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'appctl-evidence-'));
}

/** repo/.git as a directory, exactly the marker `hasGitCheckout` looks for. */
function addCheckout(root: string): void {
  mkdirSync(join(root, 'repo', '.git'), { recursive: true });
}

function addEnv(root: string, contents = 'APP_BIND_PORT=3535\n'): void {
  writeFileSync(join(root, '.env'), contents);
}

function addLegacyEnv(root: string, contents = 'APP_BIND_PORT=3535\n'): void {
  mkdirSync(join(root, 'repo', 'infra', 'compose'), { recursive: true });
  writeFileSync(join(root, 'repo', 'infra', 'compose', '.env'), contents);
}

describe('envPathFor / legacyEnvPathFor', () => {
  it('point at the current and legacy .env locations', () => {
    expect(envPathFor('/opt/apps/demo')).toBe('/opt/apps/demo/.env');
    expect(legacyEnvPathFor('/opt/apps/demo')).toBe(
      '/opt/apps/demo/repo/infra/compose/.env',
    );
  });
});

describe('isDeployment: THE predicate', () => {
  it('is true only when both a checkout and a readable .env exist', () => {
    const root = makeRoot();
    addCheckout(root);
    addEnv(root);

    expect(isDeployment(root)).toBe(true);
  });

  it('is false with a checkout but no .env', () => {
    const root = makeRoot();
    addCheckout(root);

    expect(isDeployment(root)).toBe(false);
  });

  it('is false with an .env but no checkout', () => {
    const root = makeRoot();
    addEnv(root);

    expect(isDeployment(root)).toBe(false);
  });

  it('is false with neither', () => {
    expect(isDeployment(makeRoot())).toBe(false);
  });

  // ===========================================================================
  // This is the whole point of the module. If this assertion is ever deleted,
  // the live-server bug the header describes -- a deployment with running
  // containers, an issued certificate and a serving site, told "no deployment
  // found" because a JSON bookkeeping file happened to be missing -- comes
  // straight back. Containers are deliberately NOT probed here (that would put
  // a subprocess on a path that must keep working when the daemon is down),
  // and the state file is deliberately not consulted at all.
  // ===========================================================================
  it('is true for a real deployment even with no .appctl-deploy.json state file (regression: do not let this pass by checking the state file instead)', () => {
    const root = makeRoot();
    addCheckout(root);
    addEnv(root);

    expect(existsSync(join(root, '.appctl-deploy.json'))).toBe(false);
    expect(isDeployment(root)).toBe(true);
  });
});

describe('hasGitCheckout', () => {
  it('is true given a .git marker, without running git', () => {
    const root = makeRoot();
    addCheckout(root);

    expect(hasGitCheckout(join(root, 'repo'))).toBe(true);
  });

  it('is false when there is no .git marker', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'repo'), { recursive: true });

    expect(hasGitCheckout(join(root, 'repo'))).toBe(false);
  });
});

describe('resolveEnvPath', () => {
  it('prefers the current <root>/.env over the legacy location when both exist', () => {
    const root = makeRoot();
    addEnv(root, 'CURRENT=1\n');
    addLegacyEnv(root, 'LEGACY=1\n');

    // This preference is what stops a deployment moved to the new layout from
    // reading a stale legacy file that migration left behind.
    expect(resolveEnvPath(root)).toBe(envPathFor(root));
  });

  it('finds the legacy repo/infra/compose/.env when the current one is absent', () => {
    const root = makeRoot();
    addLegacyEnv(root);

    // The whole reason this function exists: without it, every server
    // deployed before the layout moved would be treated as having no .env at
    // all and be orphaned.
    expect(resolveEnvPath(root)).toBe(legacyEnvPathFor(root));
  });

  it('returns undefined when neither location has a file', () => {
    expect(resolveEnvPath(makeRoot())).toBeUndefined();
  });

  it('treats a .env that is a directory as not present, and still falls back to a legacy file', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.env'), { recursive: true }); // a directory, not a file
    addLegacyEnv(root);

    expect(resolveEnvPath(root)).toBe(legacyEnvPathFor(root));
  });
});

describe('hasReadableEnvFile', () => {
  it('is true when the current .env is a real file', () => {
    const root = makeRoot();
    addEnv(root);

    expect(hasReadableEnvFile(root)).toBe(true);
  });

  it('is false when .env is a directory rather than a file', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.env'), { recursive: true });

    expect(hasReadableEnvFile(root)).toBe(false);
  });

  it('is false when nothing is there at all', () => {
    expect(hasReadableEnvFile(makeRoot())).toBe(false);
  });
});

describe('describeEvidence', () => {
  it('reports both halves present', () => {
    const root = makeRoot();
    addCheckout(root);
    addEnv(root);

    expect(describeEvidence(root)).toMatchObject({
      isDeployment: true,
      hasCheckout: true,
      hasEnv: true,
      envPath: envPathFor(root),
    });
  });

  it('reports a missing checkout, distinctly from a missing .env', () => {
    const root = makeRoot();
    addEnv(root);

    const evidence = describeEvidence(root);
    expect(evidence.isDeployment).toBe(false);
    expect(evidence.hasCheckout).toBe(false);
    expect(evidence.hasEnv).toBe(true);
  });

  it('reports a missing .env, distinctly from a missing checkout', () => {
    const root = makeRoot();
    addCheckout(root);

    const evidence = describeEvidence(root);
    expect(evidence.isDeployment).toBe(false);
    expect(evidence.hasCheckout).toBe(true);
    expect(evidence.hasEnv).toBe(false);
    expect(evidence.envPath).toBeUndefined();
  });

  it('reports neither half present', () => {
    const evidence = describeEvidence(makeRoot());
    expect(evidence).toMatchObject({
      isDeployment: false,
      hasCheckout: false,
      hasEnv: false,
      envPath: undefined,
    });
  });
});
