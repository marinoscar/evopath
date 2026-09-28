import { describe, expect, it } from 'vitest';

import { CommandFailedError, type CommandResult, type RunCommandOptions } from '../executor.js';
import {
  SOURCE_CHECKS,
  SOURCE_CHECK_IDS,
  gitCredentialStateFor,
  gitHasCredentialFor,
  isHttpsGithubUrl,
  needsGithubCli,
  nonInteractiveGitEnv,
} from './source.js';
import type { Check, CheckContext, CheckFs } from './types.js';

// =============================================================================
// Checks are driven through an injected runCommand returning canned output,
// same pattern as host.test.ts: the interesting input is what a tool prints,
// not a real gh/git.
// =============================================================================

type Canned = { exitCode: number; stdout?: string; stderr?: string };
type Responder = (argv: readonly string[], options: RunCommandOptions) => Canned | undefined;

function fakeRunCommand(respond: Responder): typeof import('../executor.js').runCommand {
  return (async (argv: readonly string[], options: RunCommandOptions): Promise<CommandResult> => {
    const canned = respond(argv, options) ?? { exitCode: 127, stderr: `${argv[0]}: command not found` };
    const result: CommandResult = {
      argv: [...argv],
      cwd: options.cwd,
      exitCode: canned.exitCode,
      stdout: canned.stdout ?? '',
      stderr: canned.stderr ?? '',
      durationMs: 1,
      timedOut: false,
    };
    if (result.exitCode !== 0) {
      throw new CommandFailedError(result.stderr || 'failed', result);
    }
    return result;
  }) as typeof import('../executor.js').runCommand;
}

const permissiveFs: CheckFs = {
  exists: () => true,
  isDirectory: () => true,
  isWritable: () => true,
  readFile: () => '',
  readdir: () => [],
};

function context(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    runCommand: fakeRunCommand(() => undefined),
    deployRoot: '/opt/infra/apps/demo',
    bindPort: 3535,
    proxyRoot: '/opt/infra/proxy',
    fs: permissiveFs,
    ...overrides,
  };
}

function find(id: string): Check {
  const check = SOURCE_CHECKS.find((candidate) => candidate.id === id);
  if (check === undefined) throw new Error(`no check ${id}`);
  return check;
}

describe('isHttpsGithubUrl', () => {
  it('is true for a plain https github URL', () => {
    expect(isHttpsGithubUrl('https://github.com/acme/widgets')).toBe(true);
  });

  it('is true with a trailing .git', () => {
    expect(isHttpsGithubUrl('https://github.com/acme/widgets.git')).toBe(true);
  });

  it('tolerates www.', () => {
    expect(isHttpsGithubUrl('https://www.github.com/acme/widgets')).toBe(true);
  });

  it('is true with embedded credentials, which it strips before testing', () => {
    // Userinfo assembled at runtime so secret scanners don't read the fixture as a credential.
    const userinfo = ['x-access-token', 'placeholder'].join(':');
    expect(isHttpsGithubUrl(`https://${userinfo}@github.com/acme/widgets`)).toBe(true);
  });

  it('is case-insensitive on scheme and host', () => {
    expect(isHttpsGithubUrl('HTTPS://GITHUB.COM/acme/widgets')).toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isHttpsGithubUrl('  https://github.com/acme/widgets  ')).toBe(true);
  });

  it('is false for an ssh URL, even to github', () => {
    expect(isHttpsGithubUrl('git@github.com:acme/widgets.git')).toBe(false);
  });

  it('is false for an explicit ssh:// scheme', () => {
    expect(isHttpsGithubUrl('ssh://git@github.com/acme/widgets.git')).toBe(false);
  });

  it('is false for a non-github host', () => {
    expect(isHttpsGithubUrl('https://gitlab.com/acme/widgets')).toBe(false);
  });

  it('is false for a github URL with no owner/repo', () => {
    expect(isHttpsGithubUrl('https://github.com/acme')).toBe(false);
  });

  it('is false for a bare host with nothing after it', () => {
    expect(isHttpsGithubUrl('https://github.com/')).toBe(false);
  });

  it('is false for an empty string', () => {
    expect(isHttpsGithubUrl('')).toBe(false);
  });
});

