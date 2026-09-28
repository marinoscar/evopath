/**
 * `deploy-info/info.json` — the note this CLI leaves for the running application.
 *
 * =============================================================================
 * ⚠ THE OTHER HALF OF THE ABOUT PAGE, AND IT WAS MISSING
 * =============================================================================
 *
 * `apps/api/src/about/deploy-info.ts` reads this document, `vps.compose.yml`
 * bind-mounts the directory read-only into the api container, and the Console's
 * About page renders it. All three shipped. Nothing wrote the file — install
 * created the DIRECTORY (so the bind mount would not be created root-owned by
 * Docker) and stopped there. So the About page reported `absent` on every
 * deployment, including ones this CLI had just deployed, and said so in copy
 * carefully written not to assert a negative — which was the only reason it did
 * not read as a lie.
 *
 * =============================================================================
 * ⚠ WRITTEN AT THE HEALTH GATE, NOT AT THE END
 * =============================================================================
 *
 * If the API is answering, the application demonstrably IS deployed, and this
 * document should describe it. Writing it at the end of the pipeline means a
 * failure in `publish` — between health and the end — leaves the About page
 * reporting nothing at all about a deployment that is up and serving, which is
 * exactly when somebody is looking at it.
 *
 * That is why `run` exists in the document: a run that got far enough to write
 * this file did deploy something, and the page's third state — complete, but
 * the run did not finish — is rendered from `run.outcome` plus `run.failedStep`.
 *
 * ⚠ AND REWRITTEN ONCE MORE AT THE END OF A SUCCESSFUL RUN (issue #392). The
 * health-gate write cannot carry this run's `history` entry (history is
 * success-only, and the run has not succeeded yet) nor the certificate
 * `publish` has yet to issue. Install and update build both writes from one
 * builder, so the second only ADDS what the run learned since; a run that fails
 * after the health gate leaves the first write — with the prior history —
 * standing, which is exactly the "complete, but did not finish" state.
 *
 * =============================================================================
 * ⚠ THREE RULES THE READER DEPENDS ON
 * =============================================================================
 *
 * 1. `schema` IS 1 AND DOES NOT MOVE. The reader validates it strictly and
 *    everything else leniently, precisely so new fields need no bump. A bump to
 *    add an optional field makes every already-deployed API answer `invalid`
 *    the instant a newer CLI writes its file — before the container it
 *    describes has necessarily restarted.
 * 2. `null` IS THE IDIOM FOR KNOWN-TO-BE-ABSENT. Never omit a key to mean "I do
 *    not know"; the reader turns a missing value into `null` anyway, and an
 *    explicit one says a human decided rather than that a writer forgot.
 * 3. THE WRITE IS ATOMIC, and the DIRECTORY is what is mounted, not the file.
 *    A rename over an existing path gives the container the new document with
 *    no restart; bind-mounting the file itself would pin an inode and leave the
 *    container reading the old one for ever.
 */
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLI_NAME } from '../branding.js';

import type { DeploymentHistoryEntry, HostFacts } from './state.js';

/** The one value `schema` may hold. See rule 1 above. */
export const DEPLOY_INFO_SCHEMA_VERSION = 1;

export const DEPLOY_INFO_DIRNAME = 'deploy-info';
export const DEPLOY_INFO_FILENAME = 'info.json';

export interface DeployInfoInput {
  name: string;
  version?: string | undefined;
  commitSha?: string | undefined;
  ref?: string | undefined;
  installedAt?: string | undefined;
  updatedAt?: string | undefined;
  cliVersion?: string | undefined;
  domain?: string | undefined;
  /** Step ids that completed, in order. */
  completed?: readonly string[] | undefined;
  failedStep?: string | undefined;
  outcome?: 'success' | 'failure' | undefined;
  /** Which command wrote this document (issue #392). */
  lastCommand?: 'install' | 'update' | undefined;
  /** Loopback port the proxy forwards to. */
  bindPort?: number | undefined;
  /** How the shared proxy publishes this deployment; absent means not known. */
  proxy?:
    | {
        mode?: 'container' | 'host' | null | undefined;
        container?: string | null | undefined;
        certificateExpiresAt?: string | null | undefined;
      }
    | undefined;
  /** The host, as `collectHostFacts` observed it; absent means not known. */
  host?: HostFacts | undefined;
  /** The deployment state's own history -- the SAME entries, newest first. */
  history?: readonly DeploymentHistoryEntry[] | undefined;
}

