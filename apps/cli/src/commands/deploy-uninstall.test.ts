import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { UsageError } from '../errors.js';
import { registerDeployCommand, type DeployContext } from './deploy.js';

// =============================================================================
// `appctl deploy uninstall --drop-database`  (#522)
// =============================================================================
//
// The bug this pins: the typed name was checked, everything else was removed,
// success was printed -- and the database was never dropped. The operator is
// now told the outcome, including how many sessions were terminated.
// =============================================================================

const FAKE_DB_PASSWORD = 'not-a-real-password';

const DB_ENV = [
  'POSTGRES_DB=appdb',
  'POSTGRES_HOST=db.example.test',
  'POSTGRES_USER=postgres',
  `POSTGRES_PASSWORD=${FAKE_DB_PASSWORD}`,
  'APP_BIND_PORT=3535',
  '',
].join('\n');

const okResult = (stdout = '') => ({
  argv: [],
  cwd: '/tmp',
  exitCode: 0,
  stdout,
  stderr: '',
  durationMs: 1,
  timedOut: false,
});

function deployment(): string {
  const root = mkdtempSync(join(tmpdir(), 'appctl-uninstall-cmd-'));
  mkdirSync(join(root, 'repo', '.git'), { recursive: true });
  writeFileSync(join(root, '.env'), DB_ENV);
  return root;
}

async function runUninstall(
  argv: readonly string[],
  extra: Partial<DeployContext>,
): Promise<{ stdout: string; stderr: string; error: unknown }> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const program = new Command();
  program.exitOverride();
  registerDeployCommand(program, {
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    isTty: false,
    ...extra,
  });

  let error: unknown;
  try {
    await program.parseAsync(['deploy', 'uninstall', ...argv], { from: 'user' });
  } catch (caught) {
    error = caught;
  }
  return { stdout: stdout.join(''), stderr: stderr.join(''), error };
}

describe('deploy uninstall --drop-database', () => {
  it('shows the DROP in the inventory and prints the outcome with the session count', async () => {
    const root = deployment();
    const proxyRoot = mkdtempSync(join(tmpdir(), 'appctl-uninstall-proxy-'));

    const result = await runUninstall(
      ['--root', root, '--proxy-root', proxyRoot, '--drop-database', '--confirm-database', 'appdb'],
      { runCommand: vi.fn().mockResolvedValue(okResult()) as never },
    );

    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain('database appdb on db.example.test:5432 (DROP DATABASE)');
    expect(result.stderr).toMatch(/Dropped database appdb \(terminated 0 session\(s\)\)/);
    expect(existsSync(join(root, '.env'))).toBe(false);
  });

  it('a failed drop is an error, never a "Removed" line', async () => {
    const root = deployment();
    const proxyRoot = mkdtempSync(join(tmpdir(), 'appctl-uninstall-proxy-'));
    const run = vi.fn().mockImplementation(async (argv: readonly string[]) => {
      if (argv.includes('psql')) {
        return { ...okResult(), exitCode: 2, stderr: 'psql: error: connection refused' };
      }
      return okResult();
    });

    const result = await runUninstall(
      ['--root', root, '--proxy-root', proxyRoot, '--drop-database', '--confirm-database', 'appdb'],
      { runCommand: run as never },
    );

    expect(result.error).toBeInstanceOf(UsageError);
    expect((result.error as Error).message).toMatch(/NOT dropped/);
    expect(result.stderr).not.toMatch(/Removed /);
    expect(existsSync(join(root, '.env'))).toBe(true);
    expect(existsSync(join(root, 'repo'))).toBe(true);
  });
});
