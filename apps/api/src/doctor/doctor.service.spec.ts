import { DoctorCheck, DoctorCheckOutcome } from './doctor-check.interface';
import { DoctorCheckRegistry } from './doctor-check.registry';
import { DOCTOR_CACHE_TTL_MS, DOCTOR_FALLBACK_REMEDY, DoctorService, worstStatus } from './doctor.service';

type Partial = Omit<DoctorCheck, 'run' | 'category' | 'label'> & {
  category?: string;
  label?: string;
  run?: () => Promise<DoctorCheckOutcome>;
};

function make(spec: Partial): DoctorCheck & { run: jest.Mock } {
  return {
    category: 'core',
    label: spec.id,
    ...spec,
    run: jest.fn(spec.run ?? (async () => ({ status: 'pass', detail: 'ok' }))),
  } as DoctorCheck & { run: jest.Mock };
}

function setup(...checks: DoctorCheck[]) {
  const registry = new DoctorCheckRegistry();
  for (const c of checks) registry.register(c);
  const service = new DoctorService(registry);
  let clock = 1_000_000;
  (service as unknown as { now: () => number }).now = () => clock;

  return {
    service,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('worstStatus', () => {
  it('orders pass < skip < warn < fail', () => {
    expect(worstStatus(['pass', 'pass'])).toBe('pass');
    expect(worstStatus(['pass', 'skip'])).toBe('skip');
    expect(worstStatus(['skip', 'warn', 'pass'])).toBe('warn');
    expect(worstStatus(['warn', 'fail', 'skip'])).toBe('fail');
  });

  it('is skip for an empty report — nothing ran, nothing was proven', () => {
    expect(worstStatus([])).toBe('skip');
  });
});

describe('DoctorService', () => {
  it('reports every check with the full row shape', async () => {
    const { service } = setup(
      make({
        id: 'db.connection',
        label: 'Database connection',
        settingsPath: '/admin/settings/about',
        run: async () => ({ status: 'pass', detail: 'Connected', data: { latencyMs: 3 } }),
      }),
    );

    const report = await service.run();

    expect(report.verdict).toBe('pass');
    expect(report.generatedAt).toEqual(expect.any(String));
    expect(report.checks).toEqual([
      {
        id: 'db.connection',
        category: 'core',
        label: 'Database connection',
        settingsPath: '/admin/settings/about',
        status: 'pass',
        detail: 'Connected',
        remedy: null,
        error: null,
        data: { latencyMs: 3 },
        durationMs: expect.any(Number),
      },
    ]);
  });

  it('runs independent checks in parallel', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const slow = (id: string) =>
      make({
        id,
        run: async () => {
          started.push(id);
          await gate;
          return { status: 'pass', detail: id };
        },
      });

    const { service } = setup(slow('a'), slow('b'), slow('c'));
    const pending = service.run();

    // Let the microtasks that start each check run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(started.sort()).toEqual(['a', 'b', 'c']);

    release();
    expect((await pending).checks).toHaveLength(3);
  });

  it('turns a throw into a fail carrying the message, and keeps the rest of the report', async () => {
    const { service } = setup(
      make({ id: 'boom', run: async () => { throw new Error('socket hang up'); } }),
      make({ id: 'fine' }),
    );

    const report = await service.run();
    const boom = report.checks.find((c) => c.id === 'boom')!;

    expect(boom.status).toBe('fail');
    expect(boom.error).toBe('socket hang up');
    expect(boom.detail).toContain('socket hang up');
    expect(boom.remedy).toBe(DOCTOR_FALLBACK_REMEDY);
    expect(report.checks.find((c) => c.id === 'fine')!.status).toBe('pass');
    expect(report.verdict).toBe('fail');
  });

  it('fails a check that exceeds its timeout, with a remedy', async () => {
    const { service } = setup(
      make({
        id: 'hang',
        timeoutMs: 20,
        settingsPath: '/admin/settings/storage',
        run: () => new Promise<DoctorCheckOutcome>(() => undefined),
      }),
    );

    const report = await service.run();

    expect(report.checks[0]).toMatchObject({
      status: 'fail',
      detail: 'Timed out after 20ms',
      remedy: expect.stringContaining('/admin/settings/storage'),
    });
  });

  it('skips, without running, a check whose dependency failed', async () => {
    const dependent = make({ id: 'storage.bucket', dependsOn: ['storage.config'] });
    const { service } = setup(
      make({
        id: 'storage.config',
        label: 'Object storage configuration',
        run: async () => ({ status: 'fail', detail: 'no bucket', remedy: 'Configure it' }),
      }),
      dependent,
    );

    const report = await service.run();
    const bucket = report.checks.find((c) => c.id === 'storage.bucket')!;

    expect(bucket.status).toBe('skip');
    expect(bucket.detail).toBe('Skipped: Object storage configuration did not pass');
    expect(bucket.durationMs).toBe(0);
    expect(dependent.run).not.toHaveBeenCalled();
  });

  it('skips transitively through a skipped dependency', async () => {
    const last = make({ id: 'c', dependsOn: ['b'] });
    const { service } = setup(
      make({ id: 'a', run: async () => ({ status: 'skip', detail: 'off' }) }),
      make({ id: 'b', dependsOn: ['a'] }),
      last,
    );

    const report = await service.run();

    expect(report.checks.map((c) => c.status)).toEqual(['skip', 'skip', 'skip']);
    expect(last.run).not.toHaveBeenCalled();
  });

  it('runs a dependent check when its dependency only warned', async () => {
    const dependent = make({ id: 'b', dependsOn: ['a'] });
    const { service } = setup(
      make({ id: 'a', run: async () => ({ status: 'warn', detail: 'slow', remedy: 'x' }) }),
      dependent,
    );

    await service.run();

    expect(dependent.run).toHaveBeenCalled();
  });

  it('waits for a dependency before running the dependent', async () => {
    const order: string[] = [];
    const { service } = setup(
      make({ id: 'b', dependsOn: ['a'], run: async () => { order.push('b'); return { status: 'pass', detail: 'b' }; } }),
      make({
        id: 'a',
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push('a');
          return { status: 'pass', detail: 'a' };
        },
      }),
    );

    await service.run();

    expect(order).toEqual(['a', 'b']);
  });

  it('skips a check that depends on an unregistered id', async () => {
    const { service } = setup(make({ id: 'x', dependsOn: ['ghost'] }));

    const report = await service.run();

    expect(report.checks[0]).toMatchObject({ status: 'skip', detail: expect.stringContaining('ghost') });
  });

  it('fails the checks on a dependency cycle instead of hanging', async () => {
    const { service } = setup(make({ id: 'a', dependsOn: ['b'] }), make({ id: 'b', dependsOn: ['a'] }));

    const report = await service.run();

    expect(report.checks.map((c) => c.status)).toEqual(['fail', 'fail']);
  });

  it('supplies a remedy naming the settings page when a warn/fail has none', async () => {
    const { service } = setup(
      make({ id: 'w', settingsPath: '/admin/settings/email', run: async () => ({ status: 'warn', detail: 'hm' }) }),
      make({ id: 'f', run: async () => ({ status: 'fail', detail: 'no' }) }),
    );

    const report = await service.run();

    expect(report.checks[0].remedy).toBe('Open /admin/settings/email to review.');
    expect(report.checks[1].remedy).toBe(DOCTOR_FALLBACK_REMEDY);
  });

  it('forces detail onto one line', async () => {
    const { service } = setup(make({ id: 'x', run: async () => ({ status: 'pass', detail: 'line one\n  line two\r\n' }) }));

    expect((await service.run()).checks[0].detail).toBe('line one line two');
  });

  it('fails an outcome with an invalid status', async () => {
    const { service } = setup(
      make({ id: 'x', run: async () => ({ status: 'great' as never, detail: 'x' }) }),
    );

    expect((await service.run()).checks[0].status).toBe('fail');
  });

  it('computes the verdict as the worst status', async () => {
    const { service } = setup(
      make({ id: 'a' }),
      make({ id: 'b', run: async () => ({ status: 'skip', detail: 'off' }) }),
      make({ id: 'c', run: async () => ({ status: 'warn', detail: 'hm', remedy: 'r' }) }),
    );

    expect((await service.run()).verdict).toBe('warn');
  });

  it('sorts by category order, then registration order', async () => {
    const { service } = setup(
      make({ id: 'telemetry.export', category: 'telemetry' }),
      make({ id: 'fork.thing', category: 'fork' }),
      make({ id: 'db.migrations', category: 'core' }),
      make({ id: 'storage.config', category: 'storage' }),
      make({ id: 'db.connection', category: 'core' }),
      make({ id: 'fork.other', category: 'another-fork' }),
    );

    const ids = (await service.run()).checks.map((c) => c.id);

    expect(ids).toEqual([
      'db.migrations',
      'db.connection',
      'storage.config',
      'telemetry.export',
      'fork.thing',
      'fork.other',
    ]);
  });

  it('filters by category, running but not reporting a cross-category dependency', async () => {
    const dep = make({ id: 'core.dep', category: 'core' });
    const { service } = setup(
      dep,
      make({ id: 'storage.config', category: 'storage', dependsOn: ['core.dep'] }),
      make({ id: 'ai.enabled', category: 'ai' }),
    );

    const report = await service.run({ category: 'storage' });

    expect(report.checks.map((c) => c.id)).toEqual(['storage.config']);
    expect(report.checks[0].status).toBe('pass');
    expect(dep.run).toHaveBeenCalled();
  });

  it('answers an unknown category with an empty, skip-verdict report', async () => {
    const { service } = setup(make({ id: 'a' }));

    const report = await service.run({ category: 'nope' });

    expect(report.checks).toEqual([]);
    expect(report.verdict).toBe('skip');
  });

  describe('cache', () => {
    it('serves the same report within the TTL without re-running checks', async () => {
      const a = make({ id: 'a' });
      const { service, advance } = setup(a);

      const first = await service.run();
      advance(DOCTOR_CACHE_TTL_MS - 1);
      const second = await service.run();

      expect(second).toBe(first);
      expect(a.run).toHaveBeenCalledTimes(1);
    });

    it('runs again after the TTL', async () => {
      const a = make({ id: 'a' });
      const { service, advance } = setup(a);

      await service.run();
      advance(DOCTOR_CACHE_TTL_MS);
      await service.run();

      expect(a.run).toHaveBeenCalledTimes(2);
    });

    it('bypasses the cache on refresh, and the refreshed report replaces it', async () => {
      const a = make({ id: 'a' });
      const { service } = setup(a);

      await service.run();
      const refreshed = await service.run({ refresh: true });
      const after = await service.run();

      expect(a.run).toHaveBeenCalledTimes(2);
      expect(after).toBe(refreshed);
    });

    it('keys the cache by category', async () => {
      const a = make({ id: 'a', category: 'core' });
      const { service } = setup(a);

      await service.run();
      await service.run({ category: 'core' });

      expect(a.run).toHaveBeenCalledTimes(2);
    });

    it('shares one in-flight run between concurrent callers', async () => {
      const a = make({ id: 'a' });
      const { service } = setup(a);

      const [one, two] = await Promise.all([service.run(), service.run()]);

      expect(one).toBe(two);
      expect(a.run).toHaveBeenCalledTimes(1);
    });
  });
});