/** `undefined` becomes `null`; see rule 2. */
function orNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

export function buildDeployInfo(input: DeployInfoInput): Record<string, unknown> {
  return {
    schema: DEPLOY_INFO_SCHEMA_VERSION,
    app: {
      name: input.name,
      version: orNull(input.version),
      commitSha: orNull(input.commitSha),
      ref: orNull(input.ref),
    },
    installedAt: orNull(input.installedAt),
    updatedAt: orNull(input.updatedAt),
    deployedBy: {
      cli: CLI_NAME,
      version: orNull(input.cliVersion),
    },
    domain: orNull(input.domain),
    // ⚠ `null`, NOT a fabricated zero. This CLI does not ask the remote how far
    // ahead it is at deploy time, and "0 commits behind" is a claim, not an
    // absence. The reader renders null as "not known", which is true.
    remote: null,
    run: {
      completed: [...(input.completed ?? [])],
      failedStep: orNull(input.failedStep),
      // A document written at the health gate describes a deployment that is
      // answering. `success` here means the steps up to this point succeeded;
      // a later failure rewrites it with the failed step named.
      outcome: orNull(input.outcome) ?? 'success',
    },
    // ⚠ ISSUE #392's ADDITIVE FIELDS. `schema` stays 1 (rule 1), every key is
    // ALWAYS written (rule 2), and each object is rebuilt key by key rather
    // than spread, so the document's shape is exactly the contract's and a
    // field added to an internal type can never leak into it. The shared
    // fixture `apps/api/test/fixtures/deploy-info.sample.json` pins that shape
    // from both sides.
    lastCommand: orNull(input.lastCommand),
    bindPort: orNull(input.bindPort),
    proxy:
      input.proxy === undefined
        ? null
        : {
            mode: orNull(input.proxy.mode),
            container: orNull(input.proxy.container),
            certificateExpiresAt: orNull(input.proxy.certificateExpiresAt),
          },
    host:
      input.host === undefined
        ? null
        : {
            hostname: input.host.hostname,
            os: input.host.os,
            kernel: input.host.kernel,
            arch: input.host.arch,
            cpus: input.host.cpus,
            memoryBytes: input.host.memoryBytes,
            dockerVersion: input.host.dockerVersion,
            composeVersion: input.host.composeVersion,
            capturedAt: input.host.capturedAt,
          },
    history: (input.history ?? []).map((entry) => ({
      at: entry.at,
      command: entry.command,
      commitSha: entry.commitSha,
      previousCommitSha: entry.previousCommitSha,
      ref: entry.ref,
      durationMs: entry.durationMs,
      cliVersion: entry.cliVersion,
      outcome: entry.outcome,
    })),
  };
}

export function deployInfoPath(deployRoot: string): string {
  return join(deployRoot, DEPLOY_INFO_DIRNAME, DEPLOY_INFO_FILENAME);
}

/**
 * Writes the document atomically into the bind-mounted directory.
 *
 * ⚠ NEVER THROWS. This is BOOKKEEPING ABOUT a deployment, not the deployment:
 * it runs after the API is answering, so a failure here must not fail a run
 * that has already succeeded. The caller journals what came back.
 */
export function writeDeployInfo(
  deployRoot: string,
  input: DeployInfoInput,
): { written: boolean; path: string; error?: string | undefined } {
  const path = deployInfoPath(deployRoot);
  const temporary = `${path}.tmp`;

  try {
    writeFileSync(temporary, `${JSON.stringify(buildDeployInfo(input), null, 2)}\n`);
    renameSync(temporary, path);
    return { written: true, path };
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // It may never have been created. Nothing to report.
    }
    return { written: false, path, error: (error as Error).message };
  }
}
