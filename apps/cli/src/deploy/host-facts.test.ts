import { describe, expect, it } from 'vitest';

import type { CommandResult, runCommand } from './executor.js';
import { OS_RELEASE_PATH, collectHostFacts, prettyNameFrom, type OsProbe } from './host-facts.js';

// =============================================================================
// Host facts  (issue #392)
// =============================================================================
//
// ⚠ `collectHostFacts` NEVER THROWS. It runs inside a deployment that has
// already succeeded, so every probe is isolated and an unknown is `null`.
// =============================================================================

const NOW = new Date('2026-09-20T08:39:02.000Z');

function answering(answers: Record<string, string>): typeof runCommand {
  return (async (argv: readonly string[]) => {
    const key = argv.join(' ');
    const stdout = answers[key];
    if (stdout === undefined) throw new Error(`unexpected: ${key}`);
    return {
      argv,
      cwd: '/',
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs: 0,
      timedOut: false,
    } satisfies CommandResult;
  }) as typeof runCommand;
}

const failing: typeof runCommand = (async () => {
  throw new Error('docker: command not found');
}) as typeof runCommand;

const fakeOs: OsProbe = {
  hostname: () => 'vps-app-01',
  type: () => 'Linux',
  release: () => '6.8.0-45-generic',
  arch: () => 'x64',
  cpus: () => [{}, {}, {}, {}],
  totalmem: () => 8_323_063_808,
};

describe('collectHostFacts', () => {
  it('collects every fact from the host, os-release and Docker', async () => {
    const facts = await collectHostFacts({
      runCommand: answering({
        'docker version --format {{.Server.Version}}': '27.3.1\n',
        'docker compose version --short': '2.29.7\n',
      }),
      readFile: (path) => {
        expect(path).toBe(OS_RELEASE_PATH);
        return 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n';
      },
      os: fakeOs,
      now: () => NOW,
    });

    expect(facts).toEqual({
      hostname: 'vps-app-01',
      os: 'Ubuntu 24.04.1 LTS',
      kernel: '6.8.0-45-generic',
      arch: 'x64',
      cpus: 4,
      memoryBytes: 8_323_063_808,
      dockerVersion: '27.3.1',
      composeVersion: '2.29.7',
      capturedAt: '2026-09-20T08:39:02.000Z',
    });
  });

  it('falls back to os.type() when /etc/os-release is unreadable', async () => {
    const facts = await collectHostFacts({
      runCommand: failing,
      readFile: () => {
        throw new Error('ENOENT');
      },
      os: fakeOs,
      now: () => NOW,
    });

    expect(facts.os).toBe('Linux');
  });

  it('answers null for Docker when the probes fail, and still returns', async () => {
    const facts = await collectHostFacts({
      runCommand: failing,
      readFile: () => 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"',
      os: fakeOs,
      now: () => NOW,
    });

    expect(facts.dockerVersion).toBeNull();
    expect(facts.composeVersion).toBeNull();
    expect(facts.hostname).toBe('vps-app-01');
  });

  it('answers null for a probe that exits non-zero or prints nothing', async () => {
    const facts = await collectHostFacts({
      runCommand: (async (argv: readonly string[]) => ({
        argv,
        cwd: '/',
        exitCode: argv.includes('compose') ? 0 : 1,
        stdout: '',
        stderr: 'Cannot connect to the Docker daemon',
        durationMs: 0,
        timedOut: false,
      })) as typeof runCommand,
      readFile: () => '',
      os: fakeOs,
      now: () => NOW,
    });

    expect(facts.dockerVersion).toBeNull();
    expect(facts.composeVersion).toBeNull();
  });

  it('never throws: every os probe failing yields nulls, not an exception', async () => {
    const boom = (): never => {
      throw new Error('boom');
    };
    const facts = await collectHostFacts({
      runCommand: failing,
      readFile: boom,
      os: {
        hostname: boom,
        type: boom,
        release: boom,
        arch: boom,
        cpus: boom,
        totalmem: boom,
      },
      now: boom,
    });

    expect(facts).toEqual({
      hostname: null,
      os: null,
      kernel: null,
      arch: null,
      cpus: null,
      memoryBytes: null,
      dockerVersion: null,
      composeVersion: null,
      capturedAt: null,
    });
  });

  it('treats a zero CPU count or memory size as unknown, not as a fact', async () => {
    const facts = await collectHostFacts({
      runCommand: failing,
      readFile: () => '',
      os: { ...fakeOs, cpus: () => [], totalmem: () => 0, hostname: () => '  ' },
      now: () => NOW,
    });

    expect(facts.cpus).toBeNull();
    expect(facts.memoryBytes).toBeNull();
    expect(facts.hostname).toBeNull();
  });
});

describe('prettyNameFrom', () => {
  it('reads double-quoted, single-quoted and bare values', () => {
    expect(prettyNameFrom('PRETTY_NAME="Ubuntu 24.04.1 LTS"')).toBe('Ubuntu 24.04.1 LTS');
    expect(prettyNameFrom("PRETTY_NAME='Alpine Linux v3.20'")).toBe('Alpine Linux v3.20');
    expect(prettyNameFrom('PRETTY_NAME=Arch')).toBe('Arch');
  });

  it('answers null when the key is absent or empty', () => {
    expect(prettyNameFrom('NAME="Ubuntu"\nID=ubuntu')).toBeNull();
    expect(prettyNameFrom('PRETTY_NAME=""')).toBeNull();
  });
});
