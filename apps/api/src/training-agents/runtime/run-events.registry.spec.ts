import { z } from 'zod';

import { InMemoryRunEventLog } from '../testing/in-memory-run-event-log';
import {
  LIFECYCLE_EVENT_TYPES,
  RunEventDataInvalidError,
  parseRunEventData,
  registerRunEventType,
  registeredRunEventTypes,
  runEventSchema,
} from './run-events.registry';

describe('run event registry', () => {
  it('registers every lifecycle type', () => {
    for (const type of LIFECYCLE_EVENT_TYPES) expect(runEventSchema(type)).toBeDefined();
    expect(registeredRunEventTypes()).toEqual(expect.arrayContaining([...LIFECYCLE_EVENT_TYPES]));
  });

  it.each([
    ['run.queued', { kind: 'create', trigger: 'user' }],
    ['run.started', { kind: 'evaluate' }],
    ['run.resumed', { resumeCount: 1 }],
    ['stage.started', { node: 'plan', round: 0 }],
    ['stage.completed', { node: 'critique', round: 2, durationMs: 1200 }],
    [
      'agent.usage',
      {
        role: 'critic',
        node: 'critique',
        provider: 'openai',
        model: 'fake-model',
        inputTokens: 1,
        outputTokens: 2,
        reasoningTokens: 0,
        latencyMs: 5,
      },
    ],
    ['run.deferred', { retryAfterMs: null }],
    ['run.interrupted', { reason: 'deadline' }],
    ['run.awaiting_approval', { kind: 'approval', expiresAt: new Date().toISOString() }],
    ['run.completed', { status: 'succeeded', tokens: { calls: 1, inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } }],
    ['run.failed', { code: 'AI_DISABLED' }],
    ['run.cancelled', {}],
  ])('accepts a well-formed %s', (type, data) => {
    expect(parseRunEventData(type, data)).toEqual(data);
  });

  it.each([
    ['an extra free-text field', 'run.failed', { code: 'AI_DISABLED', message: 'PROMPT CANARY' }],
    ['a prompt smuggled into stage data', 'stage.started', { node: 'plan', instructions: 'PROMPT CANARY' }],
    ['a lower-case code', 'run.failed', { code: 'provider said no' }],
    ['a node name with spaces', 'stage.started', { node: 'Plan the week' }],
    ['an unknown role', 'agent.usage', { role: 'ghost', node: 'x' }],
  ])('refuses %s, naming paths and never values', (_label, type, data) => {
    let error: unknown;
    try {
      parseRunEventData(type, data);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(RunEventDataInvalidError);
    expect(String((error as Error).message)).not.toContain('CANARY');
    expect(String((error as Error).message)).not.toContain('provider said no');
  });

  it('refuses a type nobody registered', () => {
    expect(() => parseRunEventData('plan.draft', {})).toThrow(/no schema is registered/);
  });

  it('lets a story register its own type once, and refuses a clash or a malformed name', () => {
    const schema = z.object({ round: z.number().int() }).strict();

    registerRunEventType('test.registered', schema);
    registerRunEventType('test.registered', schema);

    expect(parseRunEventData('test.registered', { round: 1 })).toEqual({ round: 1 });
    expect(() => registerRunEventType('test.registered', z.object({}))).toThrow(/already registered/);
    expect(() => registerRunEventType('NoDots', schema)).toThrow(/dotted lower case/);
  });
});

describe('InMemoryRunEventLog', () => {
  it('allocates gapless seq from 1 per run and lists after a cursor', async () => {
    const log = new InMemoryRunEventLog();

    await log.append('a', 'run.started', { kind: 'create' });
    await log.append('b', 'run.started', { kind: 'create' });
    await log.append('a', 'stage.started', { node: 'plan' }, 'plan');
    await log.append('a', 'run.cancelled');

    expect((await log.list('a', 0, 10)).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((await log.list('a', 1, 10)).map((e) => e.type)).toEqual(['stage.started', 'run.cancelled']);
    expect((await log.list('b', 0, 10)).map((e) => e.seq)).toEqual([1]);
  });

  it('emit swallows invalid data; append throws it', async () => {
    const log = new InMemoryRunEventLog();

    await expect(log.emit('a', 'run.failed', { code: 'x y' })).resolves.toBeNull();
    await expect(log.append('a', 'run.failed', { code: 'x y' })).rejects.toBeInstanceOf(RunEventDataInvalidError);
    expect(await log.list('a', 0, 10)).toEqual([]);
  });
});
