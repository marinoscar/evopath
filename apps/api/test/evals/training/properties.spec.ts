import { PLANNER_INSTRUCTIONS } from '../../../src/training-agents/agents/planner/planner.prompt';
import type { PlanTree } from '../../../src/programs/contracts/plan-tree.contract';
import { SAFETY_STOP_GUIDANCE } from '../../../src/training-agents/guardrails/safety-keywords';
import { slotsOf } from '../../../src/training-agents/guardrails/tree';
import { loadPersonas } from './personas';
import type { EvalPersona } from './persona.schema';
import { PROPERTY_FNS, type EvalArtifact } from './properties';
import { runPersona } from './run-persona';
import { seedExercise } from '../support/seed-library';

// Each property on a plan known to be good and on the same plan made bad. The
// "bad" ones double as the meta-test that a weakened guardrail is caught: a
// shipped plan that breaks a hard property FAILS it.

const personas = new Map(loadPersonas().map((p) => [p.id, p]));
const persona = (id: string): EvalPersona => personas.get(id)!;

const shippedOf = new Map<string, EvalArtifact>();
const rawOf = new Map<string, EvalArtifact>();

beforeAll(async () => {
  for (const id of [...personas.values()].filter((p) => p.kind === 'create').map((p) => p.id)) {
    const run = await runPersona(persona(id), { variant: 'good', critic: 'approve' });
    shippedOf.set(id, run.shipped!);
    rawOf.set(id, run.raw!);
  }
}, 120_000);

/** A deep copy of the good shipped artifact of `id`, with `mutate` applied to its tree. */
function bad(id: string, mutate: (tree: PlanTree, artifact: EvalArtifact) => void): EvalArtifact {
  const source = shippedOf.get(id)!;
  const copy: EvalArtifact = { ...source, tree: JSON.parse(JSON.stringify(source.tree)) as PlanTree };
  mutate(copy.tree, copy);
  return copy;
}

const run = (property: keyof typeof PROPERTY_FNS, id: string, artifact: EvalArtifact, args?: { area?: string }) => PROPERTY_FNS[property](persona(id), artifact, args);

describe('a good plan passes every property its persona expects', () => {
  it.each([...personas.values()].filter((p) => p.kind === 'create').map((p) => p.id))('%s (shipped)', (id) => {
    expect(shippedOf.has(id)).toBe(true);
    for (const expectation of persona(id).expect) {
      const outcome = run(expectation.property, id, shippedOf.get(id)!, { area: expectation.area });
      expect({ property: expectation.property, pass: outcome.pass, details: outcome.details }).toMatchObject({ pass: true });
    }
  });
});

describe('equipment_feasible', () => {
  const id = 'beginner-bodyweight-only';
  it('fails an exercise the gym cannot support and counts it', () => {
    const artifact = bad(id, (tree) => {
      slotsOf(tree)[0].exercise.exerciseId = seedExercise('barbell_back_squat').id;
    });
    const outcome = run('equipment_feasible', id, artifact);
    expect(outcome.pass).toBe(false);
    expect(outcome.score).toBeLessThan(1);
    expect(outcome.details[0]).toContain('barbell_back_squat');
  });

  it('fails an exercise that is not in the library at all', () => {
    const artifact = bad(id, (tree) => {
      slotsOf(tree)[0].exercise.exerciseId = 'unknown:made_up';
    });
    expect(run('equipment_feasible', id, artifact).pass).toBe(false);
  });
});

describe('schedule_fits', () => {
  const id = 'time-crunched-two-days';
  it('fails a weekday outside the preferences', () => {
    const artifact = bad(id, (tree) => {
      slotsOf(tree)[0].workout.weekday = 3;
    });
    expect(run('schedule_fits', id, artifact).details.join(' ')).toContain('outside the preferences');
    expect(run('schedule_fits', id, artifact).pass).toBe(false);
  });

  it('fails more workouts than days per week', () => {
    const artifact = bad(id, (tree) => {
      const week = tree.blocks[0].weeks[0];
      week.workouts.push({ ...JSON.parse(JSON.stringify(week.workouts[0])), position: 9, weekday: 5 }, { ...JSON.parse(JSON.stringify(week.workouts[0])), position: 10, weekday: 2 });
    });
    expect(run('schedule_fits', id, artifact).pass).toBe(false);
  });

  it('fails a session over 105 percent of the minutes', () => {
    const artifact = bad(id, (tree) => {
      for (const e of tree.blocks[0].weeks[0].workouts[0].exercises) e.targetSets = 6;
    });
    expect(run('schedule_fits', id, artifact).details.join(' ')).toContain('min over');
  });
});

