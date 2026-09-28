import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LEGACY_COMPOSE_PROJECT, composeArgv, composeProjectFor } from './install.js';
import { isDeployment } from './deployment-evidence.js';

/**
 * The compose project name is the one piece of bookkeeping in this CLI that can
 * cause an outage by being RIGHT in the wrong place.
 *
 * Without `-p`, Compose derives the project from the compose file's DIRECTORY,
 * which is `compose` for every deployment on the host -- so two applications
 * share one project and each `up -d` fights the other.
 *
 * But naming an EXISTING deployment's project renames it, and Compose then sees
 * no existing containers: it builds a parallel stack that collides with the one
 * still running and holding the bind port. Fixing the first problem naively
 * causes the second.
 */
describe('composeProjectFor: the recorded name, never a derived one', () => {
  it('answers "compose" for a deployment with no record at all', () => {
    expect(composeProjectFor(undefined)).toBe(LEGACY_COMPOSE_PROJECT);
    expect(LEGACY_COMPOSE_PROJECT).toBe('compose');
  });

  it('answers "compose" for a record written before the field existed', () => {
    // ⚠ This is every deployment in the field. Absent MUST mean the
    // directory-derived default they are already running under -- anything else
    // renames their project on the next update and starts a parallel stack.
    expect(composeProjectFor({})).toBe('compose');
  });

  it('answers the recorded name when there is one', () => {
    expect(composeProjectFor({ composeProject: 'myapp' })).toBe('myapp');
  });
});

describe('composeArgv', () => {
  it('emits no -p at all when no project is given', () => {
    const argv = composeArgv(['up', '-d']);

    expect(argv).not.toContain('-p');
    expect(argv.slice(0, 2)).toEqual(['docker', 'compose']);
  });

  it('puts -p <name> before the -f flags, where Compose expects it', () => {
    const argv = composeArgv(['up', '-d'], 'myapp');

    expect(argv.slice(0, 4)).toEqual(['docker', 'compose', '-p', 'myapp']);
    expect(argv.indexOf('-p')).toBeLessThan(argv.indexOf('-f'));
  });

  it('still layers base, prod and vps in that order, with the always-on telemetry files (#567)', () => {
    const argv = composeArgv(['build'], 'myapp');
    const files = argv.filter((_, index) => argv[index - 1] === '-f');

    expect(files).toEqual([
      'base.compose.yml',
      'prod.compose.yml',
      'telemetry.compose.yml',
      'vps.compose.yml',
      'vps.telemetry.compose.yml',
    ]);
  });

  it('adds the telemetry files when the observability group is passed (#531)', () => {
    const argv = composeArgv(['up', '-d'], 'myapp', ['observability']);
    const files = argv.filter((_, index) => argv[index - 1] === '-f');

    expect(files).toEqual([
      'base.compose.yml',
      'prod.compose.yml',
      'telemetry.compose.yml',
      'vps.compose.yml',
      'vps.telemetry.compose.yml',
    ]);
    expect(argv.slice(-2)).toEqual(['up', '-d']);
  });

  it('an adopted deployment keeps -p compose, not a name derived from its directory', () => {
    // The whole point. A deployment that predates this field is recognised by
    // the evidence predicate but carries no `composeProject`, and its containers
    // are running under `compose`. Deriving a name from the directory here is
    // what would start the parallel stack.
    const deployRoot = mkdtempSync(join(tmpdir(), 'appctl-adopted-'));
    mkdirSync(join(deployRoot, 'repo', '.git'), { recursive: true });
    writeFileSync(join(deployRoot, '.env'), 'APP_BIND_PORT=3535\n');
    expect(isDeployment(deployRoot)).toBe(true);

    const argv = composeArgv(['up', '-d'], composeProjectFor(undefined));

    expect(argv).toContain('-p');
    expect(argv[argv.indexOf('-p') + 1]).toBe('compose');
  });
});
