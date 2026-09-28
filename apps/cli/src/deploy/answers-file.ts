/**
 * Reading answers from a file, for an unattended run.
 *
 * ⚠ THE `.env` PARSER, NOT A SECOND ONE. `parseEnvFile` already handles
 * quoting, `export ` prefixes, comments, blank lines and CRLF -- and it is the
 * parser that will read the file this run WRITES. A hand-rolled `split('=')`
 * here would accept files the deployment then reads differently, which is the
 * quietest possible way to deploy a value nobody typed.
 *
 * ⚠ AN ANSWERS FILE IS A CREDENTIAL FILE. It carries the database password and
 * the signing secrets, so a world-readable one is worth saying something about
 * -- as a WARNING, not a refusal: on a CI runner the file is created by the
 * job in a container nobody else is on, and refusing would break exactly the
 * unattended use this exists for.
 */
import { readFileSync, statSync } from 'node:fs';

import { UsageError } from '../errors.js';
import { parseEnvFile } from './env-spec.js';

export interface AnswersFile {
  values: Map<string, string>;
  /** Non-fatal notes for the caller to surface. */
  warnings: string[];
}

export function readAnswersFile(path: string): AnswersFile {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    throw new UsageError(
      `Could not read the answers file ${path}: ${(error as Error).message}`,
    );
  }

  const values = parseEnvFile(contents);
  const warnings: string[] = [];

  if (values.size === 0) {
    // ⚠ A REFUSAL, NOT A WARNING. An empty answers file means the operator
    // believes they supplied answers and did not -- and an unattended run that
    // continues will either fail far away from the cause or, worse, take a
    // template default for something that matters.
    throw new UsageError(
      `The answers file ${path} contains no KEY=value lines. It is read with the same parser as \`.env\`.`,
    );
  }

  try {
    const mode = statSync(path).mode & 0o077;
    if (mode !== 0) {
      warnings.push(
        `${path} is readable by other users (mode ${(statSync(path).mode & 0o777).toString(8)}). ` +
          `It holds the database password and the signing secrets; \`chmod 600\` it.`,
      );
    }
  } catch {
    // The read above succeeded, so a failed stat is a curiosity, not a
    // problem worth stopping a deployment over.
  }

  return { values, warnings };
}