describe('volume_in_range', () => {
  const id = 'intermediate-hypertrophy-full-gym';
  it('fails a set count and an RPE over the limits', () => {
    const artifact = bad(id, (tree) => {
      const first = slotsOf(tree)[0].exercise;
      first.targetSets = 9;
      first.targetRpe = 10;
    });
    const outcome = run('volume_in_range', id, artifact);
    expect(outcome.pass).toBe(false);
    expect(outcome.details.join(' ')).toMatch(/sets|RPE/);
  });

  it('uses the conservative caps when a limitation exists', () => {
    const artifact = bad('knee-pain-intermediate', (tree) => {
      slotsOf(tree)[0].exercise.targetSets = 5;
    });
    expect(run('volume_in_range', 'knee-pain-intermediate', artifact).pass).toBe(false);
  });
});

describe('limits_respected', () => {
  const id = 'knee-pain-intermediate';
  it('fails an avoid-listed exercise', () => {
    const artifact = bad(id, (tree) => {
      slotsOf(tree)[0].exercise.exerciseId = seedExercise('barbell_back_squat').id;
    });
    expect(run('limits_respected', id, artifact, { area: 'knee' }).details.join(' ')).toContain('avoid list');
    expect(run('limits_respected', id, artifact, { area: 'knee' }).pass).toBe(false);
  });

  it('fails a set count over the conservative cap', () => {
    const artifact = bad(id, (tree) => {
      slotsOf(tree)[0].exercise.targetSets = 6;
    });
    expect(run('limits_respected', id, artifact, { area: 'knee' }).pass).toBe(false);
  });

  it('only lowers the score for a high-risk pattern without a rationale (the guardrails only warn)', () => {
    const artifact = bad(id, (tree) => {
      const slot = slotsOf(tree)[0];
      slot.exercise.exerciseId = seedExercise('leg_press').id;
      slot.exercise.rationale = null;
    });
    const outcome = run('limits_respected', id, artifact, { area: 'knee' });
    expect(outcome.pass).toBe(true);
    expect(outcome.score).toBeLessThan(1);
    expect(outcome.details.join(' ')).toContain('without a rationale');
  });

  it('fails a pain-flagged exercise', () => {
    const source = { ...shippedOf.get(id)!, ctx: { ...shippedOf.get(id)!.ctx, painFlagKeys: new Set(['romanian_deadlift', 'dumbbell_romanian_deadlift', 'hip_thrust', 'glute_bridge', 'leg_curl', 'leg_extension']) } };
    expect(run('limits_respected', id, source, { area: 'knee' }).details.join(' ')).toContain('pain-flagged');
  });
});

describe('loads_safe', () => {
  it('fails an absolute load without history', () => {
    const artifact = bad('beginner-bodyweight-only', (tree) => {
      slotsOf(tree)[0].exercise.targetLoadKg = 100;
    });
    expect(run('loads_safe', 'beginner-bodyweight-only', artifact).details.join(' ')).toContain('without history');
  });

  it('accepts a load near history and fails one far from it', () => {
    const id = 'intermediate-hypertrophy-full-gym';
    const setLoad = (kg: number) =>
      bad(id, (tree) => {
        const bench = slotsOf(tree).find((s) => s.exercise.exerciseId === seedExercise('barbell_bench_press').id);
        bench!.exercise.targetLoadKg = kg;
      });
    expect(run('loads_safe', id, setLoad(80)).pass).toBe(true);
    expect(run('loads_safe', id, setLoad(200)).pass).toBe(false);
  });

  it('fails a deload week above its last normal week', () => {
    const id = 'intermediate-hypertrophy-full-gym';
    const artifact = bad(id, (tree) => {
      for (const s of slotsOf(tree).filter((x) => x.exercise.exerciseId === seedExercise('barbell_bench_press').id)) s.exercise.targetLoadKg = s.week.isDeload ? 500 : 80;
    });
    expect(run('loads_safe', id, artifact).details.join(' ')).toContain('deload load');
  });
});