describe('nonInteractiveGitEnv', () => {
  it('sets every non-interactive flag git/gh/GCM read', () => {
    const env = nonInteractiveGitEnv({});

    expect(env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/true',
      SSH_ASKPASS: '/bin/true',
      GCM_INTERACTIVE: 'never',
      GH_PROMPT_DISABLED: '1',
      NO_COLOR: '1',
    });
  });

  it('extends the given base rather than replacing it', () => {
    const env = nonInteractiveGitEnv({ PATH: '/usr/bin', CUSTOM: 'x' });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.CUSTOM).toBe('x');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('defaults to process.env when no base is given', () => {
    const env = nonInteractiveGitEnv();
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });
});

describe('gitHasCredentialFor', () => {
  it('is false for an empty URL, without running anything', async () => {
    let called = false;
    const run = fakeRunCommand(() => {
      called = true;
      return { exitCode: 0 };
    });

    expect(await gitHasCredentialFor('', run)).toBe(false);
    expect(await gitHasCredentialFor('   ', run)).toBe(false);
    expect(called).toBe(false);
  });

  it('refuses a URL that could be read as an option, without running anything', async () => {
    let called = false;
    const run = fakeRunCommand(() => {
      called = true;
      return { exitCode: 0 };
    });

    expect(await gitHasCredentialFor('--upload-pack=evil', run)).toBe(false);
    expect(called).toBe(false);
  });

  it('runs `git ls-remote <url> HEAD` as one argv, non-interactively, and reports success', async () => {
    const seenArgv: string[][] = [];
    const seenEnv: Array<NodeJS.ProcessEnv | undefined> = [];
    const run = fakeRunCommand((argv, options) => {
      seenArgv.push([...argv]);
      seenEnv.push(options.env);
      return { exitCode: 0, stdout: 'abc123\tHEAD' };
    });

    const ok = await gitHasCredentialFor('https://github.com/acme/widgets', run);

    expect(ok).toBe(true);
    expect(seenArgv).toEqual([['git', 'ls-remote', 'https://github.com/acme/widgets', 'HEAD']]);
    expect(seenEnv[0]?.GIT_TERMINAL_PROMPT).toBe('0');
    expect(seenEnv[0]?.GIT_ASKPASS).toBe('/bin/true');
  });

  it('is false, never throwing, on any failure', async () => {
    const run = fakeRunCommand(() => ({ exitCode: 128, stderr: 'fatal: could not read Username' }));

    expect(await gitHasCredentialFor('https://github.com/acme/private', run)).toBe(false);
  });

  it('is false when the command itself is missing', async () => {
    const run = fakeRunCommand(() => undefined);

    expect(await gitHasCredentialFor('https://github.com/acme/widgets', run)).toBe(false);
  });
});

describe('gitCredentialStateFor', () => {
  it('is undefined -- not probed -- when the URL is unknown', async () => {
    let called = false;
    const run = fakeRunCommand(() => {
      called = true;
      return { exitCode: 0 };
    });

    expect(await gitCredentialStateFor(undefined, run)).toBeUndefined();
    expect(called).toBe(false);
  });

  it('is undefined -- not probed -- for a non-HTTPS-GitHub URL', async () => {
    let called = false;
    const run = fakeRunCommand(() => {
      called = true;
      return { exitCode: 0 };
    });

    expect(await gitCredentialStateFor('git@github.com:acme/widgets.git', run)).toBeUndefined();
    expect(await gitCredentialStateFor('https://gitlab.com/acme/widgets', run)).toBeUndefined();
    expect(called).toBe(false);
  });

  it('probes and returns the answer for an HTTPS GitHub URL', async () => {
    const run = fakeRunCommand(() => ({ exitCode: 0, stdout: 'ok' }));
    expect(await gitCredentialStateFor('https://github.com/acme/widgets', run)).toBe(true);

    const failing = fakeRunCommand(() => ({ exitCode: 128, stderr: 'auth failed' }));
    expect(await gitCredentialStateFor('https://github.com/acme/widgets', failing)).toBe(false);
  });
});

