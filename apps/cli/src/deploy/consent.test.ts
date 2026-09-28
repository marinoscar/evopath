import { describe, expect, it, vi } from 'vitest';

import { confirm } from '../prompt.js';
import { canObtainConsent, consented, obtainConsent } from './consent.js';

// =============================================================================
// obtainConsent's four outcomes, and the precedence between them  (issue #391)
// =============================================================================
//
// The rules from consent.ts's own header, each pinned by a test:
//
//   - `--flag` is consent given in advance, and wins over everything else;
//   - a non-interactive run can give NO other consent, even when an `ask`
//     callback happens to be supplied -- `nonInteractive` is checked before
//     `ask`, not after;
//   - with `ask` and not non-interactive, its answer is the outcome;
//   - with neither, a TTY gets a real question, defaulting to NO;
//   - with neither and no TTY, consent is simply unavailable.
// =============================================================================

vi.mock('../prompt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prompt.js')>();
  return { ...actual, confirm: vi.fn() };
});

const QUESTION = 'Create the thing?';

describe('obtainConsent', () => {
  it('returns "flag" when the flag was passed, before anything else is even looked at', async () => {
    // Not even a well-formed options object otherwise: flag alone decides.
    const outcome = await obtainConsent(QUESTION, { flag: true, nonInteractive: true });
    expect(outcome).toBe('flag');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('a false flag is not the same as an absent one: falls through to the next rule', async () => {
    const outcome = await obtainConsent(QUESTION, { flag: false, nonInteractive: true });
    expect(outcome).toBe('unavailable');
  });

  it('"unavailable" in a non-interactive run, even when an ask callback is supplied', async () => {
    // ⚠ THE ORDER MATTERS. `nonInteractive` is checked BEFORE `ask`, so an ask
    // callback that happens to be wired up for another test seam must never
    // quietly answer for a run that declared itself unattended.
    const ask = vi.fn(async () => true);
    const outcome = await obtainConsent(QUESTION, { nonInteractive: true, ask });
    expect(outcome).toBe('unavailable');
    expect(ask).not.toHaveBeenCalled();
  });

  it('uses the ask callback\'s answer when interactive: true is "granted"', async () => {
    const ask = vi.fn(async (question: string) => {
      expect(question).toBe(QUESTION);
      return true;
    });
    const outcome = await obtainConsent(QUESTION, { ask });
    expect(outcome).toBe('granted');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('uses the ask callback\'s answer when interactive: false is "declined"', async () => {
    const outcome = await obtainConsent(QUESTION, { ask: async () => false });
    expect(outcome).toBe('declined');
  });

  it('"unavailable" with no ask callback and no TTY', async () => {
    const outcome = await obtainConsent(QUESTION, {
      promptContext: { input: { isTTY: false } as NodeJS.ReadStream },
    });
    expect(outcome).toBe('unavailable');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks a real question on a TTY, defaulting to NO', async () => {
    vi.mocked(confirm).mockResolvedValueOnce(true);
    const ctx = { input: { isTTY: true } as NodeJS.ReadStream };

    const outcome = await obtainConsent(QUESTION, { promptContext: ctx });

    expect(outcome).toBe('granted');
    expect(confirm).toHaveBeenCalledWith(QUESTION, { defaultValue: false }, ctx);
  });

  it('a "no" answer on a TTY is "declined"', async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false);
    const outcome = await obtainConsent(QUESTION, {
      promptContext: { input: { isTTY: true } as NodeJS.ReadStream },
    });
    expect(outcome).toBe('declined');
  });
});

describe('consented', () => {
  it('is true only for "flag" and "granted"', () => {
    expect(consented('flag')).toBe(true);
    expect(consented('granted')).toBe(true);
    expect(consented('declined')).toBe(false);
    expect(consented('unavailable')).toBe(false);
  });
});

describe('canObtainConsent (#396)', () => {
  it('is true with the flag, even non-interactive', () => {
    expect(canObtainConsent({ flag: true, nonInteractive: true })).toBe(true);
  });

  it('is false non-interactive without the flag, even with an ask seam', () => {
    expect(canObtainConsent({ nonInteractive: true, ask: async () => true })).toBe(false);
  });

  it('is true when someone can be asked, and never asks', () => {
    let asked = false;
    expect(
      canObtainConsent({
        ask: async () => {
          asked = true;
          return true;
        },
      }),
    ).toBe(true);
    expect(asked).toBe(false);
  });
});
