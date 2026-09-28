// =============================================================================
// AiCatalogRefreshHandler (issue #427, epic #419)
// =============================================================================

import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from '@prisma/client';

import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { AiError } from '../core/ai-error';
import { AiCatalogRefreshHandler } from './ai-catalog-refresh.handler';
import { AI_CATALOG_SYNCED_EVENT } from './ai-catalog.events';
import type { AiCatalogService } from './ai-catalog.service';

function job(payload: unknown): Job {
  return { id: 'job-1', type: 'ai.catalog.refresh', payload } as unknown as Job;
}

function makeHandler(sync: jest.Mock, emit: jest.Mock = jest.fn()) {
  const catalog = { sync } as unknown as AiCatalogService;
  const registry = new JobHandlerRegistry();
  const handler = new AiCatalogRefreshHandler(registry, catalog, { emit } as unknown as EventEmitter2);

  return { handler, registry, emit };
}

describe('AiCatalogRefreshHandler', () => {
  it('self-registers under ai.catalog.refresh', () => {
    const { handler, registry } = makeHandler(jest.fn());

    handler.onModuleInit();

    expect(registry.get('ai.catalog.refresh')).toBe(handler);
  });

  it('is server-only: no node result schema or persist function', () => {
    const { handler, registry } = makeHandler(jest.fn());

    handler.onModuleInit();

    const asHandler: JobHandler = handler;

    expect(asHandler.nodeResultSchema).toBeUndefined();
    expect(asHandler.persistNodeResult).toBeUndefined();
    expect(registry.serverOnlyTypes()).toContain('ai.catalog.refresh');
  });

  it('declares the five-minute, three-attempt profile', () => {
    const { handler } = makeHandler(jest.fn());

    expect(handler.profile).toEqual({ maxRuntimeMs: 300_000, maxAttempts: 3 });
  });

  it('syncs the payload provider, passing the job id and the requesting admin', async () => {
    const sync = jest.fn().mockResolvedValue({ added: 1, updated: 0, deprecated: 0, total: 1 });
    const { handler } = makeHandler(sync);
    const actor = '4b1f3c1e-2a8d-4e7a-9d4b-1f0a2c3d4e5f';

    await handler.process(job({ providerId: 'openai', actorUserId: actor }));

    expect(sync).toHaveBeenCalledWith('openai', { actorUserId: actor, jobId: 'job-1' });
  });

  it('accepts the #428 payload shape { providerId } alone', async () => {
    const sync = jest.fn().mockResolvedValue({ added: 0, updated: 0, deprecated: 0, total: 0 });
    const { handler } = makeHandler(sync);

    await handler.process(job({ providerId: 'openai' }));

    expect(sync).toHaveBeenCalledWith('openai', { actorUserId: undefined, jobId: 'job-1' });
  });

  it.each(['AI_DISABLED', 'AI_PROVIDER_DISABLED', 'NO_ADMIN_KEY', 'PROVIDER_NOT_REGISTERED'])(
    'returns normally (a no-op, not a failure) when the sync is skipped: %s',
    async (reason) => {
      const { handler } = makeHandler(jest.fn().mockResolvedValue({ skipped: reason }));

      await expect(handler.process(job({ providerId: 'openai' }))).resolves.toBeUndefined();
    },
  );

  it('rejects a payload without a providerId', async () => {
    const sync = jest.fn();
    const { handler } = makeHandler(sync);

    await expect(handler.process(job({}))).rejects.toThrow(/payload/);
    await expect(handler.process(job(null))).rejects.toThrow(/payload/);
    expect(sync).not.toHaveBeenCalled();
  });

  it('turns a provider rate limit into the queue deferral signal', async () => {
    const { handler } = makeHandler(
      jest
        .fn()
        .mockRejectedValue(new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 1234 })),
    );

    const error = await handler.process(job({ providerId: 'openai' })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(1234);
  });

  it('rethrows any other AiError unchanged, so the attempt is charged', async () => {
    const original = new AiError('AI_KEY_INVALID', 'bad key');
    const { handler } = makeHandler(jest.fn().mockRejectedValue(original));

    await expect(handler.process(job({ providerId: 'openai' }))).rejects.toBe(original);
  });

  it('rethrows a non-AI error unchanged', async () => {
    const original = new Error('db down');
    const { handler } = makeHandler(jest.fn().mockRejectedValue(original));

    await expect(handler.process(job({ providerId: 'openai' }))).rejects.toBe(original);
  });

  describe('the exported hook (AI_CATALOG_SYNCED_EVENT, #431)', () => {
    it('emits the counts after a sync that ran', async () => {
      const sync = jest.fn().mockResolvedValue({ added: 2, updated: 1, deprecated: 0, total: 9 });
      const { handler, emit } = makeHandler(sync);

      await handler.process(job({ providerId: 'openai' }));

      expect(emit).toHaveBeenCalledWith(AI_CATALOG_SYNCED_EVENT, {
        providerId: 'openai',
        added: 2,
        updated: 1,
        deprecated: 0,
        jobId: 'job-1',
      });
    });

    it('emits nothing for a skipped sync', async () => {
      const { handler, emit } = makeHandler(jest.fn().mockResolvedValue({ skipped: 'AI_DISABLED' }));

      await handler.process(job({ providerId: 'openai' }));

      expect(emit).not.toHaveBeenCalled();
    });

    it('a throwing listener cannot fail a committed sync', async () => {
      const sync = jest.fn().mockResolvedValue({ added: 1, updated: 0, deprecated: 0, total: 1 });
      const emit = jest.fn(() => {
        throw new Error('listener blew up');
      });
      const { handler } = makeHandler(sync, emit);

      await expect(handler.process(job({ providerId: 'openai' }))).resolves.toBeUndefined();
    });
  });
});
