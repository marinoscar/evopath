import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { configDirPath, type ConfigContext } from '../config.js';

// =============================================================================
// Per-deployment screen preferences  (issue #315)
// =============================================================================
//
// What the deploy screens remember between runs, keyed by the deployment's
// root: today only the answer to "include the Android app?", so the next
// Deploy → Update opens with the same choice selected.
//
// Kept in the CLI's own config directory (`~/.<cli>/deploy-preferences.json`),
// NOT next to the deployment: the deploy root may be owned by another user,
// and nothing written there may dirty the checkout an update fast-forwards.
//
// ⚠ A PREFERENCE IS A CONVENIENCE, NEVER A FAILURE. Every read returns
// `undefined` on any problem (missing, unreadable, malformed) and every write
// swallows its error: a screen must never stop because a default could not be
// remembered.
// =============================================================================

export const DEPLOY_PREFERENCES_FILE = 'deploy-preferences.json';

export interface DeploymentPreferences {
  /** The last answer on the Android app step. */
  withAndroid?: boolean | undefined;
}

interface PreferencesFile {
  deployments: Record<string, DeploymentPreferences>;
}

export function deployPreferencesPath(ctx?: ConfigContext): string {
  return join(configDirPath(ctx), DEPLOY_PREFERENCES_FILE);
}

function readFile(ctx?: ConfigContext): PreferencesFile | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(deployPreferencesPath(ctx), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const deployments = (parsed as { deployments?: unknown }).deployments;
    if (typeof deployments !== 'object' || deployments === null || Array.isArray(deployments)) return undefined;
    return { deployments: deployments as Record<string, DeploymentPreferences> };
  } catch {
    return undefined;
  }
}

/** The remembered Android answer for this deployment, if there is one. */
export function readAndroidPreference(deployRoot: string, ctx?: ConfigContext): boolean | undefined {
  const value = readFile(ctx)?.deployments[resolve(deployRoot)]?.withAndroid;
  return typeof value === 'boolean' ? value : undefined;
}

/** Remember the Android answer for this deployment. Best effort; never throws. */
export function writeAndroidPreference(deployRoot: string, withAndroid: boolean, ctx?: ConfigContext): boolean {
  try {
    const file = readFile(ctx) ?? { deployments: {} };
    const key = resolve(deployRoot);
    file.deployments[key] = { ...file.deployments[key], withAndroid };
    const dir = configDirPath(ctx);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = deployPreferencesPath(ctx);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, target);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
    return true;
  } catch {
    return false;
  }
}
