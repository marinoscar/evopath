/**
 * reduceRunEvents: the run view model is idempotent by `seq` (duplicates
 * ignored, out-of-order buffered and drained, gaps reported), aggregated per
 * stage, round, source and role, and ends in the right terminal state.
 */
import { describe, it, expect } from 'vitest';
import {
  hasGap,
  initialRunViewState,
  reduceRunEventList,
  reduceRunEvents,
  skipGap,
  MAX_SOURCES,
} from '../../utils/reduceRunEvents';
import type { TrainingRunEvent } from '../../services/trainingAgents';
import { runEvents } from '../mocks/fixtures/runEvents';

/** Deterministic shuffle (so a failure is reproducible). */
function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('reduceRunEvents', () => {
  const inOrder = reduceRunEventList(initialRunViewState(), runEvents());

  it('builds the whole view from an in-order stream', () => {
    expect(inOrder.lastSeq).toBe(runEvents().length);
    expect(inOrder.status).toBe('succeeded');
    expect(Object.values(inOrder.stages).every((s) => s === 'done')).toBe(true);
    expect(inOrder.queries).toEqual(['hypertrophy volume guidelines', 'knee friendly squat']);
    expect(inOrder.sources.map((s) => s.id)).toEqual(['S1', 'S2']);
    expect(inOrder.brief).toMatchObject({ droppedSources: 2, droppedClaims: 1 });
    expect(inOrder.drafts.map((d) => d.round)).toEqual([1, 2]);
    expect(inOrder.guardrails[0].repairs[0].summary).toContain('Swapped');
    expect(inOrder.critic.map((c) => c.verdict)).toEqual(['revise', 'approve']);
    expect(inOrder.criticRound).toBe(2);
    expect(inOrder.usage.planner).toMatchObject({ calls: 2, inputTokens: 5000, outputTokens: 1700 });
    expect(inOrder.usage.researcher).toMatchObject({ provider: 'openai', model: 'frontier-1', calls: 1 });
    expect(inOrder.finalized?.programId).toBe('00000000-0000-4000-8000-c00000000001');
    expect(hasGap(inOrder)).toBe(false);
  });

  it('ignores duplicates: replaying the whole stream twice changes nothing', () => {
    const twice = reduceRunEventList(inOrder, runEvents());
    expect(twice).toEqual(inOrder);
    const interleaved = reduceRunEventList(
      initialRunViewState(),
      runEvents().flatMap((event) => [event, event]),
    );
    expect(interleaved).toEqual(inOrder);
  });

  it.each([1, 7, 42, 1234])('reaches the same state from a shuffled stream (seed %i)', (seed) => {
    const shuffled = reduceRunEventList(initialRunViewState(), shuffle(runEvents(), seed));
    expect(shuffled).toEqual(inOrder);
  });

  it('reaches the same state from a shuffled stream with duplicates', () => {
    const events = shuffle([...runEvents(), ...runEvents().slice(3, 20), ...runEvents().slice(10, 12)], 99);
    expect(reduceRunEventList(initialRunViewState(), events)).toEqual(inOrder);
  });

  it('buffers past a gap, reports it, and drains once the hole is filled', () => {
    const events = runEvents();
    const withHole = reduceRunEventList(initialRunViewState(), [...events.slice(0, 4), ...events.slice(6, 10)]);
    expect(withHole.lastSeq).toBe(4);
    expect(hasGap(withHole)).toBe(true);
    expect(withHole.sources).toEqual([]);

    // The reconnect with ?after=4 replays 5.. (duplicates included).
    const filled = reduceRunEventList(withHole, events.slice(4));
    expect(hasGap(filled)).toBe(false);
    expect(filled).toEqual(inOrder);
  });

  it('skipGap applies the buffered events when the hole cannot be filled', () => {
    const events = runEvents();
    const withHole = reduceRunEventList(initialRunViewState(), [...events.slice(0, 4), ...events.slice(6, 8)]);
    const skipped = skipGap(withHole);
    expect(skipped.lastSeq).toBe(8);
    expect(hasGap(skipped)).toBe(false);
    expect(skipped.sources.map((s) => s.id)).toEqual(['S1', 'S2']);
    expect(skipped.queries).toEqual([]);
  });

  it('keeps one entry per source id and caps the list', () => {
    let state = initialRunViewState();
    for (let i = 1; i <= MAX_SOURCES + 10; i++) {
      state = reduceRunEvents(state, {
        seq: i,
        type: 'research.source',
        data: { id: 'S1', url: 'https://a.org', title: 't', domain: 'a.org', kind: 'rct', verified: true },
      });
    }
    expect(state.sources).toHaveLength(1);
  });

  it('ignores an unverified source and unknown event types', () => {
    const state = reduceRunEventList(initialRunViewState(), [
      { seq: 1, type: 'research.source', data: { id: 'S1', url: 'https://a.org', title: 't', domain: 'a.org', kind: 'rct', verified: false } },
      { seq: 2, type: 'future.thing', data: { anything: true } },
    ]);
    expect(state.sources).toEqual([]);
    expect(state.lastSeq).toBe(2);
  });

  it.each([
    ['run.failed', { code: 'TRAINING_RESEARCH_INSUFFICIENT' }, 'failed'],
    ['run.cancelled', {}, 'cancelled'],
    ['run.interrupted', { reason: 'lost' }, 'interrupted'],
    ['run.awaiting_approval', { kind: 'adaptation', expiresAt: '2026-10-10T00:00:00.000Z' }, 'awaiting_approval'],
    ['run.completed', { status: 'blocked_safety', tokens: {} }, 'blocked_safety'],
  ])('ends %s in status %s', (type, data, status) => {
    const state = reduceRunEventList(initialRunViewState(), [
      { seq: 1, type: 'run.started', data: { kind: 'create' } },
      { seq: 2, type, data: data as Record<string, unknown> },
    ]);
    expect(state.status).toBe(status);
    if (type === 'run.failed') expect(state.failedCode).toBe('TRAINING_RESEARCH_INSUFFICIENT');
    if (type === 'run.interrupted') expect(state.interruptedReason).toBe('lost');
  });

  it('marks earlier active stages done when a later stage starts (research skipped)', () => {
    const state = reduceRunEventList(initialRunViewState(), [
      { seq: 1, type: 'stage.started', data: { node: 'prepare_context' } },
      { seq: 2, type: 'stage.started', data: { node: 'plan' } },
    ]);
    expect(state.stages.context).toBe('done');
    expect(state.stages.research).toBe('pending');
    expect(state.stages.plan).toBe('active');
    expect(state.current).toBe('plan');
  });
});
