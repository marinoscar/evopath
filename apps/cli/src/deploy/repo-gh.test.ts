import { describe, expect, it } from 'vitest';

import { CommandFailedError, type CommandResult, type RunCommandOptions, type runCommand } from './executor.js';
import { configureGhCredentials } from './repo.js';

// =============================================================================
// gh supplies clone credentials only when that is what is needed  (#391)
// =============================================================================

const GITHUB_URL = ['https://', 'github', '.com/', 'owner/repo'].join('');

function fake(answers: Record<string, boolean>): { run: typeof runCommand; calls: string[] } {
  const calls: string[] = [];
  const run = (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    const line = argv.join(' ');
    calls.push(line);
    const ok = Object.entries(answers).find(([prefix]) => line.startsWith(prefix))?.[1] ?? false;
    const result: CommandResult = { argv, cwd: options.cwd, exitCode: ok ? 0 : 1, stdout: '', stderr: ok ? '' : 'nope', durationMs: 0, timedOut: false };
    if (!ok) throw new CommandFailedError('nope', result);
    return result;
  }) as typeof runCommand;
  return { run, calls };
}

describe('configureGhCredentials', () => {
  it('runs gh auth setup-git when git cannot read the URL and gh is logged in', async () => {
    const { run, calls } = fake({ 'git ls-remote': false, 'gh auth status': true, 'gh auth setup-git': true });
    expect(await configureGhCredentials(GITHUB_URL, run)).toBe('configured');
    expect(calls).toContain('gh auth setup-git');
  });

  it('does nothing when git can already read it', async () => {
    const { run, calls } = fake({ 'git ls-remote': true });
    expect(await configureGhCredentials(GITHUB_URL, run)).toBe('already-readable');
    expect(calls.some((call) => call.startsWith('gh '))).toBe(false);
  });

  it('does nothing when gh is not logged in', async () => {
    const { run, calls } = fake({ 'git ls-remote': false, 'gh auth status': false });
    expect(await configureGhCredentials(GITHUB_URL, run)).toBe('gh-unavailable');
    expect(calls).not.toContain('gh auth setup-git');
  });

  it('is "gh-unavailable" when gh is logged in but setup-git itself fails', async () => {
    const { run } = fake({ 'git ls-remote': false, 'gh auth status': true, 'gh auth setup-git': false });
    expect(await configureGhCredentials(GITHUB_URL, run)).toBe('gh-unavailable');
  });

  it('never runs anything for an SSH or non-GitHub URL', async () => {
    const { run, calls } = fake({});
    expect(await configureGhCredentials('git@github.com:owner/repo.git', run)).toBe('not-applicable');
    expect(await configureGhCredentials('https://example.test/owner/repo', run)).toBe('not-applicable');
    expect(calls).toEqual([]);
  });
});
