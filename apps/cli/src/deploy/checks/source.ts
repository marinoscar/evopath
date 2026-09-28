import type { runCommand } from '../executor.js';
import { probe } from './host.js';
import type { Check, CheckContext, Severity } from './types.js';

// =============================================================================
// Can this server read the repository it deploys?  (issue #390, epic #388)
// =============================================================================
//
// Cloning a private repository over HTTPS needs a credential. Without one, the
// failure surfaces as a `git clone` authentication prompt in the middle of the
// `checkout` step -- on a server, over SSH, with no terminal to answer it.
//
// THE GITHUB CLI IS ONE WAY TO SUPPLY THAT CREDENTIAL, NOT A PREREQUISITE. A
// public repository needs nothing; a server whose access is an SSH deploy key
// needs a different mechanism entirely; a server with a credential helper
// already configured needs nothing more. So `gh-installed`/`gh-authenticated`
// are RECOMMENDED, and promote to REQUIRED only in the one case where the clone
// genuinely cannot proceed without them: an HTTPS GitHub URL that git cannot
// already read.
//
// Whether git can already read it is a network probe (`git ls-remote`), and a
// `severityFor` must be synchronous. So the probe runs ONCE, while the context
// is built (`gitCredentialStateFor`), and its answer rides on
// `CheckContext.gitCredentialed`.
// =============================================================================

/**
 * True for an `https://github.com/...` URL (credentials stripped first, `www.`
 * tolerated). SSH (`git@github.com:`, `ssh://`) and every other host are false:
 * the GitHub CLI is not how either of those authenticates.
 */
export function isHttpsGithubUrl(url: string): boolean {
  const stripped = url.trim().replace(/^(https:\/\/)[^@/]+@/i, '$1');
  return /^https:\/\/(www\.)?github\.com\/[^/\s]+\/[^/\s]+/i.test(stripped);
}

/**
 * The environment every non-interactive git/gh probe runs under.
 *
 * `GIT_TERMINAL_PROMPT=0` stops git asking on the terminal; `GIT_ASKPASS` set
 * to `/bin/true` answers any askpass request with an empty string, so a
 * missing credential fails fast instead of waiting on a prompt nobody sees; a
 * configured credential helper is consulted BEFORE askpass, so a real
 * credential still works. `GCM_INTERACTIVE=never` does the same for Git
 * Credential Manager, `GH_PROMPT_DISABLED` for gh.
 */
export function nonInteractiveGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/true',
    SSH_ASKPASS: '/bin/true',
    GCM_INTERACTIVE: 'never',
    GH_PROMPT_DISABLED: '1',
    NO_COLOR: '1',
  };
}

/**
 * True when git can read `url` right now without prompting: a public
 * repository, or one a configured credential helper / stored token covers.
 *
 * `git ls-remote <url> HEAD` is read-only and transfers only a ref list. Never
 * throws; any failure (auth, network, a missing git) is `false`. The URL is
 * passed as ONE argv element and refused if it could be read as an option.
 */
export async function gitHasCredentialFor(
  url: string,
  run: typeof runCommand,
): Promise<boolean> {
  if (url.trim() === '' || url.startsWith('-')) return false;
  const result = await probe({ runCommand: run }, ['git', 'ls-remote', url, 'HEAD'], {
    env: nonInteractiveGitEnv(),
    timeoutMs: 30_000,
  });
  return result.ok;
}

/**
 * The value for `CheckContext.gitCredentialed`.
 *
 * `undefined` when the URL is unknown or not an HTTPS GitHub URL -- the only
 * case the gh checks are ever promoted for, so the network probe is skipped
 * everywhere else.
 */
export async function gitCredentialStateFor(
  url: string | undefined,
  run: typeof runCommand,
): Promise<boolean | undefined> {
  if (url === undefined || !isHttpsGithubUrl(url)) return undefined;
  return await gitHasCredentialFor(url, run);
}

/**
 * True when the clone genuinely needs gh: an HTTPS GitHub URL that git was
 * PROBED and found unable to read. An unprobed context never promotes.
 */
