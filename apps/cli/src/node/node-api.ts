import { ApiClient, resolveApiBaseUrl } from '../api-client.js';

// =============================================================================
// The typed surface of `/api/nodes/*`  (issue #273, epic #254)
// =============================================================================
//
// A thin, INTERFACE-FIRST wrapper over the generic `ApiClient`. The interface
// is the point: `NodeEngine` (#274), the daemon (#275), `doctor` (#276) and
// the TUI (#279) all take a `NodeApi` rather than an `ApiClient`, so every one
// of them is testable with a hand-written object and no network — which is
// what the "no network in unit tests" criterion on four separate issues
// actually requires.
//
// The shapes mirror the server DTOs in `apps/api/src/nodes/dto/`. They are
// hand-written rather than generated, and that is a deliberate, bounded
// duplication: generating them would need a build step in a package whose
// three build systems are documented at length in `packages/shared/index.js`.
// The one contract that genuinely must not drift — the per-type RESULT schema
// — is not duplicated at all: `GET /nodes/job-types` publishes it as JSON
// Schema generated from the server's own Zod, which is why that endpoint
// exists (#269).
// =============================================================================

/** A node row as the server reports it. Mirrors `WorkerNodeDto`. */
export interface WorkerNode {
  id: string;
  name: string;
  hostname: string;
  platform: string;
  cliVersion: string;
  eligibleTypes: string[];
  concurrency: number;
  status: string;
  capabilities: unknown;
  registeredAt: string;
  lastHeartbeatAt: string | null;
}

/** `POST /nodes/register`. */
export interface RegisterNodeRequest {
  name: string;
  hostname: string;
  platform: string;
  cliVersion: string;
  eligibleTypes: string[];
  concurrency: number;
  capabilities?: Record<string, unknown> | undefined;
}

export interface RegisterNodeResult {
  node: WorkerNode;
  /**
   * True when the server matched an existing `(owner, name)` row instead of
   * creating one. Surfaced rather than smoothed over: "reattached" and
   * "registered" are different facts, and an operator who expected a new node
   * and got a reattach has a name collision to resolve.
   */
  reattached: boolean;
}

/** One entry of `GET /nodes/job-types`. */
export interface NodeJobType {
  type: string;
  label: string;
  /** JSON Schema (2020-12) generated from the server's own Zod, or `null`. */
  resultSchema: Record<string, unknown> | null;
}

/** A job the server has leased to this node. Mirrors `NodeJobAssignmentDto`. */
export interface NodeJobAssignment {
  job: {
    id: string;
    type: string;
    subjectType: string | null;
    subjectId: string | null;
    priority: number;
    attempts: number;
    startedAt: string | null;
    leaseExpiresAt: string | null;
  };
  params: Record<string, unknown>;
  /**
   * How often the server wants this job's lease renewed, in milliseconds.
   *
   * OPTIONAL BECAUSE THE SERVER MIGHT BE OLDER THAN THIS CLI, not because it
   * is advisory — when it is present it is strictly better than any local
   * default, since it is derived from the very lease this job was granted.
   * See `NodeEngine.processJob` for the fallback.
   */
  renewIntervalMs?: number;
  /**
   * WHICH CLAIM OF THIS JOB THIS IS (#364) — quote it back on every call that
   * speaks for a held job, and the server can tell this claim from a later one.
   *
   * `claimedByNodeId` distinguishes one node from another but NOT ONE NODE FROM
   * ITSELF: a slot that stalls past its lease, is reaped, and then re-claims
   * the same job in a second slot still satisfies every server-side condition
   * the first slot's renewal ticker is checked against — so the stale slot
   * renews, or settles, the run its own newer slot is executing. The token is
   * minted per claimed ROW, so it is the one fact that tells the two apart.
   *
   * ⚠ OPTIONAL, AND `null`, ARE BOTH ORDINARY. A server older than #364 sends
   * no such field, and a row claimed before the column existed sends `null`.
   * Either way the node simply omits the key and gets exactly the behaviour it
   * had before — see `claimTokenBody`, which is the ONLY correct way to put
   * this value into a request body.
   */
  claimToken?: string | null;
}

