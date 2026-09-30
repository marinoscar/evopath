import { EVALUATION_LIMITS } from './evaluation.constants';
import {
  type EvaluationFacts,
  evaluationGate,
  manualCooldownRemainingSeconds,
  startOfUtcDay,
} from './evaluation-gates';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const OPEN: EvaluationFacts = {
  aiEnabled: true,
  graphReady: true,
  program: { id: 'p1', autonomyPausedAt: null },
  evaluatorUsable: true,
  proposalPending: false,
  activeRun: null,
  automaticRunsToday: 0,
  lastAutomaticRunAt: null,
  lastManualRunAt: null,
};

describe('evaluationGate', () => {
  it('allows when every gate holds', () => {
    expect(evaluationGate(OPEN, NOW)).toEqual({ allow: true });
  });

  it.each<[string, Partial<EvaluationFacts>, string, boolean]>([
    ['AI off', { aiEnabled: false }, 'ai_disabled', false],
    ['graph not shipped', { graphReady: false }, 'graph_not_ready', false],
    ['no active plan', { program: null }, 'no_active_program', false],
    ['automation paused', { program: { id: 'p1', autonomyPausedAt: minutesAgo(5) } }, 'automation_paused', false],
    ['evaluator blocked', { evaluatorUsable: false }, 'evaluator_unavailable', false],
    ['a proposal waits for the user', { proposalPending: true }, 'proposal_pending', false],
    ['a queued evaluate run covers it', { activeRun: { kind: 'evaluate', status: 'queued' } }, 'covered_by_queued_run', false],
    ['a running evaluate run', { activeRun: { kind: 'evaluate', status: 'running' } }, 'active_run', true],
    ['a create run is active', { activeRun: { kind: 'create', status: 'queued' } }, 'active_run', true],
    ['an evaluation awaits approval', { activeRun: { kind: 'evaluate', status: 'awaiting_approval' } }, 'active_run', true],
    ['3 automatic runs today', { automaticRunsToday: EVALUATION_LIMITS.maxAutomaticPerUtcDay }, 'daily_cap', true],
    ['a manual run 10 minutes ago', { lastManualRunAt: minutesAgo(10) }, 'manual_cooldown', true],
    ['an automatic run 10 minutes ago', { lastAutomaticRunAt: minutesAgo(10) }, 'min_spacing', true],
  ])('%s: %s', (_label, change, reason, defer) => {
    expect(evaluationGate({ ...OPEN, ...change }, NOW)).toEqual({ allow: false, reason, defer });
  });

  it('checks the gates in order: AI off wins over everything else', () => {
    expect(
      evaluationGate({ ...OPEN, aiEnabled: false, program: null, evaluatorUsable: false, automaticRunsToday: 9 }, NOW),
    ).toMatchObject({ reason: 'ai_disabled' });
    expect(evaluationGate({ ...OPEN, program: null, evaluatorUsable: false }, NOW)).toMatchObject({
      reason: 'no_active_program',
    });
  });

  it('allows at exactly 30 minutes after the previous automatic or manual run', () => {
    expect(evaluationGate({ ...OPEN, lastAutomaticRunAt: minutesAgo(30), lastManualRunAt: minutesAgo(30) }, NOW)).toEqual({
      allow: true,
    });
    expect(evaluationGate({ ...OPEN, automaticRunsToday: 2, lastAutomaticRunAt: minutesAgo(31) }, NOW)).toEqual({
      allow: true,
    });
  });

  it('exempts the follow-up rule from the spacing, not from the daily cap or the manual cooldown', () => {
    expect(evaluationGate({ ...OPEN, lastAutomaticRunAt: minutesAgo(1) }, NOW, { followUp: true })).toEqual({ allow: true });
    expect(evaluationGate({ ...OPEN, automaticRunsToday: 3 }, NOW, { followUp: true })).toMatchObject({ reason: 'daily_cap' });
    expect(evaluationGate({ ...OPEN, lastManualRunAt: minutesAgo(1) }, NOW, { followUp: true })).toMatchObject({
      reason: 'manual_cooldown',
    });
  });
});

describe('startOfUtcDay and the manual cooldown', () => {
  it('counts the daily cap from UTC midnight', () => {
    expect(startOfUtcDay(new Date('2026-09-30T23:59:59.999Z')).toISOString()).toBe('2026-09-30T00:00:00.000Z');
    expect(startOfUtcDay(new Date('2026-10-01T00:00:00.000Z')).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('reports the seconds left, rounded up, and 0 once it is over', () => {
    expect(manualCooldownRemainingSeconds(null, NOW)).toBe(0);
    expect(manualCooldownRemainingSeconds(minutesAgo(10), NOW)).toBe(20 * 60);
    expect(manualCooldownRemainingSeconds(new Date(NOW.getTime() - 29 * 60_000 - 59_500), NOW)).toBe(1);
    expect(manualCooldownRemainingSeconds(minutesAgo(30), NOW)).toBe(0);
  });
});
