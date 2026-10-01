import { updateWeeklyStreak, type WeeklyStreakChange } from './weekly-streak';

// =============================================================================
// The weekly streak and passes, as a table (E7.10 AC 9 to 11; spec §2.11)
// =============================================================================

describe('updateWeeklyStreak', () => {
  it.each<[string, [number, number], { completed: number; target: number; protectedWeek: boolean }, [number, number], WeeklyStreakChange, boolean]>([
    // label,                              before [streak, passes], week,                                         after,  change,       earned
    ['hit: +1', [2, 0], { completed: 3, target: 3, protectedWeek: false }, [3, 0], 'advanced', false],
    ['hit above target: +1', [0, 0], { completed: 5, target: 3, protectedWeek: false }, [1, 0], 'advanced', false],
    ['hit on the 4th week: pass granted', [3, 0], { completed: 3, target: 3, protectedWeek: false }, [4, 1], 'advanced', true],
    ['hit on the 8th week: still at most 1 pass', [7, 1], { completed: 3, target: 3, protectedWeek: false }, [8, 1], 'advanced', false],
    ['hit on the 5th week: no new pass', [4, 0], { completed: 3, target: 3, protectedWeek: false }, [5, 0], 'advanced', false],
    ['miss with a pass: streak holds, pass used', [6, 1], { completed: 1, target: 3, protectedWeek: false }, [6, 0], 'pass_used', false],
    ['miss without a pass: reset', [6, 0], { completed: 2, target: 3, protectedWeek: false }, [0, 0], 'reset', false],
    ['miss from zero: still zero', [0, 0], { completed: 0, target: 2, protectedWeek: false }, [0, 0], 'reset', false],
    ['vacation pause (protected): unchanged', [6, 0], { completed: 0, target: 3, protectedWeek: true }, [6, 0], 'held', false],
    ['safety-protected hit: unchanged', [6, 1], { completed: 3, target: 3, protectedWeek: true }, [6, 1], 'held', false],
    ['no-plan week: unchanged', [6, 1], { completed: 0, target: 0, protectedWeek: false }, [6, 1], 'held', false],
    ['no-plan week with extra workouts: unchanged', [2, 0], { completed: 0, target: 0, protectedWeek: false }, [2, 0], 'held', false],
  ])('%s', (_label, [streak, passes], week, [afterStreak, afterPasses], change, earned) => {
    expect(updateWeeklyStreak({ weeklyStreak: streak, streakPassesLeft: passes }, week)).toEqual({
      weeklyStreak: afterStreak,
      streakPassesLeft: afterPasses,
      change,
      passEarned: earned,
    });
  });

  it('a pass is earned again after it was used, every 4 weeks of streak', () => {
    let state = { weeklyStreak: 0, streakPassesLeft: 0 };
    const hit = { completed: 3, target: 3, protectedWeek: false };
    const miss = { completed: 0, target: 3, protectedWeek: false };
    for (let i = 0; i < 4; i += 1) state = updateWeeklyStreak(state, hit);
    expect(state).toMatchObject({ weeklyStreak: 4, streakPassesLeft: 1 });
    state = updateWeeklyStreak(state, miss);
    expect(state).toMatchObject({ weeklyStreak: 4, streakPassesLeft: 0, change: 'pass_used' });
    for (let i = 0; i < 4; i += 1) state = updateWeeklyStreak(state, hit);
    expect(state).toMatchObject({ weeklyStreak: 8, streakPassesLeft: 1 });
  });
});