/**
 * A claim token as it arrives — present, `null`, or absent.
 *
 * Deliberately widened to include both empty cases so that the raw value off
 * an assignment can be passed straight through without a call site ever having
 * to normalise it (and getting that normalisation wrong). `claimTokenBody` is
 * where the three states are resolved, once.
 */
export type ClaimToken = string | null | undefined;

/**
 * The body fragment asserting a claim: `{ claimToken }`, or nothing at all.
 *
 * ⚠ THE KEY IS OMITTED, NEVER SPELLED AS `null` — which is why this is a
 * function rather than an inline spread repeated at six call sites. The server
 * reads THREE distinct states off this one key (#364), and they are not
 * interchangeable:
 *
 *   - absent → "I am not asserting a claim". The server drops the
 *     `claim_token` clause and identifies this node exactly as it did before.
 *   - a uuid → "I assert this exact claim".
 *   - `null`  → "I assert this row carries NO token", which matches
 *     `claim_token IS NULL` — a real and different state, and the wrong
 *     assertion for a node that simply was not told one.
 *
 * `ApiClient` serialises bodies with `JSON.stringify`, which DROPS a key whose
 * value is `undefined` but faithfully writes one whose value is `null`. So a
 * `{ claimToken: null }` built by hand would reach the wire as the third
 * statement above and be refused with a 400 — the server's schema is
 * `.optional()` without `.nullable()`, on purpose, so that the mistake is loud
 * rather than silently reinterpreted.
 *
 * An empty result is a STEADY STATE, not a degraded one: it is precisely the
 * request every node made before #364, and it is what an older control plane
 * and a pre-#361 row both legitimately produce.
 */
export function claimTokenBody(claimToken: ClaimToken): { claimToken?: string } {
  return typeof claimToken === 'string' && claimToken.length > 0 ? { claimToken } : {};
}

export interface HeartbeatRequest {
  status?: 'online' | 'offline' | undefined;
  concurrency?: number | undefined;
  capabilities?: Record<string, unknown> | undefined;
}

export interface ClaimRequest {
  types?: string[] | undefined;
  limit?: number | undefined;
}

export interface DownloadUrlResult {
  url: string;
  expiresIn: number;
  expiresAt: string;
  objectId: string;
  /** A decimal STRING: the column is 64-bit and JSON has no such number. */
  size: string;
  mimeType: string;
}

export interface UploadUrlResult {
  url: string;
  /** The storage key the SERVER chose. A node cannot pick this. */
  key: string;
  expiresIn: number;
  expiresAt: string;
}

/**
 * `POST /nodes/:id/jobs/:jobId/secret` — the ONE credential a job may need.
 *
 * ⚠ EVERY FIELD OF `material` IS A SECRET UNTIL PROVEN OTHERWISE, and this
 * type is deliberately not narrowed into a `PgConnection`-shaped thing here:
 * the shape is the BROKER's business (a DSN, a token and an endpoint, a
 * discrete host/user/password set) and the executor that asked for it is the
 * only thing entitled to interpret it. What every caller must obey is the rule
 * `node-job-secret.dto.ts` states on the server side and `logger.ts` enforces
 * on this one: hold it in a local for the life of the job, never write it to
 * the config file or the state directory, never log it, and never hand it to
 * a child process that outlives the job.
 */
export interface JobSecret {
  /** e.g. `postgres.readonly` — which broker minted this, so a client knows how to read `material`. */
  kind: string;
  /** ISO 8601. Bounded by this job's LEASE; there is no second clock. */
  expiresAt: string;
  /** The credential itself. Passed through by the API without interpretation. */
  material: Record<string, unknown>;
}

export interface JobSettlement {
  jobId: string;
  outcome: string;
  willRetry: boolean;
}

export interface JobFailureReport {
  error: string;
  /** Set ONLY for a genuine provider throttle — see `node-engine.ts` (#274). */
  rateLimited?: boolean | undefined;
  retryAfterMs?: number | undefined;
  willRetry?: boolean | undefined;
}

