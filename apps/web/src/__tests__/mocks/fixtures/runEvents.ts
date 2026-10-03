/** A realistic training run's event stream, for reducer, hook and page tests. */
import type { TrainingRunEvent } from '../../../services/trainingAgents';

const SCORES = {
  goal_fit: 4,
  equipment_feasibility: 5,
  volume_intensity: 3,
  recovery: 4,
  injury_handling: 4,
  progression: 3,
  adherence_realism: 4,
  evidence_alignment: 5,
};

/** A realistic run: context, research, plan, guardrails, critique (revise), plan, guardrails, critique (approve), finalize. */
export function runEvents(): TrainingRunEvent[] {
  const list: Array<[string, Record<string, unknown>]> = [
    ['run.queued', { kind: 'create', trigger: 'user' }],
    ['run.started', { kind: 'create' }],
    ['stage.started', { node: 'prepare_context' }],
    ['stage.completed', { node: 'prepare_context', durationMs: 10 }],
    ['stage.started', { node: 'research' }],
    ['research.query', { queries: ['hypertrophy volume guidelines', 'knee friendly squat'] }],
    ['research.source', { id: 'S1', url: 'https://acsm.org/a', title: 'ACSM stand', domain: 'acsm.org', kind: 'position_stand', verified: true }],
    ['research.source', { id: 'S2', url: 'https://pubmed.gov/b', title: 'Meta', domain: 'pubmed.gov', kind: 'meta_analysis', verified: true }],
    ['research.brief', { claimCount: 5, sourceCount: 2, droppedClaims: 1, droppedSources: 2, researchMode: 'single', basis: 'web_verified' }],
    ['agent.usage', { role: 'researcher', node: 'research', provider: 'openai', model: 'frontier-1', inputTokens: 1000, outputTokens: 200, reasoningTokens: 50, latencyMs: 10 }],
    ['stage.completed', { node: 'research', durationMs: 10 }],
    ['stage.started', { node: 'plan' }],
    ['plan.draft', { round: 1, weeks: 8, workouts: 32, exercises: 160 }],
    ['agent.usage', { role: 'planner', node: 'plan', provider: 'openai', model: 'frontier-1', inputTokens: 3000, outputTokens: 900, reasoningTokens: 0, latencyMs: 10 }],
    ['stage.completed', { node: 'plan', durationMs: 10 }],
    ['stage.started', { node: 'guardrails' }],
    ['guardrail.report', { round: 1, status: 'repaired', counts: { block: 0, repair: 1, warn: 0 }, repairs: [{ rule: 'G2', summary: 'Swapped barbell-bench-press for dumbbell-bench-press: no barbell at Home Gym' }] }],
    ['stage.completed', { node: 'guardrails', durationMs: 10 }],
    ['stage.started', { node: 'critique', round: 1 }],
    ['critic.round', { round: 1, verdict: 'revise', scores: { ...SCORES, progression: 2 }, blockers: [{ dimension: 'progression', issue: 'No load progression in weeks 5 to 8' }], summary: 'Needs progression.' }],
    ['stage.completed', { node: 'critique', round: 1, durationMs: 10 }],
    ['stage.started', { node: 'plan' }],
    ['plan.draft', { round: 2, weeks: 8, workouts: 32, exercises: 158 }],
    ['agent.usage', { role: 'planner', node: 'plan', provider: 'openai', model: 'frontier-1', inputTokens: 2000, outputTokens: 800, reasoningTokens: 0, latencyMs: 10 }],
    ['stage.completed', { node: 'plan', durationMs: 10 }],
    ['stage.started', { node: 'guardrails' }],
    ['guardrail.report', { round: 2, status: 'clean', counts: { block: 0, repair: 0, warn: 0 }, repairs: [] }],
    ['stage.completed', { node: 'guardrails', durationMs: 10 }],
    ['stage.started', { node: 'critique', round: 2 }],
    ['critic.round', { round: 2, verdict: 'approve', scores: SCORES, blockers: [], summary: 'Good plan.' }],
    ['stage.completed', { node: 'critique', round: 2, durationMs: 10 }],
    ['stage.started', { node: 'finalize' }],
    ['plan.finalized', { programId: '00000000-0000-4000-8000-c00000000001', versionNumber: 1, warnings: [] }],
    ['stage.completed', { node: 'finalize', durationMs: 10 }],
    ['run.completed', { status: 'succeeded', tokens: { calls: 3, inputTokens: 6000, outputTokens: 1900, reasoningTokens: 50 } }],
  ];
  return list.map(([type, data], i) => ({ seq: i + 1, type, data }));
}

