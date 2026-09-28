// =============================================================================
// Every key prefix this application writes into object storage (issue #404)
// =============================================================================
//
// THE ONE REASON THIS FILE EXISTS. `appctl deploy uninstall --purge-storage`
// deletes objects, and it must build its targets from a list the APPLICATION
// owns rather than one somebody transcribed into the CLI. The portable deploy
// specification records what happens otherwise: a transcribed list said
// `backups/` where the real constant was `database-backups/`, and the purge
// would have reported COMPLETE while leaving every database backup in the
// bucket. Nothing failed, nothing warned; the operator was simply told a
// falsehood about their own data.
//
// So the rule is structural, not procedural: purge targets are built ONLY from
// `STORAGE_KEY_PREFIXES`, and `storage-key-prefixes.spec.ts` asserts each entry
// is the prefix its writer actually uses. A new writer that invents a prefix
// trips that test; a purge that filters a full bucket listing instead of using
// this list would not, which is why it must not.
//
// WHY IT LIVES HERE AND NOT IN `packages/shared`. That package is committed as
// plain CommonJS with a hand-written `index.d.ts` and no build step, so a
// constant there costs a second declaration to keep in sync. Worse, it would
// move the list AWAY from the code that writes the keys -- and the property
// this whole file exists for is that adding a writer in `apps/api` must trip
// the test. Distance from the writers is the failure mode, not a neutral
// packaging choice.
//
// A NO-IMPORT LEAF, exactly like `storage-credential.constants.ts` beside it
// and for the reason its header gives: several modules on both sides of the
// storage boundary need this, and a file that imports nothing is safe to
// import from either without inviting a cycle under `emitDecoratorMetadata`.
//
// ⚠ TRAILING SLASHES ARE NORMALISED HERE, AND THAT IS NOT COSMETIC. The
// writers disagree: `BACKUP_KEY_PREFIX` carries one, `NODE_OUTPUT_KEY_PREFIX`
// does not (it is joined as `${PREFIX}/${id}`), and `uploads/` was a bare
// template literal in two places with no constant at all. A purge built from
// the raw values would ask for `node-outputs//`, match nothing, and report
// success -- the same silent falsehood in a new costume.
// =============================================================================

/** Files uploaded through the storage objects API. */
export const UPLOADS_KEY_PREFIX = 'uploads/';

/** Per-user profile images. Individual objects live under `avatars/<userId>/`. */
export const AVATARS_KEY_PREFIX = 'avatars/';

/** Database backup archives. Re-exported from its owner; see below. */
export const DATABASE_BACKUPS_KEY_PREFIX = 'database-backups/';

/** Artifacts a worker node uploaded for a job it executed. */
export const NODE_OUTPUTS_KEY_PREFIX = 'node-outputs/';

/**
 * Files an AI operation produced for a user (#437: generated/edited images;
 * later audio). Individual objects live under `ai-outputs/<userId>/<runId>/`,
 * built by `aiOutputKeyPrefix` in `ai/storage/ai-output-writer.ts`.
 */
export const AI_OUTPUTS_KEY_PREFIX = 'ai-outputs/';

/**
 * Probe objects written by the storage connection test.
 *
 * ⚠ Easy to leave off this list and wrong to: the test deletes its probe on a
 * best-effort basis, so these DO linger after a failed round trip -- the
 * connection-test service says as much and tells operators to remove them by
 * hand. A purge that skipped this prefix would leave exactly the objects an
 * operator never knew they had.
 */
export const STORAGE_TEST_KEY_PREFIX = 'storage-config-test/';

/**
 * The complete set, and the only thing a destructive path may enumerate.
 *
 * Frozen so a caller cannot narrow it in place and then believe it purged
 * everything.
 */
export const STORAGE_KEY_PREFIXES: readonly string[] = Object.freeze([
  UPLOADS_KEY_PREFIX,
  AVATARS_KEY_PREFIX,
  DATABASE_BACKUPS_KEY_PREFIX,
  NODE_OUTPUTS_KEY_PREFIX,
  AI_OUTPUTS_KEY_PREFIX,
  STORAGE_TEST_KEY_PREFIX,
]);