export function needsGithubCli(context: Pick<CheckContext, 'repoUrl' | 'gitCredentialed'>): boolean {
  return (
    context.repoUrl !== undefined &&
    isHttpsGithubUrl(context.repoUrl) &&
    context.gitCredentialed === false
  );
}

/**
 * True when gh is known to be unnecessary: the URL is not HTTPS GitHub, or git
 * already reads it. Unknown (no URL, or not probed) is NOT "not needed".
 */
function githubCliNotNeeded(context: CheckContext): string | undefined {
  if (context.repoUrl === undefined) return undefined;
  if (!isHttpsGithubUrl(context.repoUrl)) {
    return `${context.repoUrl} is not an HTTPS GitHub URL`;
  }
  if (context.gitCredentialed === true) {
    return `git can already read ${context.repoUrl}`;
  }
  return undefined;
}

const ghSeverity = (context: CheckContext): Severity =>
  needsGithubCli(context) ? 'required' : 'recommended';

/** Why a failure is (or is not) blocking, appended to the detail. */
function consequence(context: CheckContext): string {
  return needsGithubCli(context)
    ? ` -- and git cannot read ${context.repoUrl as string} without a credential, so the clone would stop at an authentication prompt`
    : '';
}

const INSTALL_GH =
  'Install the GitHub CLI: apt-get install gh (from GitHub\'s apt repository -- see cli.github.com), ' +
  'then authenticate it with: gh auth login. Alternatively, use an SSH deploy key and an ssh:// or git@ repository URL.';

const ghInstalled: Check = {
  id: 'gh-installed',
  title: 'GitHub CLI installed',
  severity: 'recommended',
  severityFor: ghSeverity,
  requires: ['git-installed'],
  async run(context) {
    const result = await probe(context, ['gh', '--version'], { env: nonInteractiveGitEnv() });
    if (result.ok) {
      const version = result.stdout.split('\n')[0]?.replace(/^gh version /, '') ?? 'installed';
      return { status: 'pass', detail: version };
    }

    const notNeeded = githubCliNotNeeded(context);
    if (notNeeded !== undefined) {
      return { status: 'skip', detail: `not installed; not needed: ${notNeeded}` };
    }

    const severity = ghSeverity(context);
    return {
      status: severity === 'required' ? 'fail' : 'warn',
      detail: `not installed${consequence(context)}`,
      remedy: INSTALL_GH,
    };
  },
};

const ghAuthenticated: Check = {
  id: 'gh-authenticated',
  title: 'GitHub CLI authenticated',
  severity: 'recommended',
  severityFor: ghSeverity,
  requires: ['gh-installed'],
  async run(context) {
    // `gh auth status` masks tokens, but only lines that say WHO is logged in
    // are ever reported -- never a line mentioning a token.
    const result = await probe(context, ['gh', 'auth', 'status'], { env: nonInteractiveGitEnv() });
    const lines = `${result.stdout}\n${result.stderr}`
      .split('\n')
      .map((line) => line.trim().replace(/^[✓✗X!-]\s*/u, ''))
      .filter((line) => line !== '' && !/token/i.test(line));

    if (result.ok) {
      const who = lines.find((line) => /logged in/i.test(line)) ?? 'authenticated';
      const helper = needsGithubCli(context)
        ? '; install configures git to use it (gh auth setup-git)'
        : '';
      return { status: 'pass', detail: `${who}${helper}` };
    }

    const notNeeded = githubCliNotNeeded(context);
    if (notNeeded !== undefined) {
      return { status: 'skip', detail: `not logged in; not needed: ${notNeeded}` };
    }

    return {
      status: ghSeverity(context) === 'required' ? 'fail' : 'warn',
      detail: `not logged in${consequence(context)}`,
      remedy:
        'Log in once on this server: gh auth login (choose HTTPS), then: gh auth setup-git -- ' +
        'or set GH_TOKEN for the deploying user. Alternatively, use an SSH deploy key and an ssh:// or git@ repository URL.',
    };
  },
};

export const SOURCE_CHECKS: readonly Check[] = [ghInstalled, ghAuthenticated];

/** Ids of the checks that decide whether the checkout can authenticate. */
export const SOURCE_CHECK_IDS: ReadonlySet<string> = new Set(SOURCE_CHECKS.map((check) => check.id));
