// =============================================================================
// Which compose files make up this deployment  (issue #531, epic #528)
// =============================================================================
//
// ONE list, read by every compose invocation: install, update, uninstall and
// the health gate. It used to be two hard-coded copies (install.ts and
// health.ts), which is how a stack ends up started with one set of files and
// inspected -- or torn down -- with another.
//
// The list depends on the deployment's groups, and those come from the flag
// on this run or from `state.groups` -- NEVER from reading the `.env`, for the
// reason `DeployState.groups` gives -- always widened by `effectiveGroups`.
//
// TELEMETRY IS ALWAYS ON for a VPS deployment (issue #567). `observability`
// used to be opt-in, and a deployment installed without it had no
// `greptimedb` container, so the admin telemetry page failed with "host
// greptimedb could not be resolved" and could only be fixed from a shell.
// Everything telemetry-related must be doable from the admin UI, so the stack
// ships with every deployment. Deploying it does not force export on:
// collection stays gated at runtime by the admin UI's telemetry toggle.
// `--group observability` is still accepted, as a harmless no-op.
//
// ORDER IS LOAD-BEARING:
//
//   base, prod, [telemetry], vps, [vps.telemetry]
//
//   - The VPS files come LAST. Their `ports: !override` only replaces what the
//     files BEFORE them published; applied earlier, a later file's ports would
//     merge back in and the service would be reachable on 0.0.0.0.
//   - telemetry.compose.yml adds services, so it sits before the VPS files and
//     inherits their hardening.
//   - vps.telemetry.compose.yml is separate from vps.compose.yml because a
//     service block for `greptimedb` in vps.compose.yml would be a service
//     with no image on every deployment WITHOUT telemetry, and compose rejects
//     the whole project for it.
// =============================================================================

import type { EnvGroup } from './env-metadata.js';

/** The group whose presence adds the telemetry stack. Always on; see above. */
export const TELEMETRY_GROUP = 'observability' satisfies EnvGroup;

/** Groups every VPS deployment has, whatever was passed or recorded. */
export const ALWAYS_ON_GROUPS: readonly EnvGroup[] = [TELEMETRY_GROUP];

/**
 * The groups a deployment actually runs with: the requested or recorded ones,
 * plus every always-on group. Order is kept and duplicates dropped.
 *
 * THE ONE PLACE this is decided. Install, update, uninstall, health, the
 * compose file list, the environment wizard and the update's drift check all
 * route through it, so an existing deployment whose `state.groups` predates
 * #567 gets the telemetry stack -- files and keys -- on its next update.
 */
export function effectiveGroups(groups?: readonly string[] | undefined): EnvGroup[] {
  const result: EnvGroup[] = [];
  for (const group of [...(groups ?? []), ...ALWAYS_ON_GROUPS]) {
    if (!result.includes(group as EnvGroup)) result.push(group as EnvGroup);
  }
  return result;
}

/**
 * The compose files for a deployment with these groups, in the order compose
 * must apply them. File names only; callers join the directory. The telemetry
 * files are always included (`effectiveGroups`).
 */
export function composeFilesFor(groups?: readonly string[] | undefined): string[] {
  const telemetry = effectiveGroups(groups).includes(TELEMETRY_GROUP);
  return [
    'base.compose.yml',
    'prod.compose.yml',
    ...(telemetry ? ['telemetry.compose.yml'] : []),
    'vps.compose.yml',
    ...(telemetry ? ['vps.telemetry.compose.yml'] : []),
  ];
}

/** `-f <file>` for each file, in order. */
export function composeFileArgs(groups?: readonly string[] | undefined): string[] {
  return composeFilesFor(groups).flatMap((file) => ['-f', file]);
}
