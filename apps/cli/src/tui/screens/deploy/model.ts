/**
 * What every deploy screen shares: the field shape, and the masking rule.
 *
 * =============================================================================
 * ⚠ MASKING IS ONE RULE, IN ONE PLACE
 * =============================================================================
 *
 * `shouldMask` is the only thing in this TUI allowed to decide whether a value
 * is a secret, and it decides by asking `env-metadata.ts` -- the same table the
 * shell wizard, the journal redactor and the review renderer ask.
 *
 * The defect it exists to make unrepresentable: masking was decided twice, once
 * at the input (`field.secret`, computed while building the questions) and once
 * on the confirmation screen (`metadataFor(key).secret`, computed from the raw
 * key). Those agreed for a typed answer and disagreed for a PREFILLED one,
 * because a prefilled value arrives as a bare key with no field around it. A
 * secret read off disk was then echoed in clear text on the review screen --
 * the one screen an operator is most likely to be sharing with someone.
 *
 * So no screen computes `secret` for itself. It asks here.
 * =============================================================================
 */
import { metadataFor } from '../../../deploy/env-metadata.js';

/** What a masked value renders as. Fixed width: the length is a hint too. */
export const MASK = '********';

/**
 * Screen-local fields, which are not environment variables.
 *
 * Prefixed so they cannot collide with a template key, and stripped before the
 * answers reach `runInstall`. `__name` is the app name, `__domain` the public
 * hostname, and so on.
 */
export const SCREEN_FIELD_PREFIX = '__';

export function isScreenField(key: string): boolean {
  return key.startsWith(SCREEN_FIELD_PREFIX);
}

/** The label an operator reads, with the internal prefix taken off. */
export function labelFor(key: string): string {
  return key.startsWith(SCREEN_FIELD_PREFIX)
    ? key.slice(SCREEN_FIELD_PREFIX.length)
    : key;
}

/**
 * Whether a value must never be shown.
 *
 * ⚠ Screen fields are never secret: they are paths, ports and hostnames the
 * operator just typed. Masking them would hide the very facts the confirmation
 * screen exists to let someone check.
 */
export function shouldMask(key: string): boolean {
  if (isScreenField(key)) return false;
  return metadataFor(key).secret === true;
}

/** The single renderer for a value on any review or confirmation screen. */
export function displayValue(key: string, value: string): string {
  return shouldMask(key) ? MASK : value;
}

export interface FieldSpec {
  key: string;
  label: string;
  help: string;
  /**
   * What appears in the empty input, and what an empty submission means.
   *
   * ⚠ For a PREFILLED field this is the value already on disk, so pressing
   * Enter through a re-run keeps it. That is the whole mechanism behind "a
   * re-run leaves every generated secret byte-identical": a generate-mode
   * secret is no longer blank, so nothing ever regenerates it.
   */
  placeholder: string;
  secret: boolean;
  /** True when `placeholder` came from the deployment's own `.env`. */
  prefilled: boolean;
  validate?: ((value: string) => string | undefined) | undefined;
}
