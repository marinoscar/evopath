import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// =============================================================================
// No coach notification is raised inside a `$transaction` (E7.5, #245)
// =============================================================================
//
// CLAUDE.md invariant: `notify()` runs after the triggering write commits and
// outside any `$transaction`. A static tripwire over `apps/api/src/coach`:
// every `$transaction(` call's balanced argument list is scanned for a
// `notify`/`notifyNow`/`notifyPermissionHolders` call. It cannot follow calls
// into helpers; it pins the shape of the coach's own code.
// =============================================================================

const ROOT = join(__dirname, '..', '..', 'src', 'coach');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return files(full);
    return entry.endsWith('.ts') && !entry.endsWith('.spec.ts') ? [full] : [];
  });
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The text of every `$transaction(...)` argument list. */
export function transactionBodies(source: string): string[] {
  const bodies: string[] = [];
  let index = source.indexOf('$transaction(');
  while (index !== -1) {
    const open = source.indexOf('(', index);
    let depth = 0;
    let end = source.length;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    bodies.push(source.slice(open, end));
    index = source.indexOf('$transaction(', end);
  }
  return bodies;
}

const NOTIFY = /\.notify(Now|Address|PermissionHolders|PermissionHoldersNow)?\(/;

describe('coach: no notify inside a $transaction', () => {
  it('scans the coach sources (and finds the delivery job that does notify)', () => {
    const all = files(ROOT);
    expect(all.length).toBeGreaterThan(10);
    expect(all.some((f) => NOTIFY.test(readFileSync(f, 'utf8')))).toBe(true);
  });

  it('no $transaction body in src/coach calls notify', () => {
    const offenders = files(ROOT).filter((file) =>
      transactionBodies(stripComments(readFileSync(file, 'utf8'))).some((body) => NOTIFY.test(body)),
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('the detector catches the shape it exists for', () => {
    const bad = 'await this.prisma.$transaction(async (tx) => { await tx.a.create({}); await this.notifications.notifyNow("coach.nudge", u, d); });';
    expect(transactionBodies(bad).some((b) => NOTIFY.test(b))).toBe(true);
  });
});
