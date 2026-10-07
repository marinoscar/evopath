import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { Registry, RegistryFreezeService, defineRegistry, listDefinedRegistries } from '@marinoscar/platform-api/core';

import { CommonModule } from '../../src/common/common.module';

interface Entry {
  id: string;
}

describe('RegistryFreezeService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('freezes every defined registry on onApplicationBootstrap and logs each name and size at debug', () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const permissions = defineRegistry<Entry>({ name: 'freeze-spec-permissions', idOf: (e) => e.id });
    const prefixes = defineRegistry<Entry>({ name: 'freeze-spec-prefixes', idOf: (e) => e.id });
    permissions.registerAll([{ id: 'a:read' }, { id: 'a:write' }]);
    const instance = new Registry<Entry>({ name: 'freeze-spec-instance', idOf: (e) => e.id });

    new RegistryFreezeService().onApplicationBootstrap();

    expect(permissions.frozen).toBe(true);
    expect(prefixes.frozen).toBe(true);
    expect(listDefinedRegistries().every((r) => r.frozen)).toBe(true);
    expect(instance.frozen).toBe(false);
    expect(() => permissions.register({ id: 'a:delete' })).toThrow(expect.objectContaining({ code: 'FROZEN' }));
    expect(permissions.ids()).toEqual(['a:read', 'a:write']);

    expect(debug).toHaveBeenCalledTimes(1);
    const line = String(debug.mock.calls[0][0]);
    expect(line).toContain('freeze-spec-permissions(2)');
    expect(line).toContain('freeze-spec-prefixes(0)');
  });

  it('is idempotent, so a second application in the same worker bootstraps cleanly', () => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const registry = defineRegistry<Entry>({ name: 'freeze-spec-twice', idOf: (e) => e.id });
    const service = new RegistryFreezeService();

    service.onApplicationBootstrap();

    expect(() => service.onApplicationBootstrap()).not.toThrow();
    expect(registry.frozen).toBe(true);
  });

  it('runs from the Nest lifecycle: init() freezes, compile() alone does not', async () => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const registry = defineRegistry<Entry>({ name: 'freeze-spec-lifecycle', idOf: (e) => e.id });
    const moduleRef = await Test.createTestingModule({ providers: [RegistryFreezeService] }).compile();

    expect(registry.frozen).toBe(false);

    await moduleRef.init();
    try {
      expect(registry.frozen).toBe(true);
    } finally {
      await moduleRef.close();
    }
  });

  it('is provided by CommonModule, which AppModule imports', () => {
    const providers: unknown[] = Reflect.getMetadata('providers', CommonModule) ?? [];

    expect(providers).toContain(RegistryFreezeService);
  });
});
