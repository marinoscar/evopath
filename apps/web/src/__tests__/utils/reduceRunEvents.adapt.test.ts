/**
 * The run reducer on an E6.1 adaptation run (kind `adapt`): the graph's node
 * names map onto the shared stages, and `run.deferred` carries the wait.
 */
import { describe, it, expect } from 'vitest';
import { initialRunViewState, NODE_STAGE, reduceRunEventList } from '../../utils/reduceRunEvents';
import { adaptRunEvents } from '../mocks/fixtures/adaptations';

describe('reduceRunEvents (adapt)', () => {
  it('maps the adaptation nodes onto the stages', () => {
    expect(NODE_STAGE.context).toBe('context');
    expect(NODE_STAGE.adapt).toBe('plan');
    expect(NODE_STAGE.guardrails).toBe('guardrails');
    expect(NODE_STAGE.critic).toBe('critique');
    expect(NODE_STAGE.finalize).toBe('ready');
  });

  it('walks an adaptation run to done', () => {
    const events = adaptRunEvents();
    const midway = reduceRunEventList(initialRunViewState(), events.slice(0, 6));
    expect(midway.stages.context).toBe('done');
    expect(midway.current).toBe('plan');

    const done = reduceRunEventList(initialRunViewState(), events);
    expect(done.stages).toMatchObject({ context: 'done', plan: 'done', guardrails: 'done', critique: 'done', ready: 'done' });
    expect(done.criticRound).toBe(1);
    expect(done.status).toBe('succeeded');
    expect(done.usage.planner?.calls).toBe(1);
  });

  it('records the provider wait on run.deferred and clears it when the run starts again', () => {
    const deferred = reduceRunEventList(initialRunViewState(), [
      { seq: 1, type: 'run.started', data: {} },
      { seq: 2, type: 'run.deferred', data: { retryAfterMs: 12_000 } },
    ]);
    expect(deferred.status).toBe('queued');
    expect(deferred.deferredRetryAfterMs).toBe(12_000);

    const resumed = reduceRunEventList(deferred, [{ seq: 3, type: 'run.resumed', data: {} }]);
    expect(resumed.deferredRetryAfterMs).toBeNull();
  });
});