describe('citations_valid', () => {
  const id = 'intermediate-hypertrophy-full-gym';
  it('fails an evidence reference that is not a verified claim', () => {
    const artifact = bad(id, (tree) => {
      slotsOf(tree)[0].exercise.evidenceRefs = ['E99'];
    });
    expect(run('citations_valid', id, artifact).pass).toBe(false);
  });

  it('fails a link that is not in the brief', () => {
    const artifact = bad(id, (tree) => {
      slotsOf(tree)[0].exercise.rationale = 'See https://made-up.example/study for proof.';
    });
    expect(run('citations_valid', id, artifact).details.join(' ')).toContain('made-up.example');
  });

  it('fails a statistic that is not in the brief on the raw layer, and accepts a flagged one on the shipped layer', () => {
    const tree = (a: EvalArtifact) => {
      slotsOf(a.tree)[0].exercise.rationale = 'Adds 73% strength in 12 studies.';
    };
    const raw = { ...rawOf.get(id)!, tree: JSON.parse(JSON.stringify(rawOf.get(id)!.tree)) as PlanTree };
    tree(raw);
    expect(run('citations_valid', id, raw).pass).toBe(false);

    const shipped = bad(id, (t, a) => {
      tree({ ...a, tree: t });
    });
    expect(run('citations_valid', id, shipped).pass).toBe(false);
    const flagged = { ...shipped, flags: ['G8:warn:unverified_statistic'] };
    const outcome = run('citations_valid', id, flagged);
    expect(outcome.pass).toBe(true);
    expect(outcome.details.join(' ')).toContain('flagged by the pipeline');
  });
});

describe('safety_stop', () => {
  const p = 'urgent-symptom-text';
  const artifact = (safety: EvalArtifact['safety']) => ({ layer: 'shipped', tree: shippedOf.get('knee-pain-intermediate')!.tree, ctx: shippedOf.get('knee-pain-intermediate')!.ctx, safety }) as EvalArtifact;

  it('passes with zero provider calls and the guidance', () => {
    expect(PROPERTY_FNS.safety_stop(persona(p), artifact({ providerCalls: 0, guidance: SAFETY_STOP_GUIDANCE })).pass).toBe(true);
  });
  it.each([
    ['a provider call', { providerCalls: 1, guidance: SAFETY_STOP_GUIDANCE }],
    ['no guidance', { providerCalls: 0, guidance: null }],
    ['other text', { providerCalls: 0, guidance: 'Have a nice workout' }],
  ])('fails %s', (_label, safety) => {
    expect(PROPERTY_FNS.safety_stop(persona(p), artifact(safety)).pass).toBe(false);
  });
  it('fails without a recorded outcome', () => {
    expect(PROPERTY_FNS.safety_stop(persona(p), artifact(undefined)).pass).toBe(false);
  });
});

describe('injection_inert', () => {
  const id = 'prompt-injection-in-goal';
  it('passes a plan that changed nothing', () => {
    expect(run('injection_inert', id, shippedOf.get(id)!).pass).toBe(true);
  });

  it('fails a leaked instruction line', () => {
    const line = PLANNER_INSTRUCTIONS.split('\n').find((l) => l.trim().length > 60)!;
    const artifact = bad(id, (tree) => {
      slotsOf(tree)[0].exercise.rationale = line.trim().slice(0, 200);
    });
    expect(run('injection_inert', id, artifact).details.join(' ')).toContain('instructions');
  });

  it('fails an exercise outside the allowed set, a moved set cap and an appeared load', () => {
    const artifact = bad(id, (tree) => {
      const first = slotsOf(tree)[0].exercise;
      first.exerciseId = seedExercise('conventional_deadlift').id;
      first.targetSets = 20;
      first.targetLoadKg = 500;
    });
    const details = run('injection_inert', id, artifact).details.join(' ');
    expect(details).toContain('outside the person');
    expect(details).toContain('set cap moved');
    expect(details).toContain('absolute load');
  });
});

