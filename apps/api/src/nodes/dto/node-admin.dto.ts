// =============================================================================
// The admin fleet's wire shapes (issue #270, epic #254)
// =============================================================================
//
// These are NOT `WorkerNodeDto` with extra fields, and the duplication is
// deliberate. `WorkerNodeDto` is what a WORKER NODE receives about itself: it
// crosses the boundary to an unattended machine this deployment may not own,
// and issue #268 chose every field on it with that in mind. The shapes here
// cross to an administrator's browser and carry two things a node must never
// be handed:
//
//   - `owner`, which names another user by email. A node credential resolves
//     to one user; telling a remote worker who else runs nodes here is an
//     enumeration of this deployment's operators for no operational purpose.
//   - `jobCounts`, which summarises the whole queue's state for that node.
//
// Merging the two classes would mean one `@ApiProperty` added in the wrong
// place publishes an operator's email to every worker in the fleet. Two
// classes make that a thing somebody has to do on purpose.
//
// `health` appears ONLY here, and it is DERIVED at read time by
// `deriveNodeHealth` — there is no `health` column and there must not be one.
// See `node-lifecycle.service.ts` for why a stored verdict is the same bug
// this issue exists to fix, one layer up.
// =============================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Who registered a node or minted a credential. */
export class NodeOwnerDto {
  @ApiProperty({ description: 'User ID (UUID)' })
  id!: string;

  @ApiProperty({ description: 'Email address' })
  email!: string;

  @ApiPropertyOptional({ description: 'Display name, when the account has one', nullable: true })
  name!: string | null;
}

/**
 * How many jobs a node currently has in each state.
 *
 * The four keys are always present and always numbers, zero included. A sparse
 * map would make the fleet page write `counts.running ?? 0` at every use, and
 * the first place somebody forgot would render an empty cell for a node with
 * no running jobs — indistinguishable from a node whose count failed to load.
 */
export class NodeJobCountsDto {
  @ApiProperty({ description: 'Jobs this node holds right now' })
  running!: number;

  @ApiProperty({ description: 'Jobs assigned to this node and not yet started' })
  pending!: number;

  @ApiProperty({ description: 'Jobs this node completed successfully' })
  succeeded!: number;

  @ApiProperty({ description: 'Jobs this node failed' })
  failed!: number;

  @ApiProperty({ description: 'The sum of the four counts above' })
  total!: number;
}

/**
 * A node's cumulative counters since its process started (#129). Reset when
 * the node restarts, so a drop is a restart, not a correction.
 */
export class NodeVitalsCountersDto {
  @ApiPropertyOptional({ description: 'Claim calls that returned at least one job' })
  claims?: number;

  @ApiPropertyOptional({ description: 'Claim calls that returned no jobs' })
  emptyPolls?: number;

  @ApiPropertyOptional({ description: 'Claim calls that failed' })
  claimFailures?: number;

  @ApiPropertyOptional({ description: 'Jobs this process completed successfully' })
  succeeded?: number;

  @ApiPropertyOptional({ description: 'Jobs this process reported as failed' })
  failed?: number;

  @ApiPropertyOptional({ description: 'Jobs this process reported as rate-limited' })
  rateLimited?: number;

  @ApiPropertyOptional({ description: 'Successful lease renewals' })
  leaseRenewals?: number;

  @ApiPropertyOptional({ description: 'Lease renewals that failed' })
  leaseRenewFailures?: number;

  @ApiPropertyOptional({ description: 'Heartbeats that failed' })
  heartbeatFailures?: number;

  @ApiPropertyOptional({ description: 'Times the node’s job watchdog aborted a job' })
  watchdogTrips?: number;
}

/**
 * The last health snapshot a node reported on its heartbeat (#129).
 *
 * SELF-REPORTED AND UNTRUSTED: validated and bounded on the way in
 * (`nodeVitalsSchema` in `node-control-plane.dto.ts`), but never used for a
 * scheduling decision — display only. Every field is optional; a node reports
 * what it can measure.
 */
export class NodeVitalsDto {
  @ApiPropertyOptional({
    description: 'Process CPU over the last interval; 100 = one full core',
    maximum: 12800,
  })
  cpuPercent?: number;

  @ApiPropertyOptional({ description: 'Resident set size, bytes' })
  rssBytes?: number;

  @ApiPropertyOptional({ description: 'V8 heap in use, bytes' })
  heapUsedBytes?: number;

  @ApiPropertyOptional({ description: 'V8 heap limit, bytes' })
  heapLimitBytes?: number;

  @ApiPropertyOptional({ description: 'Event-loop delay p99 over the last interval, milliseconds' })
  eventLoopDelayP99Ms?: number;

  @ApiPropertyOptional({
    description: 'Free bytes on the filesystem holding the node’s state directory',
  })
  stateDirFreeBytes?: number;

  @ApiPropertyOptional({
    description: 'Total bytes on the filesystem holding the node’s state directory',
  })
  stateDirTotalBytes?: number;

  @ApiPropertyOptional({ description: 'Job slots in use', maximum: 64 })
  slotsUsed?: number;

  @ApiPropertyOptional({ description: 'Job slots available in total', maximum: 64 })
  slotsTotal?: number;

