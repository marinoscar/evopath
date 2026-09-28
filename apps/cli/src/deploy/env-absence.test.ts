import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { genuinelyNewKeys, isExpectedAbsence, type AbsenceContext } from './env-absence.js';
import { parseEnvExample, type EnvVarSpec } from './env-spec.js';

const REAL_TEMPLATE = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'infra',
  'compose',
  '.env.example',
);

const SPECS = parseEnvExample(readFileSync(REAL_TEMPLATE, 'utf8'));
const byKey = new Map(SPECS.map((spec) => [spec.key, spec]));

function specFor(key: string): EnvVarSpec {
  const spec = byKey.get(key);
  if (spec === undefined) throw new Error(`fixture assumes ${key} is still in .env.example`);
  return spec;
}

describe('isExpectedAbsence - class 1: a declined optional variable', () => {
  it('is an expected absence for a commented-out key with no metadata entry', () => {
    // MAINTENANCE_MODE is `# MAINTENANCE_MODE=false` in the template and has no
    // ENV_METADATA entry at all - spec.optional alone is what covers it.
    const spec = specFor('MAINTENANCE_MODE');
    expect(spec.optional).toBe(true);

    expect(isExpectedAbsence(spec, { groups: [] })).toBe(true);
  });
});

describe('isExpectedAbsence - class 2: a `never: true` key', () => {
  it('is an expected absence for TEST_AUTH_ENABLED', () => {
    const spec = specFor('TEST_AUTH_ENABLED');

    expect(isExpectedAbsence(spec, { groups: [] })).toBe(true);
  });

  it('is driven by the `never` flag itself, independent of spec.optional', () => {
    // Injected resolver: prove the `never` branch fires on its own, not merely
    // because the fixture key also happens to be commented out.
    const spec: EnvVarSpec = {
      key: 'SYNTHETIC_NEVER',
      section: 'Synthetic',
      defaultValue: 'x',
      help: '',
      optional: false,
      line: 1,
    };
    const context: AbsenceContext = {
      groups: [],
      metadata: () => ({ never: true }),
    };

    expect(isExpectedAbsence(spec, context)).toBe(true);
  });
});

describe('isExpectedAbsence - class 3: an opt-in feature group never enabled', () => {
  it('is an expected absence for a group key even though spec.optional is FALSE', () => {
    // OTEL_ENABLED=true is UNCOMMENTED in the template (optional: false), so a
    // fix that only reads spec.optional misses this class entirely - that is
    // the exact defect this module exists to prevent.
    const spec = specFor('OTEL_ENABLED');
    expect(spec.optional).toBe(false);

    expect(isExpectedAbsence(spec, { groups: [] })).toBe(true);
  });

  it('is NOT an expected absence once the group is enabled', () => {
    const spec = specFor('OTEL_ENABLED');

    expect(isExpectedAbsence(spec, { groups: ['observability'] })).toBe(false);
  });

  it('demonstrates the same class with an injected resolver on a synthetic key', () => {
    const spec: EnvVarSpec = {
      key: 'SYNTHETIC_GROUPED',
      section: 'Synthetic',
      defaultValue: '',
      help: '',
      optional: false,
      line: 1,
    };
    const context: AbsenceContext = {
      groups: [],
      metadata: () => ({ group: 'email' }),
    };

    expect(isExpectedAbsence(spec, context)).toBe(true);
    expect(isExpectedAbsence(spec, { ...context, groups: ['email'] })).toBe(false);
  });
});

describe('isExpectedAbsence - a genuinely new key', () => {
  it('is NOT an expected absence for an ordinary, ungrouped, uncommented key', () => {
    const spec = specFor('JWT_SECRET');
    expect(spec.optional).toBe(false);

    expect(isExpectedAbsence(spec, { groups: [] })).toBe(false);
  });
});

describe('genuinelyNewKeys', () => {
  it('filters a mixed list down to only the keys none of the three classes explain', () => {
    const missing = [
      specFor('MAINTENANCE_MODE'), // class 1: declined optional
      specFor('TEST_AUTH_ENABLED'), // class 2: never written
      specFor('OTEL_ENABLED'), // class 3: group not enabled
      specFor('JWT_SECRET'), // genuinely new
      specFor('SES_REGION'), // class 3: a different group, also not enabled
    ];

    const result = genuinelyNewKeys(missing, { groups: [] });

    expect(result.map((spec) => spec.key)).toEqual(['JWT_SECRET']);
  });

  it('reclassifies a group key as genuinely new once its group is enabled', () => {
    const missing = [specFor('OTEL_ENABLED'), specFor('JWT_SECRET')];

    const result = genuinelyNewKeys(missing, { groups: ['observability'] });

    expect(result.map((spec) => spec.key).sort()).toEqual(['JWT_SECRET', 'OTEL_ENABLED']);
  });

  it('returns everything when nothing is missing for an expected reason', () => {
    const missing = [specFor('JWT_SECRET'), specFor('COOKIE_SECRET')];

    expect(genuinelyNewKeys(missing, { groups: [] }).map((spec) => spec.key)).toEqual([
      'JWT_SECRET',
      'COOKIE_SECRET',
    ]);
  });

  it('returns nothing when every missing key is expected to be absent', () => {
    const missing = [specFor('MAINTENANCE_MODE'), specFor('TEST_AUTH_ENABLED')];

    expect(genuinelyNewKeys(missing, { groups: [] })).toEqual([]);
  });
});
