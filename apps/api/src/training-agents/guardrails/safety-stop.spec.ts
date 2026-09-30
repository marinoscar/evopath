import { TRAINING_SAFETY_STOP_BODIES } from '../../notifications/channels/browser-notification.channel';
import type { EvaluatorRef, ServerPainFact } from '../evaluation/evaluate-context';
import {
  FORCED_REMOVAL_REASON,
  SAFETY_COPY,
  forcedSafetyOperations,
  needsRecovery,
  painPattern,
} from './safety-stop';
import { screenFreeText } from './safety-screen';

const AS_OF = '2026-09-24';
const pain = (key: string, lastFlaggedOn: string, consecutive: number): ServerPainFact => ({
  exerciseId: `id-${key}`,
  key,
  lastFlaggedOn,
  flaggedSessions28d: consecutive,
  consecutiveFlaggedSessions: consecutive,
});

describe('painPattern', () => {
  it.each<[string, ServerPainFact[], boolean, string[], number]>([
    ['no pain', [], false, [], 0],
    ['one exercise, two sessions in a row', [pain('squat', '2026-09-21', 2)], false, [], 1],
    ['one exercise, three sessions in a row', [pain('squat', '2026-09-21', 3)], true, ['squat'], 1],
    ['three sessions in a row, flagged long ago, still counts', [pain('squat', '2026-09-01', 3)], true, ['squat'], 0],
    [
      'three different exercises within 14 days',
      [pain('squat', '2026-09-11', 1), pain('bench', '2026-09-20', 1), pain('row', '2026-09-24', 1)],
      true,
      ['bench', 'row', 'squat'],
      3,
    ],
    [
      'three different exercises, one of them 15 days ago',
      [pain('squat', '2026-09-10', 1), pain('bench', '2026-09-20', 1), pain('row', '2026-09-24', 1)],
      false,
      [],
      2,
    ],
  ])('%s', (_label, rows, triggered, keys, recent) => {
    expect(painPattern(rows, AS_OF)).toEqual({ triggered, exerciseKeys: keys, exercisesFlagged14d: recent });
  });
});

describe('forcedSafetyOperations', () => {
  const ref = (weekNumber: number, exerciseId: string, locked: boolean): EvaluatorRef => ({
    kind: 'exercise',
    weekNumber,
    programWorkoutId: 'w',
    programExerciseId: 'e',
    exerciseId,
    exerciseKey: 'k',
    date: null,
    locked,
  });
  const refs: Record<string, EvaluatorRef> = {
    'W10-1-1': ref(10, 'id-squat', false),
    'W3-1-1': ref(3, 'id-squat', true),
    'W4-1-1': ref(4, 'id-squat', false),
    'W4-2-3': ref(4, 'id-bench', false),
    'W4-1': { kind: 'workout', weekNumber: 4, programWorkoutId: 'w', date: null, locked: false },
  };

  it('removes every unlocked future occurrence of an exercise flagged twice in a row, in plan order', () => {
    expect(forcedSafetyOperations([pain('squat', AS_OF, 2), pain('bench', AS_OF, 1)], refs)).toEqual([
      { op: 'remove_exercise', target: { exerciseRef: 'W4-1-1', weeks: { from: 4, to: 4 } }, reason: FORCED_REMOVAL_REASON, forced: true },
      { op: 'remove_exercise', target: { exerciseRef: 'W10-1-1', weeks: { from: 10, to: 10 } }, reason: FORCED_REMOVAL_REASON, forced: true },
    ]);
  });

  it('forces nothing for a single flagged session', () => {
    expect(forcedSafetyOperations([pain('squat', AS_OF, 1)], refs)).toEqual([]);
  });
});

describe('needsRecovery', () => {
  it.each([
    [0, false],
    [4, false],
    [5, true],
    [9, true],
  ])('lowStreak %i -> %s', (streak, expected) => {
    expect(needsRecovery(streak)).toBe(expected);
  });
});

describe('the safety copy', () => {
  const all = [...SAFETY_COPY, ...Object.values(TRAINING_SAFETY_STOP_BODIES)];

  it('never tells anyone to push or train through pain', () => {
    for (const text of all) {
      expect(text.toLowerCase()).not.toMatch(/push(ing)? through|train(ing)? through|work(ing)? through|through the pain|no pain,? no gain/);
    }
  });

  it('recommends a qualified professional for a pain pattern, and seeking care for a red flag', () => {
    expect(SAFETY_COPY.some((text) => /qualified professional/i.test(text))).toBe(true);
    expect(SAFETY_COPY.some((text) => /medical care|emergency/i.test(text))).toBe(true);
  });

  it('keeps the notification bodies within 140 characters', () => {
    for (const body of Object.values(TRAINING_SAFETY_STOP_BODIES)) expect(body.length).toBeLessThanOrEqual(140);
  });

  it('the text screen blocks on an urgent symptom phrase in a pain note', () => {
    expect(screenFreeText(['sore after squats', 'chest pain and dizzy']).level).toBe('blocked');
    expect(screenFreeText(['a bit sore']).level).not.toBe('blocked');
  });
});
