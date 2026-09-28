// =============================================================================
// AiKeysRecheckHandler (issue #431, epic #419)
// =============================================================================

import { Job } from '@prisma/client';

import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { AiError } from '../core/ai-error';
import { AiKeysRecheckHandler } from './ai-keys-recheck.handler';
import type { UserAiKeysService } from './user-ai-keys.service';

const CUTOFF = new Date('2026-09-01T00:00:00.000Z');

function job(payload: unknown): Job {
  return { id: 'job-7', type: 'ai.keys.recheck', payload } as unknown as Job;
}

function makeHandler(recheckStale: jest.Mock = jest.fn().mockResolvedValue({ ok: 1, invalid: 0, missing: 0, failed: 0 })) {
  const staleCutoff = jest.fn().mockResolvedValue(CUTOFF);
  const keys = { recheckStale, staleCutoff } as unknown as UserAiKeysService;
  const registry = new JobHandlerRegistry();
  const handler = new AiKeysRecheckHandler(registry, keys);

  return { handler, registry, recheckStale, staleCutoff };
}

describe('AiKeysRecheckHandler', () => {
  it('self-registers under ai.keys.recheck and is server-only', () => {
    const { handler, registry } = makeHandler();

    handler.onModuleInit();

    const asHandler: JobHandler = handler;
    expect(registry.get('ai.keys.recheck')).toBe(handler);
    expect(asHandler.nodeResultSchema).toBeUndefined();
    expect(asHandler.persistNodeResult).toBeUndefined();
    expect(asHandler.nodeSecretBroker).toBeUndefined();
    expect(registry.serverOnlyTypes()).toContain('ai.keys.recheck');
  });

  it('declares a thirty-minute, three-attempt profile', () => {
    expect(makeHandler().handler.profile).toEqual({ maxRuntimeMs: 1_800_000, maxAttempts: 3 });
  });

  it('rechecks the payload provider from its stale cut-off', async () => {
    const { handler, recheckStale, staleCutoff } = makeHandler();

    await handler.process(job({ provider: 'openai' }));

    expect(staleCutoff).toHaveBeenCalledWith('openai');
    expect(recheckStale).toHaveBeenCalledWith('openai', CUTOFF);
  });

  it('rejects a malformed payload', async () => {
    const { handler, recheckStale } = makeHandler();

    await expect(handler.process(job({ providerId: 'openai' }))).rejects.toThrow('Invalid ai.keys.recheck payload');
    expect(recheckStale).not.toHaveBeenCalled();
  });

  it.each(['AI_DISABLED', 'AI_PROVIDER_DISABLED'] as const)(
    'returns normally when %s (an expected stop, not a failure)',
    async (code) => {
      const { handler } = makeHandler(jest.fn().mockRejectedValue(new AiError(code, 'off')));

      await expect(handler.process(job({ provider: 'openai' }))).resolves.toBeUndefined();
    },
  );

  it('defers on a provider rate limit instead of charging an attempt', async () => {
    const { handler } = makeHandler(
      jest.fn().mockRejectedValue(new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 5_000 })),
    );

    await expect(handler.process(job({ provider: 'openai' }))).rejects.toBeInstanceOf(RateLimitError);
  });

  it('fails (for a retry) on anything else', async () => {
    const boom = new Error('db down');
    const { handler } = makeHandler(jest.fn().mockRejectedValue(boom));

    await expect(handler.process(job({ provider: 'openai' }))).rejects.toBe(boom);
  });
});