/** A minted `nod_` credential. The `token` is returned exactly once. */
export interface CreatedNodeCredential {
  token: string;
  id: string;
  name: string;
  tokenPrefix: string;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * Everything a worker does over HTTP.
 *
 * Deliberately NOT `ApiClient` itself. A fake implementing this interface is
 * five lines; a fake `ApiClient` is a fetch stub plus an envelope, per test.
 */
export interface NodeApi {
  register(body: RegisterNodeRequest): Promise<RegisterNodeResult>;
  jobTypes(): Promise<NodeJobType[]>;
  listNodes(): Promise<WorkerNode[]>;
  getNode(nodeId: string): Promise<WorkerNode>;
  deregister(nodeId: string): Promise<void>;
  heartbeat(nodeId: string, body: HeartbeatRequest): Promise<WorkerNode>;
  claim(nodeId: string, body: ClaimRequest): Promise<NodeJobAssignment[]>;
  /**
   * Every method below speaks FOR A HELD JOB, and every one of them takes the
   * assignment's `claimToken` as a trailing optional argument (#364).
   *
   * Trailing and optional rather than folded into the existing bodies because
   * the token is not part of what any of these calls is ASKING for — it is the
   * caller identifying itself, the same fact at all six, and one uniform
   * argument keeps "renew quotes the token but failure forgets to" from being
   * a shape this interface can express. Pass the value straight off the
   * assignment: `ClaimToken` admits `null` and `undefined` so that no call site
   * has to normalise, and `claimTokenBody` resolves all three states in one
   * place.
   */
  renewLease(nodeId: string, jobId: string, claimToken?: ClaimToken): Promise<{ jobId: string; leaseExpiresAt: string }>;
  downloadUrl(nodeId: string, jobId: string, claimToken?: ClaimToken): Promise<DownloadUrlResult>;
  uploadUrl(nodeId: string, jobId: string, contentType?: string, claimToken?: ClaimToken): Promise<UploadUrlResult>;
  /**
   * Asks for this job's credential. Beyond the claim token the request body
   * carries NOTHING — every other field of it would be a node choosing part of
   * a credential's shape, and every one of those is the server's choice (see
   * the server DTO's header). The token is the exception because it is not a
   * request for anything; it is the answer to "which claim is asking", and a
   * credential minted for a lease a stale slot no longer holds is the exact
   * thing #364 exists to prevent.
   */
  jobSecret(nodeId: string, jobId: string, claimToken?: ClaimToken): Promise<JobSecret>;
  submitResult(nodeId: string, jobId: string, type: string, result: unknown, claimToken?: ClaimToken): Promise<JobSettlement>;
  reportJobFailure(nodeId: string, jobId: string, body: JobFailureReport, claimToken?: ClaimToken): Promise<JobSettlement>;
}

/** The `/api/node-credentials` half. Separate because a `nod_` token CANNOT reach it. */
export interface NodeCredentialApi {
  createCredential(body: { name: string; expiresInDays?: number | undefined }): Promise<CreatedNodeCredential>;
}

/** URL-encodes an id so a hand-set `NODE_ID` cannot smuggle a path segment. */
function seg(value: string): string {
  return encodeURIComponent(value);
}

/**
 * The real implementation, over `ApiClient`.
 *
 * `timeoutMs` is a constructor option rather than a per-call argument because
 * every route here is short: even `claim` returns immediately when the queue
 * is empty (the server does not long-poll), so a request outliving the default
 * is a stuck connection, not a slow answer.
 */
export class HttpNodeApi implements NodeApi, NodeCredentialApi {
  constructor(private readonly client: ApiClient) {}

  /** Build one from a server URL a human typed plus a bearer token. */
  static create(serverUrl: string, token: string, options?: { timeoutMs?: number | undefined; fetch?: typeof globalThis.fetch | undefined }): HttpNodeApi {
    return new HttpNodeApi(
      new ApiClient({
        baseUrl: resolveApiBaseUrl(serverUrl),
        token,
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.fetch !== undefined ? { fetch: options.fetch } : {}),
      }),
    );
  }

