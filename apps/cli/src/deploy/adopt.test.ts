import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { adoptDeployment, NotAdoptableError, type AdoptOptions } from './adopt.js';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'appctl-adopt-'));
}

/** A root that passes `isDeployment`: repo/.git plus a readable .env. */
function deploymentRoot(envContents: string): string {
  const root = makeRoot();
  mkdirSync(join(root, 'repo', '.git'), { recursive: true });
  writeFileSync(join(root, '.env'), envContents);
  return root;
}

function optionsFor(deployRoot: string, overrides: Partial<AdoptOptions> = {}): AdoptOptions {
  return {
    deployRoot,
    repoUrl: 'https://example.test/o/demo',
    ref: 'main',
    commitSha: 'a'.repeat(40),
    fallbackBindPort: 3535,
    ...overrides,
  };
}

describe('adoptDeployment: invents nothing', () => {
  it('throws NotAdoptableError when the root is not a deployment', () => {
    const root = makeRoot(); // no checkout, no .env

    expect(() => adoptDeployment(optionsFor(root))).toThrow(NotAdoptableError);
  });

  it('throws NotAdoptableError when only half the evidence is present', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'repo', '.git'), { recursive: true }); // checkout only, no .env

    expect(() => adoptDeployment(optionsFor(root))).toThrow(NotAdoptableError);
  });

  it('sets adoptedAt to a plausible ISO instant, close to now', () => {
    const root = deploymentRoot('APP_BIND_PORT=3535\n');
    const before = Date.now();

    const state = adoptDeployment(optionsFor(root));

    const adoptedAtMs = new Date(state.adoptedAt as string).getTime();
    expect(Number.isNaN(adoptedAtMs)).toBe(false);
    expect(adoptedAtMs).toBeGreaterThanOrEqual(before);
    expect(adoptedAtMs).toBeLessThanOrEqual(Date.now());
  });

  it('leaves installedAt and lastDeployedAt EMPTY rather than fabricating them', () => {
    // These are genuinely unknowable from the filesystem. Neither a
    // directory mtime nor Date.now() is an honest stand-in for them - that is
    // the entire rule this module exists to enforce. If a future change ever
    // fills these from a stat() call or from "now", this must go red.
    const root = deploymentRoot('APP_BIND_PORT=3535\n');

    const state = adoptDeployment(optionsFor(root));

    expect(state.installedAt).toBe('');
    expect(state.lastDeployedAt).toBe('');
  });

  it('records a third axis (adoptedAt) distinct from installedAt/lastDeployedAt', () => {
    const root = deploymentRoot('APP_BIND_PORT=3535\n');

    const state = adoptDeployment(optionsFor(root));

    expect(state.adoptedAt).not.toBe(state.installedAt);
    expect(state.adoptedAt).not.toBe('');
  });
});

describe('adoptDeployment: bindPort', () => {
  it('reads APP_BIND_PORT from the .env when present', () => {
    const root = deploymentRoot('APP_BIND_PORT=4444\n');

    const state = adoptDeployment(optionsFor(root, { fallbackBindPort: 3535 }));

    expect(state.bindPort).toBe(4444);
  });

  it('falls back to fallbackBindPort when .env names no APP_BIND_PORT', () => {
    const root = deploymentRoot('SOME_OTHER_VAR=1\n');

    const state = adoptDeployment(optionsFor(root, { fallbackBindPort: 9999 }));

    expect(state.bindPort).toBe(9999);
  });

  it('falls back when APP_BIND_PORT is present but not a usable positive integer', () => {
    const root = deploymentRoot('APP_BIND_PORT=not-a-number\n');

    const state = adoptDeployment(optionsFor(root, { fallbackBindPort: 7777 }));

    expect(state.bindPort).toBe(7777);
  });
});

describe('adoptDeployment: domain from APP_URL', () => {
  it('parses the hostname out of a well-formed APP_URL', () => {
    const root = deploymentRoot('APP_URL=https://app.example.com/\n');

    const state = adoptDeployment(optionsFor(root));

    expect(state.domain).toBe('app.example.com');
  });

  it('yields no domain (never a wrong one) for a malformed APP_URL', () => {
    const root = deploymentRoot('APP_URL=not a url\n');

    const state = adoptDeployment(optionsFor(root));

    expect(state.domain).toBeUndefined();
  });

  it('yields no domain when APP_URL is absent entirely', () => {
    const root = deploymentRoot('APP_BIND_PORT=3535\n');

    const state = adoptDeployment(optionsFor(root));

    expect(state.domain).toBeUndefined();
  });
});
