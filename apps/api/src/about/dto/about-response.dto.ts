// =============================================================================
// What `GET /api/admin/about` answers with (issue #401, epic #397)
// =============================================================================
//
// ⚠ THIS ENDPOINT ALWAYS ANSWERS 200. There is no 404 for a missing document,
// no 500 for a malformed one and no 503 for an unreachable database. Every
// failure this surface can have is a FIELD, because the endpoint's entire job is
// to be readable when things are wrong — an operator opens it precisely when a
// deploy has gone sideways, and a status code is a strictly worse answer than a
// populated body that names what is missing.
//
// So the shape below is built to carry partial truth: the API's own version is
// always present, the deploy document's fields are present when a document was
// read and `null` when it was not, and the database is a fact of its own that
// can fail without taking the rest of the response with it.
//
// -----------------------------------------------------------------------------
// THE THREE DEPLOY STATES, AND THE THIRD IS THE ONE THAT GETS FORGOTTEN
// -----------------------------------------------------------------------------
//
//   1. `deployInfoStatus: 'ok'`   — a document was read, and `run.outcome` is
//                                   `'success'`.
//   2. `deployInfoStatus: 'absent'` (or `'invalid'`) — no usable document.
//   3. `deployInfoStatus: 'ok'` AND `run.outcome === 'failure'` — a document was
//      read, IT IS COMPLETE, and the deploy run that wrote it failed partway.
//
// The third is a first-class success of this endpoint, not an error of it. A run
// that got far enough to write `info.json` DID deploy something: there is a
// commit SHA on that box, there are steps in `run.completed` that really ran,
// and `run.failedStep` names the one that did not. Collapsing that into an error
// status — or into `deployInfoStatus: 'invalid'` — would throw away every fact
// the operator came for, at the exact moment they came for it. `run` is
// therefore surfaced as its own object, with `failedStep` beside `outcome`, so a
// client can render "deployed, then failed at <step>" without inferring
// anything.
//
// -----------------------------------------------------------------------------
// ⚠ WHY THE `absent` RESPONSE ASSERTS NOTHING
// -----------------------------------------------------------------------------
//
// There is deliberately NO field here meaning "this instance was not deployed
// with the CLI", and no copy to that effect anywhere in this module. That
// sentence is a claim about the world, and it is FALSE in at least three
// ordinary situations: `DEPLOY_INFO_PATH` points somewhere the file is not, the
// bind mount did not attach to this container, or a deploy run stopped before it
// got to writing the file. In all three the deployment was very much made with
// the CLI, and telling the operator otherwise sends them to rebuild something
// that is already there.
//
// What this response asserts instead is only what it actually knows: the status
// it got, and `deployInfoPath` — the exact path it looked at. That is the fact
// that resolves all three situations, and it is the client's job to word the
// sentence around it.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { DEPLOY_INFO_STATUSES } from '../deploy-info.constants';

/** The API process's own version — always known, never read from disk. */
export const aboutApiSchema = z.object({
  /**
   * Resolved by `openapi/version.ts`, the same function that stamps the
   * OpenAPI document, so the two can never disagree. Falls back to `'0.0.0'`
   * and never throws.
   */
  version: z.string(),
});

export const aboutAppSchema = z.object({
  name: z.string().nullable(),
  version: z.string().nullable(),
  /** The commit actually deployed. The single most useful field here. */
  commitSha: z.string().nullable(),
  /** The branch or tag the deploy was taken from. */
  ref: z.string().nullable(),
});

export const aboutDeployedBySchema = z.object({
  /** Which client wrote the document, e.g. `appctl`. */
  cli: z.string().nullable(),
  version: z.string().nullable(),
});

export const aboutRemoteSchema = z.object({
  /**
   * How far behind the remote this deployment was AT `checkedAt`.
   *
   * ⚠ COPIED FROM THE FILE, NEVER REFRESHED. This endpoint performs no network
   * I/O of any kind — it does not contact the deploy remote, does not run git,
   * and does not re-count anything. The number is as old as `checkedAt` says it
   * is, which is why the two always travel together.
   */
  commitsBehind: z.number().nullable(),
  checkedAt: z.string().nullable(),
});

export const aboutRunSchema = z.object({
  /** The deploy steps that completed, in the order the run recorded them. */
  completed: z.array(z.string()),
  /**
   * The step that failed, when `outcome` is `'failure'`.
   *
   * This is the third state's payload — see this file's header. A response
   * carrying `outcome: 'failure'` is still a complete, trustworthy report of
   * everything the run managed to do.
   */
  failedStep: z.string().nullable(),
  outcome: z.enum(['success', 'failure']).nullable(),
});

// --- Issue #392: additive document fields ------------------------------------