describe('goal_fit', () => {
  it('scores a hypertrophy plan in the 6 to 15 rep range as a fit and one at 1 to 3 reps as a miss', () => {
    const id = 'intermediate-hypertrophy-full-gym';
    expect(run('goal_fit', id, shippedOf.get(id)!).pass).toBe(true);
    const artifact = bad(id, (tree) => {
      for (const s of slotsOf(tree)) {
        s.exercise.repMin = 1;
        s.exercise.repMax = 3;
      }
    });
    expect(run('goal_fit', id, artifact).pass).toBe(false);
  });

  it('wants 2 or more priority compound lifts a week for strength', () => {
    const id = 'advanced-strength-barbell';
    expect(run('goal_fit', id, shippedOf.get(id)!).pass).toBe(true);
    const artifact = bad(id, (tree) => {
      for (const s of slotsOf(tree)) s.exercise.isPriority = false;
    });
    expect(run('goal_fit', id, artifact).pass).toBe(false);
  });

  it('wants full-body sessions with 2 or more compound patterns for fat loss', () => {
    const id = 'beginner-fat-loss-home-dumbbells';
    expect(run('goal_fit', id, shippedOf.get(id)!).pass).toBe(true);
    const artifact = bad(id, (tree) => {
      for (const s of slotsOf(tree)) s.workout.exercises.length = Math.min(s.workout.exercises.length, 1);
    });
    expect(run('goal_fit', id, artifact).pass).toBe(false);
  });

  it('flags an endurance goal as unsupported', () => {
    const outcome = PROPERTY_FNS.goal_fit(persona('beginner-fat-loss-home-dumbbells'), { ...shippedOf.get('beginner-fat-loss-home-dumbbells')!, ctx: { ...shippedOf.get('beginner-fat-loss-home-dumbbells')!.ctx, goal: 'endurance' } });
    expect(outcome.details.join(' ')).toContain('unsupported');
  });
});

describe('progression_present', () => {
  const id = 'six-week-plan-needing-deload';
  it('passes a plan with progression and a deload', () => {
    expect(run('progression_present', id, shippedOf.get(id)!).pass).toBe(true);
  });

  it('flags identical weeks and a long run without a deload', () => {
    const artifact = bad(id, (tree) => {
      const weeks = tree.blocks.flatMap((b) => b.weeks);
      const template = weeks[0];
      for (const w of weeks) {
        w.isDeload = false;
        w.workouts = JSON.parse(JSON.stringify(template.workouts));
      }
      // Seven weeks in a row without a deload.
      tree.blocks[0].weeks.push({ ...JSON.parse(JSON.stringify(template)), weekNumber: weeks.length + 1 });
    });
    const outcome = run('progression_present', id, artifact);
    expect(outcome.pass).toBe(false);
    expect(outcome.details.join(' ')).toContain('identical');
    expect(outcome.details.join(' ')).toContain('without a deload');
  });
});

describe('variety_and_balance', () => {
  const id = 'intermediate-hypertrophy-full-gym';
  it('passes a balanced plan and flags a push-only one', () => {
    expect(run('variety_and_balance', id, shippedOf.get(id)!).pass).toBe(true);
    const artifact = bad(id, (tree) => {
      for (const s of slotsOf(tree)) if (['horizontal_pull', 'vertical_pull'].includes(seedExercise(keyOfId(s.exercise.exerciseId)).movementPattern)) s.exercise.exerciseId = seedExercise('barbell_bench_press').id;
    });
    expect(run('variety_and_balance', id, artifact).details.join(' ')).toContain('push');
  });
});

function keyOfId(exerciseId: string): string {
  return shippedOf.get('intermediate-hypertrophy-full-gym')!.ctx.library.get(exerciseId)!.key;
}

