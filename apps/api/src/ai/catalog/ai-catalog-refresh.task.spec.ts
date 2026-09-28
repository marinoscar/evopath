// =============================================================================
// AiCatalogRefreshTask (issue #427, epic #419)
// =============================================================================
//
// The task's whole job is deciding whether to enqueue, so that decision is
// all this asserts: nothing while AI is off, one job per ENABLED provider,
// each carrying the payload/subject shape the handler and #428 agree on.
// =============================================================================

import type { JobsService } from '../../jobs/jobs.service';
import type { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { AiCatalogRefreshTask } from './ai-catalog-refresh.task';

function makeTask(policy: {
  enabled: boolean;
  providers: Record<string, { enabled: boolean }>;
}, enqueue = jest.fn().mockResolvedValue({ id: 'job-1' })) {
  const systemSettings = {
    getAiPolicy: jest.fn().mockResolvedValue(policy),
  } as unknown as SystemSettingsService;
  const jobs = { enqueue } as unknown as JobsService;

  return { task: new AiCatalogRefreshTask(systemSettings, jobs), enqueue };
}

describe('AiCatalogRefreshTask', () => {
  it('queues nothing while the AI kill switch is off', async () => {
    const { task, enqueue } = makeTask({ enabled: false, providers: { openai: { enabled: true } } });

    await task.handleCron();

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queues nothing for a disabled provider', async () => {
    const { task, enqueue } = makeTask({ enabled: true, providers: { openai: { enabled: false } } });

    await task.handleCron();

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queues one refresh per enabled provider, keyed by provider subject', async () => {
    const { task, enqueue } = makeTask({
      enabled: true,
      providers: { openai: { enabled: true }, other: { enabled: false }, third: { enabled: true } },
    });

    await task.handleCron();

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        type: 'ai.catalog.refresh',
        reason: 'backfill',
        subjectType: 'ai_provider',
        subjectId: 'openai',
        payload: { providerId: 'openai' },
      }),
      expect.objectContaining({ subjectId: 'third', payload: { providerId: 'third' } }),
    ]);
  });

  it('relies on type+subject dedup rather than skipDedup', async () => {
    const { task, enqueue } = makeTask({ enabled: true, providers: { openai: { enabled: true } } });

    await task.handleCron();

    expect(enqueue.mock.calls[0][0].skipDedup).toBeUndefined();
  });

  it('keeps going when one enqueue fails, and never throws out of the cron', async () => {
    const enqueue = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ id: 'job-2' });
    const { task } = makeTask(
      { enabled: true, providers: { openai: { enabled: true }, third: { enabled: true } } },
      enqueue,
    );

    await expect(task.handleCron()).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('never throws when the policy cannot be read', async () => {
    const systemSettings = {
      getAiPolicy: jest.fn().mockRejectedValue(new Error('boom')),
    } as unknown as SystemSettingsService;
    const enqueue = jest.fn();
    const task = new AiCatalogRefreshTask(systemSettings, { enqueue } as unknown as JobsService);

    await expect(task.handleCron()).resolves.toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
