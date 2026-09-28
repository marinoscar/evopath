// =============================================================================
// AiKeysRecheckTask (issue #431, epic #419)
// =============================================================================
//
// The task's whole job is deciding whether to enqueue: nothing while AI is off,
// one `ai.keys.recheck` per enabled provider that has at least one stored key.
// That it only enqueues is pinned structurally by
// `test/jobs/cron-enqueue-only.spec.ts`.
// =============================================================================

import type { AiConfigService, AiPolicy } from '../config/ai-config.service';
import type { JobsService } from '../../jobs/jobs.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { AiKeysRecheckTask } from './ai-keys-recheck.task';

function makeTask(policy: Partial<AiPolicy>, keyCount = 3) {
  const resolve = jest.fn().mockResolvedValue({
    enabled: true,
    keyPolicy: 'byok',
    providers: { openai: { enabled: true }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } },
    defaults: { allowBackgroundRuns: true },
    logPromptContent: false,
    ...policy,
  });
  const count = jest.fn().mockResolvedValue(keyCount);
  const enqueue = jest.fn().mockResolvedValue({ id: 'job-1' });
  const task = new AiKeysRecheckTask(
    { resolve } as unknown as AiConfigService,
    { userAiKey: { count } } as unknown as PrismaService,
    { enqueue } as unknown as JobsService,
  );

  return { task, enqueue, count, resolve };
}

describe('AiKeysRecheckTask', () => {
  it('queues nothing while AI is off', async () => {
    const { task, enqueue, count } = makeTask({ enabled: false });

    await task.handleCron();

    expect(enqueue).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('queues nothing for a disabled provider', async () => {
    const { task, enqueue } = makeTask({ providers: { openai: { enabled: false }, anthropic: { enabled: false }, gemini: { enabled: false }, 'azure-openai': { enabled: false }, 'openai-compatible': { enabled: false } } });

    await task.handleCron();

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queues nothing for a provider nobody has a key for', async () => {
    const { task, enqueue } = makeTask({}, 0);

    await task.handleCron();

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queues one recheck per due provider, keyed by provider subject', async () => {
    const { task, enqueue, resolve } = makeTask({});

    await task.handleCron();

    expect(resolve).toHaveBeenCalledWith({ fresh: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      type: 'ai.keys.recheck',
      reason: 'backfill',
      subjectType: 'ai_provider',
      subjectId: 'openai',
      payload: { provider: 'openai' },
      priority: 100,
    });
  });

  it('never throws out of the cron', async () => {
    const { task, enqueue } = makeTask({});
    enqueue.mockRejectedValue(new Error('db down'));

    await expect(task.handleCron()).resolves.toBeUndefined();
  });
});