  register(body: RegisterNodeRequest): Promise<RegisterNodeResult> {
    return this.client.post<RegisterNodeResult>('/nodes/register', body);
  }

  async jobTypes(): Promise<NodeJobType[]> {
    const response = await this.client.get<{ types: NodeJobType[] }>('/nodes/job-types');
    return response.types ?? [];
  }

  listNodes(): Promise<WorkerNode[]> {
    return this.client.get<WorkerNode[]>('/nodes');
  }

  getNode(nodeId: string): Promise<WorkerNode> {
    return this.client.get<WorkerNode>(`/nodes/${seg(nodeId)}`);
  }

  async deregister(nodeId: string): Promise<void> {
    await this.client.post(`/nodes/${seg(nodeId)}/deregister`);
  }

  heartbeat(nodeId: string, body: HeartbeatRequest): Promise<WorkerNode> {
    return this.client.post<WorkerNode>(`/nodes/${seg(nodeId)}/heartbeat`, body);
  }

  async claim(nodeId: string, body: ClaimRequest): Promise<NodeJobAssignment[]> {
    const response = await this.client.post<{ jobs: NodeJobAssignment[] }>(`/nodes/${seg(nodeId)}/claim`, body);
    return response.jobs ?? [];
  }

  renewLease(nodeId: string, jobId: string, claimToken?: ClaimToken): Promise<{ jobId: string; leaseExpiresAt: string }> {
    // An empty object, not no body at all, when there is no token to quote:
    // the server's `renewLeaseSchema` carries a `.default({})` precisely so a
    // body-less POST from an older node stays legal, and `{}` is the same
    // request with a `Content-Type` the parser is happier about.
    return this.client.post(`/nodes/${seg(nodeId)}/jobs/${seg(jobId)}/renew`, claimTokenBody(claimToken));
  }

  downloadUrl(nodeId: string, jobId: string, claimToken?: ClaimToken): Promise<DownloadUrlResult> {
    return this.client.post<DownloadUrlResult>(
      `/nodes/${seg(nodeId)}/jobs/${seg(jobId)}/download-url`,
      claimTokenBody(claimToken),
    );
  }

  uploadUrl(nodeId: string, jobId: string, contentType?: string, claimToken?: ClaimToken): Promise<UploadUrlResult> {
    return this.client.post<UploadUrlResult>(
      `/nodes/${seg(nodeId)}/jobs/${seg(jobId)}/upload-url`,
      {
        ...(contentType === undefined ? {} : { contentType }),
        ...claimTokenBody(claimToken),
      },
    );
  }

  jobSecret(nodeId: string, jobId: string, claimToken?: ClaimToken): Promise<JobSecret> {
    // POST with an all-but-empty body, not GET: what comes back is a
    // credential, and a GET's URL is what every proxy log, CDN key and APM span
    // label writes down. The server answers `Cache-Control: no-store` for the
    // same reason. The claim token is the only field this body may carry.
    return this.client.post<JobSecret>(
      `/nodes/${seg(nodeId)}/jobs/${seg(jobId)}/secret`,
      claimTokenBody(claimToken),
    );
  }

  submitResult(nodeId: string, jobId: string, type: string, result: unknown, claimToken?: ClaimToken): Promise<JobSettlement> {
    return this.client.post<JobSettlement>(`/nodes/${seg(nodeId)}/jobs/${seg(jobId)}/result`, {
      type,
      result,
      ...claimTokenBody(claimToken),
    });
  }

  reportJobFailure(nodeId: string, jobId: string, body: JobFailureReport, claimToken?: ClaimToken): Promise<JobSettlement> {
    return this.client.post<JobSettlement>(`/nodes/${seg(nodeId)}/jobs/${seg(jobId)}/failure`, {
      ...body,
      ...claimTokenBody(claimToken),
    });
  }

  createCredential(body: { name: string; expiresInDays?: number | undefined }): Promise<CreatedNodeCredential> {
    return this.client.post<CreatedNodeCredential>('/node-credentials', body);
  }
}
