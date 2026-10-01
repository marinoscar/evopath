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

  it('refuses a kind with an analyzer but no aiFeature (#173)', () => {
    expect(() => registry.register(kind('scan', { analyzeJobType: 'ai.x.scan' }))).toThrow(/aiFeature/);
    expect(() => registry.register(kind('scan', { analyzeJobType: 'ai.x.scan', aiFeature: 'gym_scan' }))).not.toThrow();
  });

  it('validates acceptedInputs and maxPdfPages (H2, #186)', () => {
    expect(() => registry.register(kind('ok_default'))).not.toThrow();
    expect(() => registry.register(kind('ok_pdf', { acceptedInputs: ['image', 'pdf'] }))).not.toThrow();
    expect(() => registry.register(kind('ok_pdf_only', { acceptedInputs: ['pdf'], maxPdfPages: 5 }))).not.toThrow();

    expect(() => registry.register(kind('empty', { acceptedInputs: [] }))).toThrow(/no `acceptedInputs`/);
    expect(() => registry.register(kind('unknown', { acceptedInputs: ['image', 'video' as never] }))).toThrow(
      /unknown input "video"/,
    );
    expect(() => registry.register(kind('twice', { acceptedInputs: ['pdf', 'pdf'] }))).toThrow(/twice/);
    expect(() => registry.register(kind('zero_pages', { maxPdfPages: 0 }))).toThrow(/maxPdfPages/);
    expect(() => registry.register(kind('half_pages', { maxPdfPages: 2.5 }))).toThrow(/maxPdfPages/);
    expect(registry.list()).toEqual(['ok_default', 'ok_pdf', 'ok_pdf_only']);
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
    const second = kind('dup', { analyzeJobType: 'test.second', aiFeature: 'gym_scan' });

    registry.register(first);
    registry.register(second);

    expect(registry.get('dup')).toBe(second);
    expect(registry.list()).toEqual(['dup']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Duplicate intake kind "dup"');
  });
});
