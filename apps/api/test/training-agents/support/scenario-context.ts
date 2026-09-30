import type { PlannerContextSource } from '../../../src/training-agents/context/build-planner-context';
import { loadPersonas, contextSourceOf } from '../../evals/training/personas';

// The context the scenario planner outputs were written for: the beginner
// persona in a home gym with adjustable dumbbells and an adjustable bench (the
// gym the browser e2e setup creates), read from the E4 seed catalog.

export const SCENARIO_PERSONA_ID = 'e2e-dumbbell-home';

export function scenarioContextSource(): PlannerContextSource {
  const base = loadPersonas().find((p) => p.id === 'beginner-fat-loss-home-dumbbells');
  if (!base) throw new Error('The beginner home-dumbbell persona fixture is missing');
  return contextSourceOf({
    ...base,
    id: SCENARIO_PERSONA_ID,
    gym: { name: 'Garage Gym', equipment: ['adjustable_dumbbells', 'adjustable_bench'] },
  });
}
