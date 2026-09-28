// =============================================================================
// AiKeysCatalogListener (issue #431, epic #419)
// =============================================================================

import type { JobsService } from '../../jobs/jobs.service';
import { AiKeysCatalogListener } from './ai-keys-catalog.listener';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function make(enqueue = jest.fn().mockResolvedValue({ id: 'job-2' })) {
  return { listener: new AiKeysCatalogListener({ enqueue } as unknown as JobsService), enqueue };
}

const event = (added: number) => ({ providerId: 'openai', added, updated: 0, deprecated: 0, jobId: 'job-1' });

describe('AiKeysCatalogListener', () => {
  it('queues a recheck for the provider when a sync added models', async () => {
    const { listener, enqueue } = make();

    listener.handleCatalogSynced(event(3));
    await flush();

    expect(enqueue).toHaveBeenCalledWith({
      type: 'ai.keys.recheck',
      reason: 'backfill',
      subjectType: 'ai_provider',
      subjectId: 'openai',
      payload: { provider: 'openai' },
      priority: 100,
    });
  });

  it('queues nothing when nothing was added', () => {
    const { listener, enqueue } = make();

    listener.handleCatalogSynced(event(0));

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns synchronously and never throws or rejects', async () => {
    const { listener } = make(jest.fn().mockRejectedValue(new Error('db down')));

    expect(listener.handleCatalogSynced(event(1))).toBeUndefined();
    await flush();
  });
});
