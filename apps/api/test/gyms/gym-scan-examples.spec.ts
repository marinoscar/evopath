// =============================================================================
// The "Scan gym" reference examples exist and pair up (E3.6)
// =============================================================================
//
// The e2e (`tests/e2e/specs/gym-scan.spec.ts`), the fake vision server, the
// fixtures and the spec all name the same files. A rename or a deleted photo
// would otherwise surface only in a Playwright run against a live stack, which
// is not part of CI. This is the cheap tier: the two reference photos are real
// JPEGs, and each has its fixture pair. Fixture contents are checked by the
// mapper and fake-server suites.
// =============================================================================

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { GYM_SCAN_FIXTURE_DIR } from '../fixtures/gym-scan.fixtures';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const EXAMPLE_DIR = join(REPO_ROOT, 'docs', 'examples', 'gym-scan');

describe('gym scan reference examples', () => {
  it.each(['cardio-row-wide', 'leg-curl-placard'])('%s.jpg is a JPEG photo', (name) => {
    const file = join(EXAMPLE_DIR, `${name}.jpg`);

    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBeGreaterThan(1024);
    // JPEG start-of-image marker.
    expect(readFileSync(file).subarray(0, 3).toString('hex')).toBe('ffd8ff');
  });

  it.each(['cardio-row-wide', 'leg-curl-placard'])('%s has model output and expected drafts fixtures', (name) => {
    for (const suffix of ['model-output', 'expected-drafts']) {
      const file = join(GYM_SCAN_FIXTURE_DIR, `${name}.${suffix}.json`);

      expect(existsSync(file)).toBe(true);
      expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow();
    }
  });

  it('has the combined fixture the fake server serves for two photos', () => {
    const file = join(GYM_SCAN_FIXTURE_DIR, 'both.model-output.json');

    expect(existsSync(file)).toBe(true);
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow();
  });
});
