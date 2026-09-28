/**
 * Reading and writing the real `.env`.
 *
 * Extracted from `install.ts` so there is ONE writer. It holds the database
 * password, the JWT secret and the OAuth client secret, so how it reaches disk
 * is not an implementation detail:
 *
 *   - **0600, enforced on every write.** Passing `mode` to `writeFileSync`
 *     applies only when the file is CREATED, so rewriting a pre-existing 0644
 *     `.env` left it 0644. The mode is set explicitly instead, unconditionally.
 *   - **Atomic: temp file, then rename.** A half-written `.env` is a deployment
 *     that boots with a truncated secret. `state.ts` has always done this; the
 *     environment file - which matters more - did not.
 *
 * The temp file is created in the same directory as the target, because
 * `rename(2)` is only atomic within a filesystem.
 */
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { parseEnvFile, serializeEnvFile, type EnvVarSpec } from './env-spec.js';

/** Owner read/write only. The file is a credential store. */
const ENV_FILE_MODE = 0o600;

export function readEnvFile(path: string): Map<string, string> {
  return parseEnvFile(readFileSync(path, 'utf8'));
}

/**
 * Writes `.env` atomically at 0600.
 *
 * `specs` is the FULL template spec list, not the subset anything was asked
 * about: the serializer uses it to reproduce the template's section banners and
 * key order, which is what lets an operator diff a generated `.env` against
 * `.env.example` and see only their own answers.
 */
export function writeEnvFile(
  path: string,
  values: ReadonlyMap<string, string>,
  specs: readonly EnvVarSpec[],
): void {
  writeEnvContents(path, serializeEnvFile(values, specs));
}

/** The raw-contents form, for callers that already rendered the file. */
export function writeEnvContents(path: string, contents: string): void {
  const temporary = join(dirname(path), `.env.appctl-${process.pid}.tmp`);

  try {
    writeFileSync(temporary, contents, { mode: ENV_FILE_MODE });
    // Unconditional: `mode` above is umask-masked and, on a path that already
    // existed, applies to nothing at all.
    chmodSync(temporary, ENV_FILE_MODE);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temp file may never have been created. Nothing to report: the
      // original error below is the operator's actual problem.
    }
    throw error;
  }
}
