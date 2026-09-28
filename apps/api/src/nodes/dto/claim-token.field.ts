// =============================================================================
// The claim token, as a node quotes it back (issue #364, epic #254)
// =============================================================================
//
// ONE FIELD IN ONE FILE, which in this folder needs a reason — the file beside
// it argues at length for keeping SIX request bodies together. The reason is
// that this field is not part of any one of those conversations: it is the
// same sentence spoken on SIX ROUTES ACROSS THREE DTO FILES — renew, result
// and failure (`node-control-plane.dto.ts`), download-url and upload-url
// (`node-data-plane.dto.ts`), and secret (`node-job-secret.dto.ts`) — and the
// one thing that must never differ between them is what that sentence means.
// Copied six times it drifts exactly once, in the direction that costs the
// most: somebody makes it `.nullable()` on one route to accommodate a client
// that serialises absent fields as `null`, and on that route alone a node
// asserting "no token" starts matching `claim_token IS NULL` instead of being
// refused.
//
// The alternative was exporting it from `node-control-plane.dto.ts`, and it is
// rejected for what it would say rather than what it would do: it would make
// the data plane's and the broker's guards look like borrowings from the
// control plane, when in fact all six are the same guard. Nothing here is
// control plane or data plane; it is the identity of a CLAIM.
// =============================================================================

import { z } from 'zod';

/**
 * THE CLAIM THIS MESSAGE IS ABOUT — `jobs.claim_token`, handed to the node in
 * the claim response and quoted back on every route that speaks for a held
 * job (#364).
 *
 * WHY A NODE ID IS NOT ENOUGH, which is the whole of this field. Every guard
 * on the six routes above identified the caller by `claimedByNodeId` alone,
 * which tells one node from another and NOT ONE NODE FROM ITSELF. A node that
 * claims job J, stalls past its lease, is reaped, and then claims J again in a
 * second worker slot has two live slots quoting the same node id, and every
 * one of those six routes will believe the older one:
 *
 *   - `renew` — the stale slot extends the lease its OWN newer claim is
 *     running under, so a second slot that dies is reaped late, for as long as
 *     the first keeps ticking.
 *   - `result` / `failure` — the stale slot SETTLES a job its newer claim is
 *     still executing, persisting output computed against an earlier attempt
 *     or charging a failure against a run that is going fine.
 *   - `upload-url` — the sharpest of the six, and the quietest. With
 *     `deriveOutputKey` (#348) the key is a function of the JOB, not of the
 *     claim, so a stale slot is handed a signed PUT for the exact output key
 *     its own later claim is currently writing. Both PUTs "succeed"; the
 *     bytes that survive are whichever finished last, and nothing anywhere
 *     records that two ran.
 *   - `download-url` — a bearer capability for the job's input, minted for a
 *     slot that no longer holds the row.
 *   - `secret` — a LIVE DATABASE CREDENTIAL handed to a slot that lost the
 *     job, valid for the lease of a claim that is not its own.
 *
 * The token is minted per row by the claim statement
 * (`job-claim.service.ts`, `gen_random_uuid()`), so those two claims carry
 * different tokens and the stale one is refused.
 *
 * ⚠ OPTIONAL ON THE WIRE EVERYWHERE, AND THAT IS LOAD-BEARING, not politeness.
 * A fleet is upgraded one machine at a time; a node running older CLI code
 * omits this field, and the server must then behave EXACTLY as it did before —
 * the node id and the lease alone — rather than 400 the request or 409 the
 * job. Same posture as `renewIntervalMs` in #347: additive, ignorable,
 * strictly better when present. The ambiguity above stays open for that node
 * until it is upgraded, which is a rolling-upgrade window rather than a new
 * hole; nothing the server can do closes it earlier, because the only value
 * able to tell two slots of one node apart is one only they hold.
 *
 * ⚠ OMITTED MUST STAY `undefined` AND MUST NOT BECOME `null`. Downstream this
 * value reaches `heldLeaseWhere`, where the two mean opposite things:
 * `undefined` drops the clause entirely ("I am not asserting a claim"), while
 * `null` matches `claim_token IS NULL` ("I assert this row carries no token",
 * which is what a claim taken before the column existed looks like).
 * `.optional()` with no `.nullable()` is what keeps them apart — a body that
 * spells the key as `null` is refused rather than silently reinterpreted as
 * the other statement. Apply `.optional()` at each use site rather than baking
 * it in here, so every body says out loud that the field may be absent.
 *
 * Validated as a uuid rather than as any bounded string because the column is
 * `uuid`: a garbage value reaching a `where` clause is a Postgres cast error
 * (a 500 about "inconsistent column data"), and a clean 400 naming the field
 * is a better answer to a malformed token than a 500 is.
 */
export const claimTokenField = z.uuid().describe(
  // ⚠ THE PUBLISHED DESCRIPTION IS PART OF THE ONE DEFINITION, and it is here
  // for the reason the schema is: six routes describing one grant six ways is
  // six chances to describe it differently, and a node's author reads
  // whichever one they happened to open. `.describe()` rides through
  // `.optional()` into every generated body, so `openapi.json` says the same
  // sentence six times by construction.
  'The `claimToken` this assignment was handed in the claim response, quoted back so the ' +
    'server can tell THIS claim of the job from a later one by the same node — the difference ' +
    'between renewing, settling, signing or crediting your own run and one your node started ' +
    'later. Optional: omit it and the request is identified by node id alone, exactly as ' +
    'before, so an older client is refused nothing and stays exactly as ambiguous as it was. ' +
    'Omit the key rather than sending `null`; `null` is a different assertion and is refused.'
);
