/**
 * A fake `connectTrainingRunStream` for hook and page tests: records every
 * connection (with the `after` cursor it was opened with) and lets the test
 * push events, state changes and the `end` frame into the latest one.
 */
import { act } from '@testing-library/react';
import type { TrainingRunEvent, TrainingRunStreamHandlers } from '../../services/trainingAgents';

export interface FakeConnection {
  runId: string;
  after: number;
  handlers: TrainingRunStreamHandlers;
  closed: boolean;
}

export function fakeRunStream() {
  const connections: FakeConnection[] = [];
  const connect = (runId: string, after: number, handlers: TrainingRunStreamHandlers) => {
    const connection: FakeConnection = { runId, after, handlers, closed: false };
    connections.push(connection);
    handlers.onStateChange?.('connecting');
    return {
      close: () => {
        connection.closed = true;
      },
    };
  };
  const latest = () => {
    const open = connections.filter((c) => !c.closed);
    return open[open.length - 1];
  };
  return {
    connect,
    connections,
    latest,
    open: () => act(() => latest()?.handlers.onStateChange?.('open')),
    emit: (...events: TrainingRunEvent[]) =>
      act(() => {
        for (const event of events) latest()?.handlers.onEvent(event);
      }),
    state: (state: 'open' | 'reconnecting' | 'closed') => act(() => latest()?.handlers.onStateChange?.(state)),
    end: (status: string) => act(() => latest()?.handlers.onEnd(status)),
  };
}