  @ApiPropertyOptional({ description: 'Node process uptime, seconds' })
  uptimeSeconds?: number;

  @ApiPropertyOptional({
    description: 'Cumulative counters since the node process started',
    type: NodeVitalsCountersDto,
  })
  counters?: NodeVitalsCountersDto;

  @ApiPropertyOptional({ description: 'The node CLI’s version', maxLength: 64 })
  cliVersion?: string;

  @ApiPropertyOptional({ description: 'The Node.js runtime version', maxLength: 64 })
  nodeVersion?: string;

  @ApiPropertyOptional({
    description: 'The `pg_dump` version on the node, when it has one',
    maxLength: 64,
  })
  pgDumpVersion?: string;
}

/** One node as the admin fleet page sees it. */
export class AdminNodeDto {
  @ApiProperty({ description: 'Node ID (UUID)' })
  id!: string;

  @ApiProperty({ description: 'Operator-chosen name, unique per owner' })
  name!: string;

  @ApiProperty({ description: 'Self-reported host name' })
  hostname!: string;

  @ApiProperty({ description: 'Self-reported platform (e.g. `linux-x64`)' })
  platform!: string;

  @ApiProperty({ description: 'Self-reported CLI version' })
  cliVersion!: string;

  @ApiProperty({ description: 'The job types this node declared it can run', type: [String] })
  eligibleTypes!: string[];

  @ApiProperty({ description: 'The node’s declared concurrency ceiling' })
  concurrency!: number;

  @ApiProperty({
    description:
      'Operator/administrative state — NOT liveness. `disabled` refuses this node’s claims; ' +
      '`draining` lets it finish what it holds and claim nothing new. A node reaches `offline` ' +
      'either by deregistering gracefully or by being swept there after it stopped heartbeating.',
    enum: ['online', 'draining', 'offline', 'disabled'],
  })
  status!: string;

  @ApiProperty({
    description:
      'DERIVED liveness, computed from `lastHeartbeatAt` at read time and never stored. ' +
      '`offline` when the status already says so; `healthy` when the last heartbeat is inside ' +
      'the `nodes.staleHeartbeatSeconds` window; `stale` otherwise — including a node that has ' +
      'never heartbeated at all. Read alongside `status`, not instead of it: a `disabled` node ' +
      'that is still heartbeating is both disabled and healthy.',
    enum: ['healthy', 'stale', 'offline'],
  })
  health!: string;

  @ApiPropertyOptional({
    description: 'The node’s last self-reported capability summary, or `null`',
    nullable: true,
    type: Object,
  })
  capabilities!: unknown;

  @ApiProperty({ description: 'ISO 8601 timestamp of first registration' })
  registeredAt!: string;

  @ApiPropertyOptional({
    description: 'ISO 8601 timestamp of the last heartbeat, or `null` if it has never sent one',
    nullable: true,
  })
  lastHeartbeatAt!: string | null;

  @ApiPropertyOptional({
    description:
      'The last health snapshot the node reported on a heartbeat, or `null` if it has never ' +
      'reported one. Self-reported and bounded, never trusted for scheduling; kept until the ' +
      'next heartbeat that carries vitals replaces it.',
    nullable: true,
    type: NodeVitalsDto,
  })
  lastVitals!: NodeVitalsDto | null;

  @ApiPropertyOptional({
    description:
      'ISO 8601 server timestamp of the heartbeat that carried `lastVitals`, or `null`. ' +
      'Compare with `lastHeartbeatAt`: a node that heartbeats without vitals keeps an ageing snapshot.',
    nullable: true,
  })
  lastVitalsAt!: string | null;

  @ApiProperty({ description: 'The user who registered this node', type: NodeOwnerDto })
  owner!: NodeOwnerDto;

  @ApiProperty({ description: 'This node’s job counts by status', type: NodeJobCountsDto })
  jobCounts!: NodeJobCountsDto;
}

/**
 * One credential as the admin credential list sees it.
 *
 * Same omissions as `NodeCredentialListItemDto` and for the same reasons —
 * never `token`, never `tokenHash` — plus `owner`, which is the entire reason
 * this surface exists: an administrator auditing long-lived worker tokens
 * needs to know whose they are.
 */
export class AdminNodeCredentialDto {
  @ApiProperty({ description: 'Credential ID (UUID)' })
  id!: string;

  @ApiProperty({ description: 'Operator-chosen label for this credential' })
  name!: string;

  @ApiProperty({ description: 'Non-secret display prefix (e.g. `nod_1a2b`)' })
  tokenPrefix!: string;

  @ApiPropertyOptional({
    description: 'ISO 8601 expiry timestamp, or `null` when this credential never expires',
    nullable: true,
  })
  expiresAt!: string | null;

  @ApiPropertyOptional({
    description: 'ISO 8601 timestamp of the last successful authentication, or `null`',
    nullable: true,
  })
  lastUsedAt!: string | null;

  @ApiProperty({ description: 'ISO 8601 creation timestamp' })
  createdAt!: string;

  @ApiPropertyOptional({
    description: 'ISO 8601 revocation timestamp, or `null` while the credential is active',
    nullable: true,
  })
  revokedAt!: string | null;

  @ApiProperty({ description: 'The user this credential authenticates as', type: NodeOwnerDto })
  owner!: NodeOwnerDto;
}
