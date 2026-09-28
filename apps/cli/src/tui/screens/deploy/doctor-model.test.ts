import { describe, expect, it } from 'vitest';

import { MARKS } from '../../../commands/deploy.js';
import type { CompletedCheck } from '../../../deploy/checks/index.js';
import { doctorLine, groupDoctorResults, STATUS_ORDER } from './doctor-model.js';

// =============================================================================
// Doctor results, grouped, with remedies  (issue #393)
// =============================================================================

function check(overrides: Partial<CompletedCheck> & Pick<CompletedCheck, 'id' | 'status'>): CompletedCheck {
  return {
    title: overrides.id,
    detail: `${overrides.id} detail`,
    severity: 'required',
    durationMs: 1,
    ...overrides,
  };
}

const RESULTS: CompletedCheck[] = [
  check({ id: 'docker', status: 'pass', remedy: 'never shown on a pass' }),
  check({ id: 'port', status: 'fail', remedy: 'pick another port with --port' }),
  check({ id: 'dns', status: 'skip', remedy: 'never shown on a skip' }),
  check({ id: 'memory', status: 'warn', severity: 'recommended', remedy: 'add swap' }),
  check({ id: 'certbot', status: 'fail', severity: 'recommended' }),
  check({ id: 'git', status: 'pass' }),
];

describe('groupDoctorResults', () => {
  it('groups worst first: fail, warn, pass, skip', () => {
    const report = groupDoctorResults(RESULTS);
    expect(report.groups.map((group) => group.status)).toEqual(['fail', 'warn', 'pass', 'skip']);
    expect(STATUS_ORDER).toEqual(['fail', 'warn', 'pass', 'skip']);
  });

  it('keeps the checks’ own order within a group', () => {
    const pass = groupDoctorResults(RESULTS).groups.find((group) => group.status === 'pass');
    expect(pass?.items.map((item) => item.id)).toEqual(['docker', 'git']);
  });

  it('carries the remedy beneath failures and warnings, and nowhere else', () => {
    // ⚠ The remedy is the useful half of a failed check -- and a remedy under
    // a PASS reads as an instruction to act on something that is fine.
    const report = groupDoctorResults(RESULTS);
    const remedies = Object.fromEntries(
      report.groups.flatMap((group) => group.items.map((item) => [item.id, item.remedy])),
    );
    expect(remedies).toEqual({
      port: 'pick another port with --port',
      certbot: undefined,
      memory: 'add swap',
      docker: undefined,
      git: undefined,
      dns: undefined,
    });
  });

  it('carries status as a glyph -- the subcommand’s own glyph -- as well as a colour', () => {
    for (const group of groupDoctorResults(RESULTS).groups) {
      expect(group.glyph).toBe(MARKS[group.status]);
      expect(group.glyph.length).toBeGreaterThan(0);
      expect(group.colour.length).toBeGreaterThan(0);
    }
    // Distinct, or the glyph carries nothing.
    expect(new Set(Object.values(MARKS)).size).toBe(4);
  });

  it('decides the verdict the way `deploy doctor` exits: required failures only', () => {
    expect(groupDoctorResults(RESULTS).passed).toBe(false);
    const optionalOnly = RESULTS.filter((result) => result.id !== 'port');
    const report = groupDoctorResults(optionalOnly);
    expect(report.passed).toBe(true);
    // …and says so on the failure that did not count.
    const certbot = report.groups[0]?.items.find((item) => item.id === 'certbot');
    expect(certbot?.optional).toBe(true);
  });

  it('marks only failed optional checks as optional', () => {
    const items = groupDoctorResults(RESULTS).groups.flatMap((group) => group.items);
    expect(items.filter((item) => item.optional).map((item) => item.id)).toEqual(['certbot']);
  });

  it('omits empty groups', () => {
    const report = groupDoctorResults([check({ id: 'docker', status: 'pass' })]);
    expect(report.groups.map((group) => group.status)).toEqual(['pass']);
    expect(report.passed).toBe(true);
  });

  it('headlines the counts in the subcommand’s wording', () => {
    expect(groupDoctorResults(RESULTS).headline).toBe('2 failed, 1 warning(s), 2 passed, 1 skipped');
    expect(groupDoctorResults([]).headline).toBe('0 passed');
  });
});

describe('doctorLine', () => {
  it('leads with the glyph, so a stream with no colour still says what happened', () => {
    expect(doctorLine(check({ id: 'port', status: 'fail', detail: 'in use' }))).toBe(
      `${MARKS.fail} port: in use`,
    );
  });
});