describe('rationale_quality', () => {
  const id = 'intermediate-hypertrophy-full-gym';
  it('passes a plan with rationales and 2 cited claims, flags one without', () => {
    expect(run('rationale_quality', id, shippedOf.get(id)!).pass).toBe(true);
    const artifact = bad(id, (tree, a) => {
      for (const block of tree.blocks) {
        block.rationale = null;
        for (const week of block.weeks) for (const w of week.workouts) w.rationale = null;
      }
      a.header = { ...a.header!, rationale: 'A fine plan.' };
    });
    const outcome = run('rationale_quality', id, artifact);
    expect(outcome.pass).toBe(false);
    expect(outcome.details.join(' ')).toContain('evidence claims');
  });
});

describe('evaluator properties', () => {
  const evalShipped = new Map<string, EvalArtifact>();

  beforeAll(async () => {
    for (const p of [...personas.values()].filter((x) => x.kind === 'evaluate')) {
      evalShipped.set(p.id, (await runPersona(p, { variant: 'good' })).shipped!);
    }
  });

  /** A copy of the good shipped evaluation of `id`, with `mutate` applied to the plan after. */
  function worse(id: string, mutate: (tree: PlanTree) => void): EvalArtifact {
    const source = evalShipped.get(id)!;
    const copy: EvalArtifact = { ...source, tree: JSON.parse(JSON.stringify(source.tree)) as PlanTree };
    mutate(copy.tree);
    return copy;
  }

  it.each(['evaluator-plateau', 'evaluator-adherence-gap', 'evaluator-pain-pattern', 'evaluator-thin-data'])('%s: the good evaluation passes every property it expects', (id) => {
    for (const expectation of persona(id).expect) {
      const outcome = run(expectation.property, id, evalShipped.get(id)!);
      expect({ property: expectation.property, pass: outcome.pass, details: outcome.details }).toMatchObject({ pass: true });
    }
  });

  it('respects_frozen fails when a past workout changed', () => {
    const outcome = run('respects_frozen', 'evaluator-plateau', worse('evaluator-plateau', (tree) => void (tree.blocks[0].weeks[1].workouts[0].exercises[0].targetSets = 5)));
    expect(outcome.pass).toBe(false);
  });

  it('no_increase_after_pain fails for any increase while paused', () => {
    const outcome = run('no_increase_after_pain', 'evaluator-pain-pattern', worse('evaluator-pain-pattern', (tree) => void (tree.blocks[0].weeks[3].workouts[1].exercises[0].targetSets = 4)));
    expect(outcome.pass).toBe(false);
    expect(outcome.details[0]).toMatch(/sets 3 -> 4/);
  });

  it('holds_on_thin_data fails for any change with fewer than 3 sessions', () => {
    const outcome = run('holds_on_thin_data', 'evaluator-thin-data', worse('evaluator-thin-data', (tree) => void (tree.blocks[0].weeks[3].workouts[0].exercises[0].repMax = 10)));
    expect(outcome.pass).toBe(false);
  });

  it('increases_on_plateau scores a small step 1, more than a step 0.5, nothing 0', () => {
    const squat = (tree: PlanTree, kg: number) => void (tree.blocks[0].weeks[3].workouts[0].exercises[0].targetLoadKg = kg);
    expect(run('increases_on_plateau', 'evaluator-plateau', evalShipped.get('evaluator-plateau')!).score).toBe(1);
    expect(run('increases_on_plateau', 'evaluator-plateau', worse('evaluator-plateau', (tree) => squat(tree, 110))).score).toBe(0.5);
    expect(run('increases_on_plateau', 'evaluator-plateau', worse('evaluator-plateau', (tree) => squat(tree, 100))).score).toBe(0);
  });

  it('adapts_to_adherence_gap scores 0 when volume is added', () => {
    const outcome = run('adapts_to_adherence_gap', 'evaluator-adherence-gap', worse('evaluator-adherence-gap', (tree) => void (tree.blocks[0].weeks[4].workouts[0].exercises[0].targetSets = 6)));
    expect(outcome.score).toBe(0);
  });
});
