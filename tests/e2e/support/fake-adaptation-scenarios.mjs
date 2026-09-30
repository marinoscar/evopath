// =============================================================================
// Scenarios for the fake OpenAI-compatible server: quick adaptation and the
// hotel gym scan. TEST-ONLY, dependency free, pure functions.
// =============================================================================
//
// `fake-vision-server.mjs` (port 4010, service `fake-ai` of
// infra/compose/fake-ai.compose.yml) routes a Chat Completions request by
// `response_format.json_schema.name` and calls into this module:
//
//   training_adaptation_proposal   `proposalAnswer`  computed FROM THE REQUEST
//   training_adaptation_critique   `critiqueAnswer`
//   gym_equipment_scan             `scanAnswer`      only for the scan-* scenarios
//
// Exercise keys are generated at seed time, so the planner's answer is built
// from the JSON between <context-json> and </context-json> in the user message
// (the planned exercises and the candidates), never from hard-coded ids.
//
// The literal markers and schema names below are a CONTRACT with
// apps/api/src/training-adaptation/prompts/markers.ts; the Jest contract suite
// apps/api/test/ai/adaptation-fake-server-contract.spec.ts fails when either
// side changes.
//
// The scenario is global to the process (POST /__control/scenario), so the AI
// e2e specs run serially. A request can override it with a `SCENARIO:<name>`
// token anywhere in its free text.
// =============================================================================

export const CONTEXT_JSON_OPEN = '<context-json>';
export const CONTEXT_JSON_CLOSE = '</context-json>';
export const CRITIC_NOTES_OPEN = '<critic-notes>';
export const CRITIC_NOTES_CLOSE = '</critic-notes>';
export const SCHEMA_PROPOSAL = 'training_adaptation_proposal';
export const SCHEMA_CRITIQUE = 'training_adaptation_critique';
export const SCHEMA_SCAN = 'gym_equipment_scan';

/** Scenario name -> what the fake does. */
export const SCENARIOS = {
  valid: 'Keeps the first exercises that fit the minutes, halves sets for sore muscles, the critic accepts.',
  'critic-revise': 'The first critic call answers revise with one major issue and the revise pass drops an accessory (the graph revises once and never asks the critic again; any later critic call accepts).',
  'unknown-exercise': 'Adds an exercise key that is not in the library (the guardrails must remove it).',
  'over-time': 'Proposes every planned exercise with its full sets, so the estimate exceeds the minutes (the guardrails must trim it).',
  'over-volume': 'Proposes two more sets per exercise than the plan (the guardrails must clamp it).',
  malformed: 'Answers the proposal with invalid JSON (AI_STRUCTURED_OUTPUT_INVALID).',
  'rate-limit': 'The first request of the scenario is a 429 with Retry-After: 2, then valid.',
  slow: 'Delays every answer by 3 seconds (progress, cancel).',
  'heavy-tokens': 'The first planner call reports 9,000 input and 3,000 output tokens (per-run cap tests).',
  'scan-hotel': 'The scan finds a hotel gym: dumbbells, adjustable bench, cable machine, treadmill.',
  'scan-empty': 'The scan finds no equipment.',
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);

/** The token counts the fake reports (OpenAI-shaped usage), so E6.3's numbers can be asserted. */
export const SCRIPTED_USAGE = {
  planner: { promptTokens: 1200, completionTokens: 300 },
  critic: { promptTokens: 800, completionTokens: 120 },
  heavyPlanner: { promptTokens: 9000, completionTokens: 3000 },
};

export const SLOW_DELAY_MS = 3000;
export const RATE_LIMIT_RETRY_AFTER_SECONDS = 2;
/** Not in any library: what `unknown-exercise` adds. */
export const UNKNOWN_EXERCISE_KEY = 'ghost_lift_9000';

const WARM_UP_MINUTES = 5;
const WORK_SECONDS_PER_SET = 40;

/** The `SCENARIO:<name>` override in a request's text, or null. */
export function scenarioOverride(text) {
  const match = /SCENARIO:([a-z-]+)/.exec(text ?? '');
  return match && SCENARIO_NAMES.includes(match[1]) ? match[1] : null;
}

