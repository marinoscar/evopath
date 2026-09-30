import { ADAPTATION_REASONS } from '../adaptation.constants';
import {
  UPPER_A,
  adaptationContextFixture,
  adaptationRequestFixture,
  modelExercise,
  proposalAnswer,
} from '../testing/adaptation-fixtures';
import { applyAdaptationRules, cannotFitMessage, estimateAdaptedMinutes } from './adaptation-rules';

const facts = (request = adaptationRequestFixture({ minutes: 60 })) => adaptationContextFixture({ request }).facts;
const upperAll = () =>
  UPPER_A.map((e) =>
    modelExercise(e.key, { isPriority: e.isPriority, sets: e.sets, repMin: e.repMin, repMax: e.repMax, targetRpe: e.targetRpe, restSeconds: e.restSeconds }),
  );

describe('applyAdaptationRules', () => {
  it('time repair drops non-priority exercises from the end first, and records each drop with reason "time"', () => {
    const outcome = applyAdaptationRules(proposalAnswer(upperAll()), facts(), { minutes: 30, soreness: null });
    if (!outcome.ok) throw new Error(outcome.message);

    expect(outcome.report.estimatedMinutes).toBeLessThanOrEqual(30);
    expect(outcome.proposal.exercises.slice(0, 2).map((e) => e.exerciseKey)).toEqual(['barbell_bench_press', 'barbell_row']);
    expect(outcome.proposal.dropped.find((d) => d.exerciseKey === 'dumbbell_curl')?.reason).toBe('time');
    expect(outcome.report.repairs.some((r) => r.code === 'time_exercise_dropped')).toBe(true);
  });

  it('cannot fit: ADAPTATION_CANNOT_FIT with "try N+10"', () => {
    const answer = proposalAnswer([
      modelExercise('barbell_bench_press', { isPriority: true, sets: 4, repMin: 5, repMax: 8, restSeconds: 150 }),
      modelExercise('barbell_row', { isPriority: true, sets: 4, repMin: 6, repMax: 10, restSeconds: 120 }),
    ]);
    const outcome = applyAdaptationRules(answer, facts(), { minutes: 10, soreness: null });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe(ADAPTATION_REASONS.CANNOT_FIT);
    expect(outcome.message).toBe(cannotFitMessage(10));
    expect(outcome.message).toBe("Can't fit these lifts in 10 minutes; try 20");
  });

  it('never escalates: no exercise above its planned sets or RPE, total sets within the plan', () => {
    const greedy = upperAll().map((e) => ({ ...e, sets: 8, targetRpe: 10 }));
    const outcome = applyAdaptationRules(proposalAnswer(greedy), facts(), { minutes: null, soreness: null });
    if (!outcome.ok) throw new Error(outcome.message);

    for (const e of outcome.proposal.exercises) {
      const base = UPPER_A.find((b) => b.key === e.exerciseKey)!;
      expect(e.sets).toBeLessThanOrEqual(base.sets);
      expect(e.targetRpe!).toBeLessThanOrEqual(base.targetRpe!);
    }
  });

  it('moderate soreness: a kept prime mover gets at most 2 sets at RPE 6, with a note', () => {
    const outcome = applyAdaptationRules(proposalAnswer(upperAll()), facts(), {
      minutes: null,
      soreness: { muscles: ['chest'], level: 'moderate' },
    });
    if (!outcome.ok) throw new Error(outcome.message);

    const press = outcome.proposal.exercises.find((e) => e.exerciseKey === 'barbell_bench_press')!;
    expect(press.sets).toBe(2);
    expect(press.targetRpe).toBe(6);
    expect(press.note).toMatch(/sore/);
  });

  it('estimateAdaptedMinutes is E5.5\'s duration model', () => {
    expect(estimateAdaptedMinutes([{ sets: 3, repMax: 10, restSeconds: 60, isPriority: false }])).toBe(10);
  });
});
