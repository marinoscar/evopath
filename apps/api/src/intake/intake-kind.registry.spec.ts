import { BadRequestException, Logger } from '@nestjs/common';
import { z } from 'zod';

import type { IntakeKind } from './intake-kind.interface';
import { IntakeKindRegistry } from './intake-kind.registry';

function kind(name: string, overrides: Partial<IntakeKind> = {}): IntakeKind {
  return {
    kind: name,
    contextSchema: z.undefined(),
    valueSchema: z.object({ name: z.string() }),
    analyzeJobType: null,
    apply: async () => null,
    ...overrides,
  };
}

describe('IntakeKindRegistry', () => {
  let registry: IntakeKindRegistry;

  beforeEach(() => {
    registry = new IntakeKindRegistry();
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns a registered kind by name and lists every name', () => {
    const a = kind('kind_a');
    const b = kind('kind_b');

    registry.register(a);
    registry.register(b);

    expect(registry.get('kind_a')).toBe(a);
    expect(registry.require('kind_b')).toBe(b);
    expect(registry.list()).toEqual(['kind_a', 'kind_b']);
  });

  it('get answers undefined for an unknown kind', () => {
    expect(registry.get('nope')).toBeUndefined();
  });

  it('require answers 400 UNKNOWN_INTAKE_KIND for an unknown kind', () => {
    expect.assertions(3);

    try {
      registry.require('nope');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse() as { details: { reason: string; kind: string } };
      expect(body.details.reason).toBe('UNKNOWN_INTAKE_KIND');
      expect(body.details.kind).toBe('nope');
    }
  });

  it('a duplicate registration replaces the earlier one, with a warning (last one wins)', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const first = kind('dup');
    const second = kind('dup', { analyzeJobType: 'test.second' });

    registry.register(first);
    registry.register(second);

    expect(registry.get('dup')).toBe(second);
    expect(registry.list()).toEqual(['dup']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Duplicate intake kind "dup"');
  });
});