/** The scenario a request runs under: its own token, else the process default. */
export function effectiveScenario(defaultScenario, text) {
  return scenarioOverride(text) ?? defaultScenario;
}

/** The JSON between the context markers of a user message, or null. */
export function parseContext(text) {
  const start = text.indexOf(CONTEXT_JSON_OPEN);
  if (start < 0) return null;
  const end = text.indexOf(CONTEXT_JSON_CLOSE, start + CONTEXT_JSON_OPEN.length);
  if (end < 0) return null;
  try {
    return JSON.parse(text.slice(start + CONTEXT_JSON_OPEN.length, end));
  } catch {
    return null;
  }
}

/** The JSON between the critic-notes markers (a revise pass), or null. */
export function parseCriticNotes(text) {
  const start = text.indexOf(CRITIC_NOTES_OPEN);
  if (start < 0) return null;
  const end = text.indexOf(CRITIC_NOTES_CLOSE, start + CRITIC_NOTES_OPEN.length);
  if (end < 0) return null;
  try {
    return JSON.parse(text.slice(start + CRITIC_NOTES_OPEN.length, end));
  } catch {
    return null;
  }
}

/** Estimated minutes of a set list: warm-up plus sets x (work + rest). */
export function estimateMinutes(exercises) {
  const seconds = exercises.reduce((sum, e) => sum + e.sets * (WORK_SECONDS_PER_SET + e.restSeconds), 0);
  return Math.round(WARM_UP_MINUTES + seconds / 60);
}

function modelExercise(base, overrides = {}) {
  return {
    exerciseKey: base.key,
    source: 'kept',
    replacesExerciseKey: null,
    isPriority: Boolean(base.isPriority),
    sets: base.sets,
    repMin: base.repMin,
    repMax: base.repMax,
    targetRpe: base.targetRpe ?? null,
    restSeconds: base.restSeconds,
    note: null,
    ...overrides,
  };
}

function freshSession(candidates) {
  return candidates.slice(0, 4).map((candidate, index) =>
    modelExercise(
      { key: candidate.key, isPriority: index === 0, sets: 3, repMin: 8, repMax: 12, targetRpe: 7, restSeconds: 90 },
      { source: 'added' },
    ),
  );
}

/**
 * The planner's structured answer (`AdaptationProposalModel`), computed from
 * the request context. `revision` is the parsed critic notes on a revise pass.
 */
export function proposalAnswer(scenario, context, revision = null) {
  const request = context?.request ?? {};
  const planned = context?.today?.exercises ?? [];
  const candidates = context?.candidates ?? [];
  const minutes = typeof request.minutes === 'number' ? request.minutes : null;
  const sore = new Set(request.soreness?.muscles ?? []);
  const moderate = request.soreness?.level === 'moderate';
  const lowEnergy = Boolean(request.lowEnergy);
  const ignoreTime = scenario === 'over-time' || scenario === 'over-volume';

  const kept = [];
  const dropped = [];

  for (const exercise of planned) {
    if (exercise.availableHere === false) {
      dropped.push({ exerciseKey: exercise.key, reason: 'equipment' });
      continue;
    }
    const isSore = exercise.primaryMuscles?.some((muscle) => sore.has(muscle)) ?? false;
    if (isSore && moderate) {
      dropped.push({ exerciseKey: exercise.key, reason: 'sore' });
      continue;
    }
    let sets = exercise.sets;
    let targetRpe = exercise.targetRpe ?? null;
    if (isSore) {
      sets = Math.max(1, Math.floor(sets / 2));
      targetRpe = targetRpe === null ? null : Math.min(targetRpe, 8);
    }
    if (lowEnergy) targetRpe = targetRpe === null ? null : Math.min(targetRpe, 7);
    if (scenario === 'over-volume') sets = exercise.sets + 2;

    const candidate = modelExercise(exercise, { sets, targetRpe });
    if (!ignoreTime && minutes !== null && estimateMinutes([...kept, candidate]) > minutes) {
      dropped.push({ exerciseKey: exercise.key, reason: 'time' });
      continue;
    }
    kept.push(candidate);
  }

  if (kept.length === 0 && candidates.length > 0) kept.push(...freshSession(candidates).slice(0, planned.length > 0 ? 2 : 4));

  // A revise pass acts on the critic's notes: drop the last accessory.
  if (revision && kept.length > 1) {
    const index = [...kept].reverse().findIndex((e) => !e.isPriority);
    if (index >= 0) {
      const [removed] = kept.splice(kept.length - 1 - index, 1);
      dropped.push({ exerciseKey: removed.exerciseKey, reason: 'time' });
    }
  }

  if (scenario === 'unknown-exercise') {
    kept.push(
      modelExercise(
        { key: UNKNOWN_EXERCISE_KEY, isPriority: false, sets: 3, repMin: 8, repMax: 12, targetRpe: 7, restSeconds: 60 },
        { source: 'added' },
      ),
    );
  }

  const trimmed = dropped.filter((d) => d.reason === 'time').length;
  const rationale = [
    minutes !== null ? `Fit the session to ${minutes} minutes and kept the priority lifts first.` : 'Kept the session close to the plan.',
    ...(sore.size > 0 ? ['Reduced work for the sore muscles.'] : []),
    ...(revision ? ['Dropped an accessory after the review.'] : []),
  ];

  return {
    title: 'Adjusted workout',
    summary: `Adapted for today${trimmed > 0 ? ` (${trimmed} accessory lift${trimmed === 1 ? '' : 's'} dropped for time)` : ''}.`,
    estimatedMinutes: estimateMinutes(kept),
    exercises: kept,
    dropped,
    rationale,
    uncertainty: [],
  };
}

