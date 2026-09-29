// =============================================================================
// Gym location privacy (E3.5) — a source tripwire
// =============================================================================
//
// A gym's coordinates are personal data: stored and returned to their owner,
// never logged, never put in a span attribute, never sent to an AI provider.
// `accuracyMeters` is echoed in a response only. The behavioural proofs are in
// `gyms.integration.spec.ts` (no log line carries them) and
// `equipment-scan.handler.spec.ts` (the scan request carries none). This suite
// fails the build when a later change starts interpolating them in the gyms
// module or teaches the scan to read them.
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const GYMS_SRC = join(__dirname, '../../src/gyms');
const LOCATION = /latitude|longitude|accuracy|coordinat/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** Each logger / span / console call's full argument text, from its opening to its closing parenthesis. */
function sinkCalls(source: string): string[] {
  const calls: string[] = [];
  const opener = /(?:\blogger\.\w+|\bLogger\.\w+|\bconsole\.\w+|\bsetAttributes?|\baddEvent|\brecordException)\s*\(/g;

  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    let depth = 1;
    let end = match.index + match[0].length;
    while (end < source.length && depth > 0) {
      if (source[end] === '(') depth += 1;
      if (source[end] === ')') depth -= 1;
      end += 1;
    }
    calls.push(source.slice(match.index, end));
  }

  return calls;
}

describe('gym location privacy (source)', () => {
  const files = sourceFiles(GYMS_SRC);

  it('finds the gyms sources', () => {
    expect(files.map((file) => relative(GYMS_SRC, file))).toEqual(
      expect.arrayContaining(['gyms.service.ts', 'gyms.controller.ts', 'scan/equipment-scan.handler.ts']),
    );
  });

  it.each(files.map((file) => [relative(GYMS_SRC, file), file]))(
    '%s passes no location field to a logger, span or console call',
    (_name, file) => {
      const offending = sinkCalls(readFileSync(file, 'utf8')).filter((call) => LOCATION.test(call));
      expect(offending).toEqual([]);
    },
  );

  it('the scan handler and prompt never mention a gym position or query the gym table', () => {
    for (const name of readdirSync(join(GYMS_SRC, 'scan')).filter((n) => n.endsWith('.ts') && !n.endsWith('.spec.ts'))) {
      const source = readFileSync(join(GYMS_SRC, 'scan', name), 'utf8');
      expect({ name, mentions: LOCATION.test(source) }).toEqual({ name, mentions: false });
      expect({ name, queriesGym: /\.gym\.\w+\(/.test(source) }).toEqual({ name, queriesGym: false });
    }
  });
});
