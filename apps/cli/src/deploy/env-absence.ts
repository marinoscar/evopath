/**
 * Why a variable is absent from a `.env` - and why "absent" is not "drift".
 *
 * A key can be permanently missing for three unrelated reasons, and NONE of
 * them means this revision added it:
 *
 *   1. The operator DECLINED AN OPTIONAL VARIABLE. It is commented out in the
 *      template, so `spec.optional` covers it.
 *   2. The key carries `never: true` and is deleted outright, whatever the
 *      template says.
 *   3. The key belongs to an OPT-IN FEATURE GROUP the deployment never
 *      enabled. These are NOT commented out in the template, so `spec.optional`
 *      does NOT cover them - and this is the class that looks handled and is
 *      not. Here it is `observability`, `email` and `microsoft-oauth`: 19 keys,
 *      several of them secret.
 *
 * The defect this module exists to prevent: a drift check that asks "what is in
 * the template and not in the file?" and keeps anything `essential || secret`
 * without consulting any of the three. That walked the operator through the
 * entire install wizard - database connection included - on an update whose
 * template had not changed at all, and on the unattended path it was worse and
 * quieter: with a recorded domain it SUCCEEDED, silently re-running the wizard
 * over hand-set values and reverting them.
 *
 * A fix that reads only `spec.optional` looks correct and leaves the reported
 * failure live on every deployment that never enabled a feature group.
 *
 * This lives here rather than in `env-spec.ts` because that module is
 * deliberately pure and metadata-free: it parses a file into structs and knows
 * nothing about which keys are secret, essential or grouped. Policy belongs
 * with the policy. The rule is applied at the CALL SITE, never in the parser.
 */
import type { EnvVarSpec } from './env-spec.js';
import { metadataFor, type EnvGroup, type EnvVarMetadata } from './env-metadata.js';

export interface AbsenceContext {
  /** Feature groups this deployment opted into. */
  groups: readonly EnvGroup[];
  /** Injectable for the local profile and for tests. */
  metadata?: ((key: string) => EnvVarMetadata) | undefined;
}

/**
 * True when a key's absence is one of the three classes above - i.e. expected,
 * and not something to ask about.
 *
 * ⚠ Enabled groups are passed in, never inferred from the `.env`. Nothing
 * distinguishes `FEATURE_ENABLED=true` from `FEATURE_ENABLED=false` - both are
 * merely PRESENT - so an inference would write a group's placeholder defaults
 * into a live deployment's configuration.
 */
export function isExpectedAbsence(spec: EnvVarSpec, context: AbsenceContext): boolean {
  const metadata = (context.metadata ?? metadataFor)(spec.key);

  if (metadata.never === true) return true;
  if (spec.optional) return true;
  if (metadata.group !== undefined && !context.groups.includes(metadata.group)) return true;

  return false;
}

/**
 * The keys a revision GENUINELY added: present in the template, absent from the
 * file, and absent for none of the three expected reasons.
 *
 * This is the wizard's question list. It is NOT the writer's key list - the
 * serializer still gets the full template so section banners and key order
 * survive. Two different arguments with two different values; conflating them
 * is half of the defect described above.
 */
export function genuinelyNewKeys(
  missing: readonly EnvVarSpec[],
  context: AbsenceContext,
): EnvVarSpec[] {
  return missing.filter((spec) => !isExpectedAbsence(spec, context));
}
