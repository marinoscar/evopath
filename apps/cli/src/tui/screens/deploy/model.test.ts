import { describe, expect, it } from 'vitest';

import { ENV_METADATA } from '../../../deploy/env-metadata.js';
import {
  displayValue,
  isScreenField,
  labelFor,
  MASK,
  shouldMask,
  SCREEN_FIELD_PREFIX,
} from './model.js';

// =============================================================================
// Masking in one place  (issue #406, epic #397)
// =============================================================================
//
// `model.ts`'s own header explains the defect this file exists to keep dead:
// masking was decided twice -- once from a built `FieldSpec` (which has a
// `secret` flag) and once from a bare, prefilled key (which does not) -- and
// the two disagreed for exactly the value most worth hiding. So there must be
// exactly one function anything calls to decide "is this a secret", and it
// must be `env-metadata.ts` underneath, not a second, hand-copied list here.
// =============================================================================

describe('shouldMask: derives the secret set from env-metadata.ts itself', () => {
  // ⚠ THE SET IS DERIVED, NEVER TRANSCRIBED. Reading `ENV_METADATA` directly
  // is the whole point: a key someone newly marks `secret: true` is covered by
  // this test automatically, with no second edit required here. A hardcoded
  // list of key names would need updating by the same person who might forget
  // to mark the key in the first place -- which is no check at all.
  const secretKeys = Object.entries(ENV_METADATA)
    .filter(([, metadata]) => metadata.secret === true)
    .map(([key]) => key);

  const nonSecretKeys = Object.entries(ENV_METADATA)
    .filter(([, metadata]) => metadata.secret !== true)
    .map(([key]) => key);

  it('has at least one secret and one non-secret key to actually exercise the split', () => {
    // A guard on the fixture itself: if this ever goes empty, the two `it`s
    // below would pass vacuously and stop meaning anything.
    expect(secretKeys.length).toBeGreaterThan(0);
    expect(nonSecretKeys.length).toBeGreaterThan(0);
  });

  it('masks every key env-metadata.ts marks secret', () => {
    for (const key of secretKeys) {
      expect(shouldMask(key), `${key} is secret:true but shouldMask said no`).toBe(true);
    }
  });

  it('does not mask any key env-metadata.ts does not mark secret', () => {
    for (const key of nonSecretKeys) {
      expect(shouldMask(key), `${key} is not secret but shouldMask said yes`).toBe(false);
    }
  });

  it('does not mask a key env-metadata.ts has never heard of', () => {
    // `metadataFor` returns `{}` for an unknown key -- a fork's own variable,
    // say -- and `{}` has no `secret` property at all.
    expect(shouldMask('SOME_FORKS_OWN_VARIABLE')).toBe(false);
  });

  it('never masks a screen-local field, however it is named', () => {
    // ⚠ Screen fields are paths, ports and hostnames the operator just typed
    // on THIS screen -- not values read off a `.env`. Masking them would hide
    // the very facts the confirmation screen exists to let someone check.
    // Deliberately includes a `__`-prefixed name that collides with a real
    // secret key, to prove the prefix wins over the underlying key name.
    expect(isScreenField('__name')).toBe(true);
    expect(shouldMask('__name')).toBe(false);

    const secretKey = secretKeys[0] as string;
    expect(shouldMask(`${SCREEN_FIELD_PREFIX}${secretKey}`)).toBe(false);
  });
});

describe('displayValue: the single renderer', () => {
  it('renders MASK, exactly, when shouldMask is true', () => {
    const secretKey = Object.entries(ENV_METADATA).find(
      ([, metadata]) => metadata.secret === true,
    )?.[0] as string;
    expect(shouldMask(secretKey)).toBe(true);

    expect(displayValue(secretKey, 'super-sensitive-value')).toBe(MASK);
  });

  it('renders the real value, unchanged, when shouldMask is false', () => {
    const plainKey = Object.entries(ENV_METADATA).find(
      ([, metadata]) => metadata.secret !== true,
    )?.[0] as string;
    expect(shouldMask(plainKey)).toBe(false);

    expect(displayValue(plainKey, 'app.example.com')).toBe('app.example.com');
  });

  it('agrees with shouldMask for every key in the registry, not just one example each', () => {
    for (const key of Object.keys(ENV_METADATA)) {
      const rendered = displayValue(key, 'the-actual-value');
      if (shouldMask(key)) {
        expect(rendered, `${key}: shouldMask said mask but displayValue leaked it`).toBe(MASK);
      } else {
        expect(rendered, `${key}: shouldMask said show but displayValue hid it`).toBe(
          'the-actual-value',
        );
      }
    }
  });
});

describe('isScreenField / labelFor', () => {
  it('recognises the __ prefix and only the __ prefix', () => {
    expect(isScreenField('__domain')).toBe(true);
    expect(isScreenField('JWT_SECRET')).toBe(false);
    expect(isScreenField('')).toBe(false);
  });

  it('strips the prefix for a label, and leaves an ordinary key untouched', () => {
    expect(labelFor('__domain')).toBe('domain');
    expect(labelFor('JWT_SECRET')).toBe('JWT_SECRET');
  });
});
