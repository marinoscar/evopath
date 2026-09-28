/**
 * `appctl deploy about` — what this server says it is running.
 *
 * =============================================================================
 * ⚠ READS THE DOCUMENT, NEVER THE API
 * =============================================================================
 *
 * The obvious implementation asks `GET /api/about`, and it is the wrong one for
 * three separate reasons:
 *
 *   1. It would need the application to be UP. The moment an operator most
 *      wants to know what was deployed here is the moment it is not answering.
 *   2. It would need to be AUTHENTICATED. That endpoint is gated on
 *      `system_settings:read`, so a command that just reads a local file would
 *      acquire a login flow.
 *   3. It would report what the CONTAINER believes, which is a different fact
 *      from what this CLI deployed -- and when those two disagree, that
 *      disagreement is the answer, not an error to route around.
 *
 * So it reads `deploy-info/info.json` off the disk it was written to. The API
 * reads the very same file from the other side of a read-only bind mount; the
 * two agreeing is the point of the file existing.
 *
 * ⚠ THREE STATES, AND ABSENT IS NOT AN ERROR. A deployment installed before
 * this CLI wrote the document has none, and so does one whose run stopped
 * before the health gate. The copy for that case must not assert a negative --
 * "no record here" is true; "this was not deployed with the CLI" is a guess.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type AboutStatus = 'ok' | 'absent' | 'invalid';

export interface AboutReport {
  status: AboutStatus;
  path: string;
  /** Present only when `status` is `ok`. */
  document?: Record<string, unknown> | undefined;
  /** Why the document could not be read, when it could not. */
  error?: string | undefined;
}

export function readAbout(deployRoot: string): AboutReport {
  const path = join(deployRoot, 'deploy-info', 'info.json');

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // ⚠ Not an error state. See the header.
    return { status: 'absent', path };
  }

  try {
    const document = JSON.parse(raw) as Record<string, unknown>;
    if (typeof document !== 'object' || document === null) {
      return { status: 'invalid', path, error: 'the file is not a JSON object' };
    }
    return { status: 'ok', path, document };
  } catch (error) {
    return { status: 'invalid', path, error: (error as Error).message };
  }
}

function field(document: Record<string, unknown>, ...keys: readonly string[]): string {
  let value: unknown = document;
  for (const key of keys) {
    if (typeof value !== 'object' || value === null) return '-';
    value = (value as Record<string, unknown>)[key];
  }
  // ⚠ `null` renders as `-`, not as the string "null". The document uses null
  // for known-to-be-absent, and printing the word would read as a value.
  return value === null || value === undefined ? '-' : String(value);
}

const LABEL_WIDTH = 14;

export function renderAbout(report: AboutReport): string {
  if (report.status === 'absent') {
    return [
      `No deployment record at ${report.path}.`,
      '',
      'That is not necessarily a problem. The record is written once the API',
      'answers, so a deployment installed before this CLI wrote it, or one',
      'whose run stopped earlier than that, simply has none.',
    ].join('\n');
  }

  if (report.status === 'invalid') {
    return [
      `The deployment record at ${report.path} could not be read.`,
      `  ${report.error ?? 'unknown'}`,
      '',
      'The file is there and this build cannot interpret it, which is a',
      'different thing from nothing being deployed here.',
    ].join('\n');
  }

  const document = report.document as Record<string, unknown>;
  const rows: readonly (readonly [string, string])[] = [
    ['Name', field(document, 'app', 'name')],
    ['Version', field(document, 'app', 'version')],
    ['Commit', field(document, 'app', 'commitSha').slice(0, 12)],
    ['Ref', field(document, 'app', 'ref')],
    ['Domain', field(document, 'domain')],
    ['Installed', field(document, 'installedAt')],
    ['Updated', field(document, 'updatedAt')],
    ['Deployed by', `${field(document, 'deployedBy', 'cli')} ${field(document, 'deployedBy', 'version')}`],
  ];

  const out = rows.map(([label, value]) => `  ${label.padEnd(LABEL_WIDTH)}${value}`);

  // ⚠ THE THIRD STATE, AND IT IS THE REASON THE DOCUMENT IS WRITTEN AT THE
  // HEALTH GATE. Every fact above is true; the run that produced them did not
  // reach the end. Reporting the facts without the warning would be a
  // half-truth, and reporting nothing would throw away a working deployment's
  // provenance.
  const outcome = field(document, 'run', 'outcome');
  if (outcome === 'failure') {
    const failed = field(document, 'run', 'failedStep');
    out.push('');
    out.push(`  ⚠ The run that deployed this did not finish: it failed at \`${failed}\`.`);
    out.push('    The application above is deployed and answering; something after');
    out.push('    that point did not complete.');
  }

  return out.join('\n');
}
