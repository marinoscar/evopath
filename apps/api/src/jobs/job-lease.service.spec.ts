// =============================================================================
// Unit tests for JobLeaseService (issue #347, epic #345)
// =============================================================================
//
// WHAT A MOCK CAN AND CANNOT PROVE HERE, stated up front because the split
// with `test/jobs/job-lease-renewal.db.spec.ts` depends on it. A mocked
// `updateMany` returns whatever this file told it to no matter what `where` it
// was handed, so nothing below is evidence that Postgres MATCHES the right
// rows. What it is evidence of is the shape of the predicate — every clause
// present, `nodeId` three-valued as documented, `count === 1` and not `> 0` —
// which is exactly the part a real-database test cannot show you, because
// there the predicate is invisible behind the rows it selected.
//
// The row-matching claim is made against a real server in
// `test/jobs/job-lease-renewal.db.spec.ts`.
//
// `claimToken` is three-valued here for both executors now (#364): the
// in-process worker takes it off its own claimed row, and the node plane
// receives it from the node, which was handed it in the claim response. The
// `undefined` arm is no longer "the node plane" — it is "a claimant that
// quoted no token", which after #364 means an un-upgraded node.
// =============================================================================

import { JobLeaseService, heldClaimWhere, heldLeaseWhere } from './job-lease.service';
import type { PrismaService } from '../prisma/prisma.service';

const JOB_ID = '3f1a0f4e-0000-4000-8000-000000000001';
const NODE_ID = '3f1a0f4e-0000-4000-8000-0000000000aa';
const CLAIM_TOKEN = '3f1a0f4e-0000-4000-8000-0000000000cc';

function makeService(updateMany = jest.fn().mockResolvedValue({ count: 1 })) {
  const prisma = { job: { updateMany } } as unknown as PrismaService;

  return { service: new JobLeaseService(prisma), updateMany };
}

/** The `where` the service handed Prisma on its `n`th call. */
const whereOf = (mock: jest.Mock, index = 0): Record<string, unknown> =>
  mock.mock.calls[index][0].where as Record<string, unknown>;