describe('needsGithubCli', () => {
  it('is false with no repoUrl', () => {
    expect(needsGithubCli({ repoUrl: undefined, gitCredentialed: false })).toBe(false);
  });

  it('is false for a non-github URL, regardless of gitCredentialed', () => {
    expect(needsGithubCli({ repoUrl: 'https://gitlab.com/acme/widgets', gitCredentialed: false })).toBe(false);
  });

  it('is false for an ssh github URL', () => {
    expect(needsGithubCli({ repoUrl: 'git@github.com:acme/widgets.git', gitCredentialed: false })).toBe(false);
  });

  it('is true only for an HTTPS github URL git was probed and found unable to read', () => {
    expect(needsGithubCli({ repoUrl: 'https://github.com/acme/widgets', gitCredentialed: false })).toBe(true);
  });

  it('is false when git can already read it', () => {
    expect(needsGithubCli({ repoUrl: 'https://github.com/acme/widgets', gitCredentialed: true })).toBe(false);
  });

  it('is false -- not promoted -- when unprobed (gitCredentialed undefined)', () => {
    expect(needsGithubCli({ repoUrl: 'https://github.com/acme/widgets', gitCredentialed: undefined })).toBe(false);
  });
});

describe('SOURCE_CHECKS / SOURCE_CHECK_IDS', () => {
  it('exposes exactly gh-installed and gh-authenticated', () => {
    expect(SOURCE_CHECKS.map((check) => check.id)).toEqual(['gh-installed', 'gh-authenticated']);
    expect(SOURCE_CHECK_IDS).toEqual(new Set(['gh-installed', 'gh-authenticated']));
  });

  it('gh-authenticated requires gh-installed', () => {
    expect(find('gh-authenticated').requires).toEqual(['gh-installed']);
  });
});

describe('gh-installed: the promotion matrix', () => {
  it('with no repoUrl at all, gh missing is only a WARN (recommended), with the install remedy', async () => {
    const result = await find('gh-installed').run(context());

    expect(result.status).toBe('warn');
    expect(result.remedy).toContain('gh auth login');
  });

  it('is SKIPPED (not needed) when the repo is not an HTTPS GitHub URL', async () => {
    const result = await find('gh-installed').run(
      context({ repoUrl: 'git@github.com:acme/widgets.git' }),
    );

    expect(result.status).toBe('skip');
    expect(result.detail).toContain('not needed');
    expect(result.detail).toContain('not an HTTPS GitHub URL');
  });

  it('is SKIPPED (not needed) when git can already read the HTTPS GitHub URL', async () => {
    const result = await find('gh-installed').run(
      context({ repoUrl: 'https://github.com/acme/widgets', gitCredentialed: true }),
    );

    expect(result.status).toBe('skip');
    expect(result.detail).toContain('git can already read');
  });

  it('is REQUIRED and FAILS when the HTTPS GitHub clone has no credential', async () => {
    const check = find('gh-installed');
    const ctx = context({ repoUrl: 'https://github.com/acme/widgets', gitCredentialed: false });

    expect(check.severityFor?.(ctx)).toBe('required');

    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not installed');
    expect(result.detail).toContain('https://github.com/acme/widgets');
    expect(result.detail).toContain('authentication prompt');
    expect(result.remedy).toContain('apt-get install gh');
  });

  it('stays RECOMMENDED (warn, not fail) when gitCredentialed is unprobed (undefined)', async () => {
    const check = find('gh-installed');
    const ctx = context({ repoUrl: 'https://github.com/acme/widgets', gitCredentialed: undefined });

    expect(check.severityFor?.(ctx)).toBe('recommended');
    const result = await check.run(ctx);
    expect(result.status).toBe('warn');
  });

  it('passes and reports the version when gh is installed', async () => {
    const result = await find('gh-installed').run(
      context({ runCommand: fakeRunCommand(() => ({ exitCode: 0, stdout: 'gh version 2.63.0 (2025-01-01)\n' })) }),
    );

    expect(result.status).toBe('pass');
    expect(result.detail).toBe('2.63.0 (2025-01-01)');
  });

  it('passes even when required, if gh happens to be installed', async () => {
    const result = await find('gh-installed').run(
      context({
        repoUrl: 'https://github.com/acme/widgets',
        gitCredentialed: false,
        runCommand: fakeRunCommand(() => ({ exitCode: 0, stdout: 'gh version 2.63.0\n' })),
      }),
    );

    expect(result.status).toBe('pass');
  });
});

