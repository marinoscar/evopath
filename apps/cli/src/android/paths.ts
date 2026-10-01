import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { CLI_NAME, envVar } from '../branding.js';
import { configDirPath } from '../config.js';
import { PreconditionError } from '../errors.js';

// =============================================================================
// Where the Android pieces live  (issue #286, epic #276)
// =============================================================================
//
// Two roots, and they must not be confused:
//
//   - the REPOSITORY root, which holds `apps/android` (sources, gradlew,
//     version.properties) and receives `dist/android/` build outputs;
//   - the per-user STATE directory `~/.evopathcli/android/`, which holds the
//     release keystore and its passwords — deliberately outside every
//     checkout, so no `git add -A` can ever pick them up.
// =============================================================================

/** `EVOPATHCLI_REPO_ROOT`: point the android commands at a checkout explicitly. */
export const REPO_ROOT_ENV_VAR = envVar('REPO_ROOT');

/** Extra arguments appended to every Gradle invocation (advanced; e.g. `-I mirror.init.gradle.kts`). */
export const GRADLE_ARGS_ENV_VAR = envVar('GRADLE_ARGS');

export const ANDROID_APP_DIR = join('apps', 'android');

export interface AndroidPathsContext {
  env?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
  cwd?: string | undefined;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The repository root: the nearest ancestor of `cwd` holding `apps/android`,
 * or the explicit `EVOPATHCLI_REPO_ROOT`.
 *
 * Returns `undefined` rather than throwing, so `doctor` can report it as a
 * check; `requireRepoRoot` is the throwing form for the commands that need it.
 */
export function findRepoRoot(ctx?: AndroidPathsContext): string | undefined {
  const env = ctx?.env ?? process.env;
  const explicit = env[REPO_ROOT_ENV_VAR];
  if (explicit !== undefined && explicit.trim() !== '') {
    const root = resolve(explicit.trim());
    return isDirectory(join(root, ANDROID_APP_DIR)) ? root : undefined;
  }

  let current = resolve(ctx?.cwd ?? process.cwd());
  for (;;) {
    if (isDirectory(join(current, ANDROID_APP_DIR))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function requireRepoRoot(ctx?: AndroidPathsContext): string {
  const root = findRepoRoot(ctx);
  if (root === undefined) {
    throw new PreconditionError(
      `Could not find ${ANDROID_APP_DIR} in this directory or any parent. ` +
        `Run ${CLI_NAME} from inside the repository, or set ${REPO_ROOT_ENV_VAR} to its root.`,
    );
  }
  return root;
}

export function androidProjectDir(repoRoot: string): string {
  return join(repoRoot, ANDROID_APP_DIR);
}

export function versionPropertiesPath(repoRoot: string): string {
  return join(androidProjectDir(repoRoot), 'version.properties');
}

export function distDir(repoRoot: string): string {
  return join(repoRoot, 'dist', 'android');
}

/** `~/.evopathcli/android` — keystore and signing passwords. */
export function androidStateDir(ctx?: AndroidPathsContext): string {
  return join(configDirPath(ctxForConfig(ctx)), 'android');
}

/** `~/.evopathcli/android-sdk` — where `doctor --fix` installs the SDK. */
export function managedSdkDir(ctx?: AndroidPathsContext): string {
  return join(configDirPath(ctxForConfig(ctx)), 'android-sdk');
}

function ctxForConfig(ctx?: AndroidPathsContext): { home?: string } {
  return { home: ctx?.home ?? homedir() };
}

/** Split `EVOPATHCLI_GRADLE_ARGS` on whitespace, honouring simple quotes. */
export function extraGradleArgs(env: NodeJS.ProcessEnv): string[] {
  const raw = env[GRADLE_ARGS_ENV_VAR];
  if (raw === undefined || raw.trim() === '') return [];
  const args: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return args;
}
