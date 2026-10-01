import { NEVER_SEND_LABELS } from '../context/never-send';
import { EVALUATOR_CONTEXT_KEYS, summarizeEvaluatorContext } from '../context/summarize-context';
import {
  CANARY,
  EVAL_AS_OF,
  EVAL_EXERCISES,
  evaluationSignals,
  evaluationSources,
  painRow,
} from '../testing/evaluation-fixtures';
import { HEALTH_SUMMARY_FIXTURE } from '../testing/context-fixtures';
import { buildEvaluatorContext } from './build-evaluator-context';
import { evaluateContextOf } from './evaluate-context';

const NOW = new Date('2026-09-24T12:00:00.000Z');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const build = (sources = evaluationSources(), options: Partial<Parameters<typeof buildEvaluatorContext>[1]> = {}) =>
  buildEvaluatorContext(sources, { trigger: 'workout_finished', deep: false, now: NOW, ...options });

describe('buildEvaluatorContext', () => {
  it('sends the plan from the current week on, with week facts', () => {
    const { sent } = build();

    expect(sent.plan.currentWeek).toBe(3);
    expect(sent.plan.totalWeeks).toBe(4);
    expect(sent.plan.weeks.map((w) => [w.weekNumber, w.block, w.isDeload, w.lastWeekOfBlock])).toEqual([
      [3, 1, false, false],
      [4, 1, true, true],
    ]);
  });

  it('locks today\'s and past workouts and those a logged session is linked to (E1)', () => {
    const plain = build().sent.plan.weeks.flatMap((w) => w.workouts.map((o) => [o.ref, o.date, o.locked]));
    expect(plain).toEqual([
      ['W3-1', '2026-09-21', true],
      ['W3-2', '2026-09-24', true], // today
      ['W4-1', '2026-09-28', false],
      ['W4-2', '2026-10-01', false],
    ]);

    const sources = evaluationSources();
    const w41 = sources.tree.blocks[0].weeks[3].workouts[0].id!;
    const linked = build({ ...sources, linkedProgramWorkoutIds: [w41] });
    expect(linked.sent.plan.weeks[1].workouts[0]).toMatchObject({ ref: 'W4-1', locked: true });
    expect(linked.server.refs['W4-1-2']).toMatchObject({ locked: true });
  });

  it('maps every short ref back to its rows (round trip), numbering workouts and exercises by position', () => {
    const sources = evaluationSources();
    const context = build(sources);

    for (const week of sources.tree.blocks[0].weeks) {
      const workouts = [...week.workouts].sort((a, b) => a.position - b.position);
      workouts.forEach((workout, w) => {
        expect(context.server.refs[`W${week.weekNumber}-${w + 1}`]).toMatchObject({
          kind: 'workout',
          weekNumber: week.weekNumber,
          programWorkoutId: workout.id,
        });
        workout.exercises.forEach((exercise, e) => {
          expect(context.server.refs[`W${week.weekNumber}-${w + 1}-${e + 1}`]).toMatchObject({
            kind: 'exercise',
            programWorkoutId: workout.id,
            programExerciseId: exercise.id,
            exerciseId: exercise.exerciseId,
          });
        });
      });
    }
    // Week 2 lists its Thursday workout first; position, not array order, numbers it.
    expect(context.server.refs['W2-1-1'].exerciseKey).toBe('back_squat');
    // Every sent exercise ref resolves to the key it was sent with.
    for (const week of context.sent.plan.weeks) {
      for (const workout of week.workouts) {
        for (const exercise of workout.exercises) {
          expect(context.server.refs[exercise.ref]).toMatchObject({ exerciseKey: exercise.key, locked: workout.locked });
        }
      }
    }
    expect(context.server.exerciseIdsByKey).toMatchObject({ back_squat: EVAL_EXERCISES.squat.id });
  });

  it('names planned sessions by workout ref and exercises by key in the signals', () => {
    const sources = evaluationSources();
    const monday3 = sources.tree.blocks[0].weeks[2].workouts[0];
    sources.signals = evaluationSignals((s) => {
      s.sessions = [
        { programWorkoutId: monday3.id!, name: CANARY.workoutName, plannedFor: '2026-09-21', status: 'done', workoutId: monday3.id!, setsPlanned: 6, setsDone: 6, completionPct: 100, avgRpe: 8 },
        { programWorkoutId: '00000000-0000-4000-8000-000000000000', name: CANARY.workoutName, plannedFor: '2026-09-01', status: 'missed', workoutId: null, setsPlanned: 6, setsDone: 0, completionPct: null, avgRpe: null },
      ];
      s.pain = [painRow('squat', { consecutiveFlaggedSessions: 2 })];
      s.performance = [
        {
          exerciseId: EVAL_EXERCISES.bench.id,
          slug: 'bench_press',
          name: CANARY.exerciseName,
          sessions: 4,
          best: { weightKg: 80, reps: 5, e1rmKg: 93 },
          lastTopSets: [{ date: '2026-09-21', weightKg: 80, reps: 5, rpe: 8 }],
          trend: 'flat',
          trendPct: 0,
          prInRange: false,
        },
      ];
    });

    const { sent, server } = build(sources);

    expect(sent.signals.sessions.map((s) => [s.workoutRef, s.status])).toEqual([
      ['W3-1', 'done'],
      [null, 'missed'],
    ]);
    expect(sent.signals.pain).toEqual([{ key: 'back_squat', lastFlaggedOn: '2026-09-21', flaggedSessions28d: 1, consecutiveFlaggedSessions: 2 }]);
    expect(sent.signals.performance[0]).toMatchObject({ key: 'bench_press', sessions: 4, trend: 'flat' });
    expect(sent.signals.performance[0]).not.toHaveProperty('exerciseId');
    expect(sent.signals.performance[0]).not.toHaveProperty('name');
    expect(server.pain).toEqual([expect.objectContaining({ exerciseId: EVAL_EXERCISES.squat.id, key: 'back_squat' })]);
  });

  it('shows the last change log entries with the person\'s feedback', () => {
    const { sent } = build();

    expect(sent.history.map((h) => [h.date, h.status, h.feedback, h.operations])).toEqual([
      ['2026-09-20', 'reverted', 'undone', 1],
      ['2026-09-15', 'rejected', 'declined', 2],
      ['2026-09-10', 'expired', 'expired', 0],
      ['2026-09-06', 'applied', null, 0],
    ]);
  });

  it('keeps at most 10 history entries', () => {
    const sources = evaluationSources();
    sources.changeLog = Array.from({ length: 14 }, (_, i) => ({ ...sources.changeLog[0], summary: `s${i}` }));
    expect(build(sources).sent.history).toHaveLength(10);
  });

  it('sends the stored evidence claims by id (the newest brief that parses)', () => {
    expect(build().sent.evidence.map((c) => c.id)).toEqual(['E1', 'E2', 'E3']);
    expect(build(evaluationSources({ evidence: [] })).sent.evidence).toEqual([]);
  });

  it('digests the intake: goal, level, days, minutes, limitations, avoid list, conservative flag; nothing else', () => {
    const { profile } = build().sent;

    expect(profile).toEqual({
      goal: { type: 'hypertrophy', description: 'Build muscle and get stronger' },
      experience: 'intermediate',
      daysPerWeek: 3,
      preferredWeekdays: null,
      minutesPerSession: 60,
      limitations: [{ area: 'knee', description: 'Old knee sprain' }],
      avoidExerciseKeys: ['jump_squat'],
      conservative: true,
      alreadyDecided: [],
    });
  });

  it('falls back to the plan\'s goal when it has no intake (a manual plan)', () => {
    const sources = evaluationSources();
    sources.program.intake = null;

    expect(build(sources).sent.profile).toMatchObject({ goal: { type: 'hypertrophy', description: '' }, experience: null, conservative: false });
  });

  it('carries the run facts and the server facts', () => {
    const sources = evaluationSources();
    sources.program.autonomyPausedReason = 'user_paused';
    sources.program.autonomy = 'ask_first';
    sources.signals = evaluationSignals((s) => {
      s.readiness.lowStreak = 4;
    });

    const context = build(sources, { trigger: 'weekly', deep: true });

    expect(context.sent.run).toEqual({ trigger: 'weekly', deep: true, recover: false, paused: true });
    expect(context.server).toMatchObject({
      programId: sources.program.id,
      planVersion: 3,
      autonomy: 'ask_first',
      autonomyPausedReason: 'user_paused',
      asOf: EVAL_AS_OF,
      readinessLowStreak: 4,
    });
    expect(context.safety).toBeNull();
    expect(evaluateContextOf({ context })).toBe(context);
    expect(evaluateContextOf({ context: { stub: true } })).toBeNull();
  });

  describe('never sends (canary)', () => {
    function loaded() {
      const sources = evaluationSources();
      sources.signals = evaluationSignals((s) => {
        s.pain = [painRow('squat')];
        s.sessions = [
          { programWorkoutId: sources.tree.blocks[0].weeks[0].workouts[0].id!, name: CANARY.workoutName, plannedFor: '2026-09-07', status: 'done', workoutId: sources.tree.blocks[0].weeks[0].workouts[0].id!, setsPlanned: 6, setsDone: 6, completionPct: 100, avgRpe: 8 },
        ];
      });
      return build(sources);
    }

    it.each(Object.entries(CANARY))('no %s', (_field, canary) => {
      expect(JSON.stringify(loaded().sent)).not.toContain(canary);
    });

    it('no uuid of any row', () => {
      expect(JSON.stringify(loaded().sent)).not.toMatch(UUID);
    });

    it('the "what will be sent" panel renders the same object, one section per key, and lists the exclusions', () => {
      const context = loaded();
      const summary = summarizeEvaluatorContext(context.sent);

      expect(summary.sections.map((s) => s.key)).toEqual([...EVALUATOR_CONTEXT_KEYS]);
      expect(Object.keys(context.sent).sort()).toEqual([...EVALUATOR_CONTEXT_KEYS].sort());
      expect(summary.excluded).toEqual([...NEVER_SEND_LABELS]);
      const text = JSON.stringify(summary);
      for (const canary of Object.values(CANARY)) expect(text).not.toContain(canary);
      expect(text).not.toMatch(UUID);
    });
  });

  describe('the opt-in health summary in the profile digest (H8, #192)', () => {
    it('absent: no key, and the sent input is unchanged', () => {
      const without = build();
      const withNull = build({ ...evaluationSources(), healthSummary: null });

      expect('healthSummary' in without.sent.profile).toBe(false);
      expect(JSON.stringify(withNull.sent)).toBe(JSON.stringify(without.sent));
    });

    it('present: the stored text verbatim in sent.profile, conservative from a flagged consideration, and shown in the panel', () => {
      const plain = { ...HEALTH_SUMMARY_FIXTURE, trainingConsiderations: [{ text: 'Fine.', severity: 'info' as const, conservative: false }] };
      expect(build({ ...evaluationSources(), healthSummary: plain }).sent.profile.healthSummary).toEqual(plain);

      const context = build({ ...evaluationSources(), healthSummary: { ...HEALTH_SUMMARY_FIXTURE, inputsHash: 'CANARY-HASH' } as never });

      expect(context.sent.profile.healthSummary).toEqual(HEALTH_SUMMARY_FIXTURE);
      expect(context.sent.profile.conservative).toBe(true);
      expect(JSON.stringify(context.sent)).not.toContain('CANARY-HASH');
      const profile = summarizeEvaluatorContext(context.sent).sections.find((section) => section.key === 'profile')!;
      expect(profile.items).toEqual(expect.arrayContaining([HEALTH_SUMMARY_FIXTURE.narrative]));
    });

    it('a summary naming an urgent symptom is not sent', () => {
      const context = build({ ...evaluationSources(), healthSummary: { ...HEALTH_SUMMARY_FIXTURE, narrative: 'Fainting after sessions.' } });

      expect(context.sent.profile.healthSummary).toBeUndefined();
    });
  });
});