describe('heldLeaseWhere', () => {
  it('requires the row to be this job, running, and still inside its lease', () => {
    const where = heldLeaseWhere(JOB_ID, { nodeId: null });

    expect(where.id).toBe(JOB_ID);
    expect(where.status).toBe('running');
    expect((where.leaseExpiresAt as { gt: Date }).gt).toBeInstanceOf(Date);
  });

  it('refuses an ALREADY EXPIRED lease — the clause the whole file is for', () => {
    // The predicate is `gt: now`, so a lease that has passed cannot match.
    // This is the guard that stops a straggler renewing a row the reaper has
    // already requeued and another executor has already claimed; relaxing it
    // is how two live executors end up believing they own one job.
    const before = Date.now();
    const gt = (heldLeaseWhere(JOB_ID).leaseExpiresAt as { gt: Date }).gt;

    expect(gt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('pins the row to a node when a node id is given', () => {
    expect(heldLeaseWhere(JOB_ID, { nodeId: NODE_ID }).claimedByNodeId).toBe(NODE_ID);
  });

  it('pins the row to NO node when null is given — the in-process worker', () => {
    // `null` is not "unconstrained": the worker claims as `executor: 'server'`
    // with no node, so if the reaper requeued the row and a NODE took it, the
    // worker's renewals must stop landing. `null` is what says so.
    expect(heldLeaseWhere(JOB_ID, { nodeId: null }).claimedByNodeId).toBeNull();
  });

  it('omits the ownership clause entirely when the node id is undefined', () => {
    // Three-valued on purpose. `undefined` leaves the column unconstrained for
    // a fork's own executor, which has no node id to state and must not be
    // forced to lie about one to renew.
    expect('claimedByNodeId' in heldLeaseWhere(JOB_ID)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // `claimToken` — three-valued for the same reason as `nodeId` above, and
  // the whole of #361's fix (see this file's docstring). Covered the same way,
  // case for case.
  // ---------------------------------------------------------------------------

  it('pins the row to a specific claim when a token is given', () => {
    expect(heldLeaseWhere(JOB_ID, { claimToken: CLAIM_TOKEN }).claimToken).toBe(CLAIM_TOKEN);
  });

  it('pins the row to NO token when null is given — a pre-#361 claim', () => {
    // `null` is not "unconstrained" here either: it matches only a row whose
    // `claim_token` column is itself `NULL`, which is what a claim taken
    // before the column existed looks like.
    expect(heldLeaseWhere(JOB_ID, { claimToken: null }).claimToken).toBeNull();
  });

  it('omits the token clause entirely when claimToken is undefined — an un-upgraded node', () => {
    // Since #364 the node plane DOES pass a token — the one the node quoted
    // back from its claim response — but only when the node is new enough to
    // know the field exists. `undefined` is the older client, and it must
    // produce the pre-#364 predicate exactly: the KEY absent from the `where`,
    // not merely `undefined`, because Prisma may treat a key that is present
    // and undefined differently from one that was never mentioned, and a
    // `null` here would narrow the match to rows whose `claim_token` IS NULL —
    // refusing every renewal from that node.
    expect('claimToken' in heldLeaseWhere(JOB_ID)).toBe(false);
    expect('claimToken' in heldLeaseWhere(JOB_ID, { nodeId: NODE_ID })).toBe(false);
  });
});

describe('heldClaimWhere (#477)', () => {
  it('is exactly: this id, still running, this token, this node', () => {
    expect(
      heldClaimWhere({ id: JOB_ID, claimToken: CLAIM_TOKEN, claimedByNodeId: NODE_ID })
    ).toEqual({
      id: JOB_ID,
      status: 'running',
      claimToken: CLAIM_TOKEN,
      claimedByNodeId: NODE_ID,
    });
  });

  it('carries NO lease clause — the settle guard is identity, not liveness', () => {
    const where = heldClaimWhere({
      id: JOB_ID,
      claimToken: CLAIM_TOKEN,
      claimedByNodeId: null,
    });

    expect(where).not.toHaveProperty('leaseExpiresAt');
  });

  it('states null members as null (IS NULL), never drops them', () => {
    const where = heldClaimWhere({ id: JOB_ID, claimToken: null, claimedByNodeId: null });

    expect(where).toHaveProperty('claimToken', null);
    expect(where).toHaveProperty('claimedByNodeId', null);
  });

  it('reads only the three identity columns off a full row', () => {
    const row = {
      id: JOB_ID,
      claimToken: CLAIM_TOKEN,
      claimedByNodeId: null,
      leaseExpiresAt: new Date(0),
      attempts: 4,
    };

    expect(Object.keys(heldClaimWhere(row)).sort()).toEqual(
      ['claimToken', 'claimedByNodeId', 'id', 'status'].sort()
    );
  });
});

describe('JobLeaseService.renew', () => {
  it('writes a lease leaseMs into the future, guarded by heldLeaseWhere', async () => {
    const { service, updateMany } = makeService();

    const before = Date.now();
    await expect(service.renew(JOB_ID, 60_000, { nodeId: null })).resolves.toBe(true);

    const call = updateMany.mock.calls[0][0] as { data: { leaseExpiresAt: Date } };
    expect(call.data.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);

    // Compared against the exported predicate rather than a literal, so this
    // fails if the guard changes rather than merely if a copy of it does.
    expect(Object.keys(whereOf(updateMany)).sort()).toEqual(
      Object.keys(heldLeaseWhere(JOB_ID, { nodeId: null })).sort()
    );
  });

  it('forwards the claim token through to the where clause', async () => {
    const { service, updateMany } = makeService();

    await expect(
      service.renew(JOB_ID, 60_000, { nodeId: null, claimToken: CLAIM_TOKEN })
    ).resolves.toBe(true);

    expect(whereOf(updateMany).claimToken).toBe(CLAIM_TOKEN);
  });

  it('reports false when the row was not held — reaped, settled, or taken', async () => {
    const { service } = makeService(jest.fn().mockResolvedValue({ count: 0 }));

    await expect(service.renew(JOB_ID, 60_000, { nodeId: null })).resolves.toBe(false);
  });

  it('does not throw on a lost row: false is an answer, not a failure', async () => {
    // Both callers are keep-alive paths with real work in flight. "You no
    // longer own this row" must stop the ticker, never fail the job that is
    // still running.
    const { service } = makeService(jest.fn().mockResolvedValue({ count: 0 }));

    await expect(service.renew(JOB_ID, 1_000)).resolves.toBe(false);
  });

  it('treats a count other than one as not held', async () => {
    // `id` is the primary key so this cannot really happen; the assertion
    // pins the `=== 1` rather than a `> 0` that would quietly accept a
    // predicate someone had widened into matching several rows.
    const { service } = makeService(jest.fn().mockResolvedValue({ count: 2 }));

    await expect(service.renew(JOB_ID, 1_000, { nodeId: null })).resolves.toBe(false);
  });
});

describe('JobLeaseService.renewUntil', () => {
  it('writes the EXACT instant it was given, not one it recomputes', async () => {
    // The reason this overload exists: `NodesService.renewLease` reports the
    // new expiry to the node, and a node told one instant while the row
    // carries another schedules its next renewal against a deadline the
    // reaper does not read.
    const { service, updateMany } = makeService();
    const at = new Date('2026-03-01T00:00:00.000Z');

    await expect(service.renewUntil(JOB_ID, at, { nodeId: NODE_ID })).resolves.toBe(true);

    expect((updateMany.mock.calls[0][0] as { data: { leaseExpiresAt: Date } }).data).toEqual({
      leaseExpiresAt: at,
    });
    expect(whereOf(updateMany).claimedByNodeId).toBe(NODE_ID);
  });

  it('forwards the claim token through to the where clause as well', async () => {
    // `NodesService.renewLease` is the one caller of this overload, and since
    // #364 it passes the token the NODE quoted back — which is why it is an
    // assertion worth checking rather than a value the server read off the row
    // it was about to match. Forwarded for the same reason `renew` above
    // forwards the worker's own.
    const { service, updateMany } = makeService();

    await expect(
      service.renewUntil(JOB_ID, new Date(), { nodeId: NODE_ID, claimToken: CLAIM_TOKEN })
    ).resolves.toBe(true);

    expect(whereOf(updateMany).claimToken).toBe(CLAIM_TOKEN);
  });
});
