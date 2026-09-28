import { AiError } from '../core/ai-error';
import { AiEnabledGuard } from './ai-enabled.guard';

describe('AiEnabledGuard', () => {
  it('allows the request when AI is enabled', async () => {
    const guard = new AiEnabledGuard({ assertEnabled: jest.fn().mockResolvedValue(undefined) } as never);

    await expect(guard.canActivate()).resolves.toBe(true);
  });

  it('rejects with AI_DISABLED (403, details.reason) when AI is off', async () => {
    const guard = new AiEnabledGuard({
      assertEnabled: jest
        .fn()
        .mockRejectedValue(new AiError('AI_DISABLED', 'AI features are disabled in this deployment.')),
    } as never);

    const error = (await guard.canActivate().catch((err: unknown) => err)) as AiError;

    expect(error).toBeInstanceOf(AiError);
    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toMatchObject({ details: { reason: 'AI_DISABLED' } });
  });
});