/**
 * The critic's structured answer. `criticCall` is the 1-based count of critic
 * calls since the scenario was selected.
 */
export function critiqueAnswer(scenario, criticCall) {
  const good = { honoursRequest: true, preservesIntent: true, avoidsSoreAreas: true, sensibleOrder: true };
  if (scenario === 'critic-revise' && criticCall === 1) {
    return {
      verdict: 'revise',
      checks: { ...good, honoursRequest: false },
      issues: [{ code: 'too_many_accessories', severity: 'major', note: 'Drop one accessory so the session fits the time.' }],
    };
  }
  return { verdict: 'accept', checks: good, issues: [] };
}

/** `{ promptTokens, completionTokens }` for one call. `plannerCall` is the 1-based planner call count. */
export function usageFor(schemaName, scenario, plannerCall) {
  if (schemaName === SCHEMA_CRITIQUE) return SCRIPTED_USAGE.critic;
  if (schemaName === SCHEMA_PROPOSAL) {
    return scenario === 'heavy-tokens' && plannerCall === 1 ? SCRIPTED_USAGE.heavyPlanner : SCRIPTED_USAGE.planner;
  }
  return null;
}

function scanItem(catalogSlug, quantity, note, sourcePhotoIndexes) {
  return {
    catalogSlug,
    otherName: null,
    configuration: null,
    quantity,
    quantityUncertain: false,
    brand: null,
    brandEvidence: null,
    model: null,
    confidence: 'high',
    uncertain: false,
    note,
    capabilitySlugs: [],
    sourcePhotoIndexes,
  };
}

/** The scan answer for the scan-* scenarios (`GymEquipmentScan` structured output), or null for any other scenario. */
export function scanAnswer(scenario, imageCount) {
  if (scenario === 'scan-empty') return { items: [], ignoredObjects: [] };
  if (scenario !== 'scan-hotel') return null;
  const last = Math.max(0, imageCount - 1);
  return {
    items: [
      scanItem('dumbbells', 1, 'A short rack of fixed dumbbells.', [0]),
      scanItem('adjustable_bench', 1, null, [0]),
      scanItem('cable_machine', 1, 'One cable tower with a single stack.', [last]),
      scanItem('treadmill', 1, null, [last]),
    ],
    ignoredObjects: ['towel stack', 'water cooler'],
  };
}

/** Whether a scenario answers the scan (so the vision server does not fall back to its fixtures). */
export function isScanScenario(scenario) {
  return scenario === 'scan-hotel' || scenario === 'scan-empty';
}
