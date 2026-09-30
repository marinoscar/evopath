import { ADAPTATION_WARNINGS } from '../adaptation.constants';
import {
  ACCEPT,
  DUMBBELL_30_ANSWER,
  REVISE_MAJOR,
  adaptationRequestFixture,
  modelExercise,
  onlyDumbbellsRequest,
  proposalAnswer,
} from '../testing/adaptation-fixtures';
import { createAdaptationGraphHarness, criticAnswers, plannerAnswers } from '../testing/adaptation-graph-harness';
import { RunBudgetExceededError } from '../../training-agents/runtime/run-budget';
import { resultOf } from './state';

// E6.3: the per-run token cap, surfaced gracefully in the adaptation graph.
// Usage is scripted per call so the cap trips exactly where each case says.

const PLANNER_USAGE = { inputTokens: 1_200, outputTokens: 300 };
const CRITIC_USAGE = { inputTokens: 800, outputTokens: 120 };

const answer = (value: unknown, usage: { inputTokens: number; outputTokens: number }, finishReason: 'stop' | 'length' = 'stop') =>
  () => ({ outputText: JSON.stringify(value), usage, finishReason });

describe('the adaptation graph and the per-run token cap', () => {
  it('a cap the planner spends (1,500): the checked proposal ships, criticReport.skipped = token_cap, no critic call', async () => {
    const h = createAdaptationGraphHarness({
      request: onlyDumbbellsRequest({ minutes: 30 }),
      tokenCap: 1_500,
      scripts: {
        planner: plannerAnswers([answer(DUMBBELL_30_ANSWER, PLANNER_USAGE)]),
        critic: criticAnswers([answer(ACCEPT, CRITIC_USAGE)]),
      },
    });

    const { state } = await h.runGraph();
    const result = resultOf(state)!;

    expect(state.outcome).toEqual({ status: 'ready' });
    expect(h.calls().filter((c) => c.request?.metadata?.agent === 'critic')).toHaveLength(0);
    expect(result.criticReport).toMatchObject({ verdict: null, rounds: 0, skipped: 'token_cap' });
    expect(result.guardrailReport.warnings).toContain(ADAPTATION_WARNINGS.CRITIC_SKIPPED);
    expect(result.proposal.exercises.length).toBeGreaterThan(0);
  });

  it('a critic answer cut off at the last tokens of the cap is token_cap, not error', async () => {
    const h = createAdaptationGraphHarness({
      request: onlyDumbbellsRequest({ minutes: 30 }),
      tokenCap: 1_600,
      scripts: {
        planner: plannerAnswers([answer(DUMBBELL_30_ANSWER, PLANNER_USAGE)]),
        // The output was clamped to the 100 tokens left: the call spends the rest of the cap.
        critic: criticAnswers([answer(ACCEPT, { inputTokens: 800, outputTokens: 100 }, 'length')]),
      },
    });

    const { state } = await h.runGraph();

    expect(state.outcome).toEqual({ status: 'ready' });
    expect(resultOf(state)!.criticReport.skipped).toBe('token_cap');
  });

  it('a cap smaller than the first call fails the run with the cap code and no proposal', async () => {
    const h = createAdaptationGraphHarness({
      request: onlyDumbbellsRequest({ minutes: 30 }),
      tokenCap: 1_000,
      scripts: {
        planner: plannerAnswers([answer(DUMBBELL_30_ANSWER, { inputTokens: 1_200, outputTokens: 1 }, 'length')]),
        critic: criticAnswers([ACCEPT]),
      },
    });

    const error = await h.runGraph().then(
      () => null,
      (err: unknown) => err,
    );

    const cause = findCause(error, RunBudgetExceededError);
    expect(cause).toBeInstanceOf(RunBudgetExceededError);
    expect((cause as RunBudgetExceededError).code).toBe('TRAINING_RUN_BUDGET_EXCEEDED');
    expect((cause as RunBudgetExceededError).cap).toBe(1_000);
  });

  it('a revision the cap cannot pay for keeps the first checked proposal with revision_skipped_token_cap', async () => {
    const first = proposalAnswer([modelExercise('barbell_bench_press', { isPriority: true, sets: 4 }), modelExercise('barbell_row', { sets: 3 })]);
    const h = createAdaptationGraphHarness({
      request: adaptationRequestFixture({ minutes: 45 }),
      tokenCap: 3_000,
      scripts: {
        planner: plannerAnswers([
          answer(first, PLANNER_USAGE),
          // 2,420 used: the revision's output is clamped to the 580 left and cut off.
          answer(proposalAnswer([modelExercise('barbell_row', { sets: 3 })]), { inputTokens: 1_400, outputTokens: 580 }, 'length'),
        ]),
        critic: criticAnswers([answer(REVISE_MAJOR, CRITIC_USAGE)]),
      },
    });

    const { state } = await h.runGraph();
    const result = resultOf(state)!;

    expect(state.outcome).toEqual({ status: 'ready' });
    expect(state.roundCounters).toEqual({ adapt: 2, critic: 1 });
    expect(result.guardrailReport.warnings).toContain(ADAPTATION_WARNINGS.REVISION_SKIPPED_TOKEN_CAP);
    expect(result.proposal.exercises.map((e) => e.exerciseKey)).toEqual(['barbell_bench_press', 'barbell_row']);
    // The critic did review (and asked for the revision): no `skipped` on its report.
    expect(result.criticReport).toMatchObject({ verdict: 'revise', rounds: 1 });
    expect(result.criticReport.skipped).toBeUndefined();
  });
});

function findCause(error: unknown, type: new (...args: never[]) => Error): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (current instanceof type) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return error;
}
