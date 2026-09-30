import { DoctorCheck } from './doctor-check.interface';
import { DoctorCheckRegistry } from './doctor-check.registry';

function check(id: string): DoctorCheck {
  return {
    id,
    category: 'core',
    label: id,
    run: async () => ({ status: 'pass', detail: 'ok' }),
  };
}

describe('DoctorCheckRegistry', () => {
  it('lists checks in registration order', () => {
    const registry = new DoctorCheckRegistry();

    registry.register(check('b'));
    registry.register(check('a'));

    expect(registry.list().map((c) => c.id)).toEqual(['b', 'a']);
    expect(registry.get('a')?.id).toBe('a');
    expect(registry.get('missing')).toBeUndefined();
  });

  it('throws on a duplicate id rather than silently dropping one check', () => {
    const registry = new DoctorCheckRegistry();

    registry.register(check('db.connection'));

    expect(() => registry.register(check('db.connection'))).toThrow(/Duplicate doctor check id "db.connection"/);
    expect(registry.list()).toHaveLength(1);
  });

  it('returns a copy, so a caller cannot mutate the registry through list()', () => {
    const registry = new DoctorCheckRegistry();
    registry.register(check('a'));

    registry.list().pop();

    expect(registry.list()).toHaveLength(1);
  });
});
