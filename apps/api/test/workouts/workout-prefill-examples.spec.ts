// =============================================================================
// The "Prefill from photo" e2e inputs exist and pair up (E4.7)
// =============================================================================
//
// `tests/e2e/specs/workout-prefill.spec.ts`, the fake vision server and the
// fixtures name the same files. A rename or a deleted fixture would otherwise
// surface only in a Playwright run against a live stack, which is not part of
// CI. This is the cheap tier: the reference photo is a real JPEG, every
// fixture the fake serves for the prefill exists and parses, and the fake
// server names each of them.
// =============================================================================

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { WORKOUT_PREFILL_FIXTURE_DIR } from '../fixtures/workout-prefill.fixtures';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FAKE_SERVER = join(REPO_ROOT, 'tests', 'e2e', 'support', 'fake-vision-server.mjs');

describe('workout prefill e2e inputs', () => {
  it('the placard photo is a JPEG', () => {
    const file = join(REPO_ROOT, 'docs', 'examples', 'gym-scan', 'leg-curl-placard.jpg');

    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBeGreaterThan(1024);
    expect(readFileSync(file).subarray(0, 3).toString('hex')).toBe('ffd8ff');
  });

  it.each([
    ['workout-placard', 'placard'],
    ['workout-notebook', 'notebook'],
    ['workout-empty', 'workout-empty'],
  ])('the fake server serves %s from %s.model-output.json', (fixture, file) => {
    const path = join(WORKOUT_PREFILL_FIXTURE_DIR, `${file}.model-output.json`);

    expect(existsSync(path)).toBe(true);
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow();
    expect(readFileSync(FAKE_SERVER, 'utf8')).toContain(`'${fixture}': 'workout-prefill/${file}'`);
  });

  it('the empty fixture recognizes nothing', () => {
    const output = JSON.parse(readFileSync(join(WORKOUT_PREFILL_FIXTURE_DIR, 'workout-empty.model-output.json'), 'utf8'));

    expect(output.items).toEqual([]);
  });

  it('the placard has expected drafts', () => {
    expect(existsSync(join(WORKOUT_PREFILL_FIXTURE_DIR, 'placard.expected-drafts.json'))).toBe(true);
  });
});