export const aboutProxySchema = z.object({
  /** `container` — the bundled proxy container; `host` — a proxy on the host. */
  mode: z.enum(['container', 'host']).nullable(),
  /** The proxy container's name, when `mode` is `container`. */
  container: z.string().nullable(),
  /**
   * ISO-8601. ⚠ AS OBSERVED BY THE CLI WHEN IT WROTE THE FILE — this endpoint
   * does not probe the certificate.
   */
  certificateExpiresAt: z.string().nullable(),
});

export const aboutHostSchema = z.object({
  hostname: z.string().nullable(),
  /** e.g. `Ubuntu 24.04.1 LTS` (os-release PRETTY_NAME) or `os.type()`. */
  os: z.string().nullable(),
  /** `os.release()`. */
  kernel: z.string().nullable(),
  /** `os.arch()`. */
  arch: z.string().nullable(),
  cpus: z.number().int().nullable(),
  /** `os.totalmem()`, in bytes. */
  memoryBytes: z.number().int().nullable(),
  dockerVersion: z.string().nullable(),
  composeVersion: z.string().nullable(),
  /** ISO-8601. Every fact above is as of this moment, never live. */
  capturedAt: z.string().nullable(),
});

export const aboutHistoryEntrySchema = z.object({
  /** ISO-8601 finish time of the run. */
  at: z.string(),
  command: z.enum(['install', 'update']),
  commitSha: z.string().nullable(),
  /** The commit the run replaced; `null` for an install. */
  previousCommitSha: z.string().nullable(),
  ref: z.string().nullable(),
  durationMs: z.number().nullable(),
  cliVersion: z.string().nullable(),
  /** The history is success-only; a failed run is reported by `run`, not here. */
  outcome: z.literal('success'),
});

/**
 * Live facts about THIS API process — the only part of the response not read
 * from the deploy document, and so the only part that is always current.
 */
export const aboutRuntimeSchema = z.object({
  /** ISO-8601; when this process started (now minus `process.uptime()`). */
  processStartedAt: z.string(),
  /** `process.version`, e.g. `v22.11.0`. */
  nodeVersion: z.string(),
  /** `NODE_ENV`, or `null` when unset. */
  environment: z.string().nullable(),
});

export const aboutDatabaseSchema = z.object({
  status: z.string(),
  /** Round-trip time of the probe, as the health module already formats it. */
  responseTime: z.string(),
});

export const aboutResponseSchema = z.object({
  api: aboutApiSchema,

  /**
   * `ok` — a document was read. `absent` — nothing at `deployInfoPath`.
   * `invalid` — something is there and it could not be used.
   *
   * ⚠ NONE OF THE THREE IS AN ERROR STATUS. All three are 200.
   */
  deployInfoStatus: z.enum(DEPLOY_INFO_STATUSES),

  /**
   * The exact path that was read.
   *
   * Always present, including on `ok`, because it is the field that makes an
   * `absent` answer actionable without asserting anything false about it.
   */
  deployInfoPath: z.string(),

  /** Why the document is `invalid`. `null` for `ok` and for `absent`. */
  deployInfoError: z.string().nullable(),

  // --- Everything below is read from the document; all `null` when absent. ---

  app: aboutAppSchema.nullable(),
  /** When the deployment was first installed. `null` if the disk says nothing. */
  installedAt: z.string().nullable(),
  /** When it was last updated. `null` if the disk says nothing. */
  updatedAt: z.string().nullable(),
  deployedBy: aboutDeployedBySchema.nullable(),
  domain: z.string().nullable(),
  remote: aboutRemoteSchema.nullable(),
  run: aboutRunSchema.nullable(),

  /** Which `appctl deploy` subcommand last wrote the document. */
  lastCommand: z.enum(['install', 'update']).nullable(),
  /** The host port the stack is bound to (1–65535). */
  bindPort: z.number().int().nullable(),
  proxy: aboutProxySchema.nullable(),
  host: aboutHostSchema.nullable(),
  /**
   * Successful deploy runs, newest first, at most 20.
   *
   * `null` when no document was read (like every other document field); `[]`
   * when a document was read but carries no history — the difference between
   * "cannot know" and "knows there is none".
   */
  history: z.array(aboutHistoryEntrySchema).nullable(),

  /** Live facts about this API process. Always present, never from disk. */
  runtime: aboutRuntimeSchema,

  /**
   * A liveness fact about the database, from the same indicator
   * `GET /api/health/ready` uses.
   *
   * ⚠ `null` PLUS `databaseError`, NEVER A 503. An about page that cannot be
   * loaded while the database is down is an about page that is missing whenever
   * it matters — and the API version, the deploy document and the commit SHA
   * are all still perfectly knowable with no database at all.
   */
  database: aboutDatabaseSchema.nullable(),
  databaseError: z.string().nullable(),
});

export class AboutResponseDto extends createZodDto(aboutResponseSchema) {}

export type AboutResponse = z.infer<typeof aboutResponseSchema>;