describe('gh-authenticated: the promotion matrix and token safety', () => {
  it('with no repoUrl, not logged in is only a WARN, offering the SSH alternative', async () => {
    const result = await find('gh-authenticated').run(context());

    expect(result.status).toBe('warn');
    expect(result.remedy).toContain('gh auth login');
    expect(result.remedy).toContain('SSH deploy key');
  });

  it('is SKIPPED when gh is not needed at all', async () => {
    const result = await find('gh-authenticated').run(
      context({ repoUrl: 'https://gitlab.com/acme/widgets' }),
    );

    expect(result.status).toBe('skip');
  });

  it('is REQUIRED and FAILS when the HTTPS GitHub clone has no credential and gh is not logged in', async () => {
    const check = find('gh-authenticated');
    const ctx = context({ repoUrl: 'https://github.com/acme/widgets', gitCredentialed: false });

    expect(check.severityFor?.(ctx)).toBe('required');
    const result = await check.run(ctx);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not logged in');
    expect(result.remedy).toContain('gh auth login');
  });

  it('passes, naming who is logged in, and never echoes a token line', async () => {
    const result = await find('gh-authenticated').run(
      context({
        runCommand: fakeRunCommand(() => ({
          exitCode: 0,
          stdout:
            '✓ Logged in to github.com account someone (keyring)\n' +
            '- Active account: true\n' +
            '- Token: gho_SUPERSECRETVALUE1234567890\n' +
            '- Token scopes: repo, read:org',
        })),
      }),
    );

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('Logged in to github.com');
    expect(result.detail).not.toContain('gho_SUPERSECRETVALUE1234567890');
    expect(result.detail.toLowerCase()).not.toContain('token');
  });

  it('mentions gh auth setup-git only when this run actually needs gh for the clone', async () => {
    const needed = await find('gh-authenticated').run(
      context({
        repoUrl: 'https://github.com/acme/widgets',
        gitCredentialed: false,
        runCommand: fakeRunCommand(() => ({ exitCode: 0, stdout: '✓ Logged in to github.com account someone\n' })),
      }),
    );
    expect(needed.detail).toContain('gh auth setup-git');

    const notNeeded = await find('gh-authenticated').run(
      context({
        runCommand: fakeRunCommand(() => ({ exitCode: 0, stdout: '✓ Logged in to github.com account someone\n' })),
      }),
    );
    expect(notNeeded.detail).not.toContain('gh auth setup-git');
  });

  it('never echoes a token even when reporting the not-logged-in failure', async () => {
    const result = await find('gh-authenticated').run(
      context({
        repoUrl: 'https://github.com/acme/widgets',
        gitCredentialed: false,
        runCommand: fakeRunCommand(() => ({
          exitCode: 1,
          stderr: 'X Not logged in to github.com\n! GH_TOKEN=gho_leakme was set but is invalid',
        })),
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.detail.toLowerCase()).not.toContain('gho_leakme');
  });
});
