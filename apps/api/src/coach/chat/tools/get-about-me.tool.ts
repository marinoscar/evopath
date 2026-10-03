import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import { addDays, fromDbDate, toDbDate } from '../../../check-ins/local-date';
import { resolveCoachUserSettings, type CoachSettingsValue } from '../../../common/schemas/user-settings-namespaces.schema';
import { findCoachPersona } from '../../personas';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { goalView, COACH_CHAT_GOALS_MAX } from './get-goals.tool';
import { planNow, readToday } from './get-now.tool';
import { readProfile } from './get-profile.tool';
import { readTrainingProfile } from './get-training-profile.tool';
import { safely } from './minimise';
import { localTimeOf, userText, weekdayOf } from './user-context';

/** Settles to null instead of rejecting: one failed part never sinks the overview. */
async function orNull<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch {
    return null;
  }
}

/** The coach settings the user chose: why, preferred time, persona and reminders. */
async function readCoachSettings(deps: CoachChatToolDeps, userId: string) {
  const [settings, state] = await Promise.all([
    deps.profile ? deps.profile.userSettings.getSettings(userId) : Promise.resolve(null),
    deps.prisma.coachState.findUnique({ where: { userId }, select: { pausedUntil: true, weeklyStreak: true } }),
  ]);
  const coach = resolveCoachUserSettings((settings?.coach ?? undefined) as CoachSettingsValue | undefined);
  const persona = findCoachPersona(coach.personaId);
  const pausedUntil = state?.pausedUntil && state.pausedUntil > deps.now() ? state.pausedUntil.toISOString() : null;
  return {
    why: userText(coach.why),
    preferredTime: coach.preferredTime ?? null,
    persona: persona ? persona.name : coach.personaId,
    intensity: coach.intensity,
    remindersEnabled: coach.enabled,
    maxNudgesPerDay: coach.maxNudgesPerDay,
    quietHours: coach.quietHours,
    pausedUntil,
    weeklyStreak: state?.weeklyStreak ?? 0,
  };
}

/**
 * `get_about_me` (#338): everything that matters about the user in one call,
 * so "what's my goal?" or "how is my week going?" needs no chain of tools.
 * Each part is the same read its own tool makes (`get_profile`,
 * `get_training_profile`, `get_goals`, `get_now`), plus the coach settings
 * (why, preferred time, persona) and the last 7 days' completed workouts.
 * A part that fails to load is null; the rest still answers.
 */
export function createGetAboutMeTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_about_me',
    description:
      'One-call overview of the user: now (local date, weekday, time, time zone), profile (name, age, sex, height, ' +
      'units, bio, latest weight and body metrics), training (the goal in their own words, the active plan: name, ' +
      'status, start date, week N of M, rationale, and the intake: experience, days, session length, limitations, ' +
      'exercises to avoid, preferences, equipment), plan today and this week (each session with date and status), ' +
      'activity goals with progress, coach settings (their why, preferred training time, persona, reminders, ' +
      'pause) and the workouts completed in the last 7 days. Call it FIRST when the user asks about themselves, ' +
      'their goal, their plan or how they are doing; then a specific tool for more detail.',
    parameters: z.object({}),
    execute: (_args, ctx) =>
      safely(async () => {
        const now = deps.now();
        const date = await deps.checkIns.today(ctx.userId, now);
        const [profile, training, today, goals, coach, recent] = await Promise.all([
          orNull(readProfile(deps, ctx.userId)),
          orNull(readTrainingProfile(deps, ctx.userId)),
          readToday(deps, ctx.userId, date),
          deps.goals ? orNull(deps.goals.progressForUser(ctx.userId, undefined, now)) : Promise.resolve(null),
          orNull(readCoachSettings(deps, ctx.userId)),
          orNull(
            deps.prisma.workout.findMany({
              where: { userId: ctx.userId, status: 'completed', date: { gte: toDbDate(addDays(date, -6)), lte: toDbDate(date) } },
              orderBy: [{ date: 'desc' }, { startedAt: 'desc' }],
              take: 14,
              select: { id: true, date: true, name: true, durationSeconds: true },
            }),
          ),
        ]);
        const profileOk = profile && !('error' in profile) ? profile : null;
        const timeZone = profileOk?.timeZone ?? null;
        const week =
          today && (today.kind === 'workout' || today.kind === 'rest_day')
            ? today.week.map((session) => ({
                date: session.date,
                weekday: weekdayOf(session.date),
                workout: session.programWorkout.name,
                status: session.status,
                workoutId: session.completedWorkoutId ?? session.inProgressWorkoutId ?? null,
              }))
            : null;

        return {
          now: {
            localDate: date,
            weekday: weekdayOf(date),
            localTime: localTimeOf(now, timeZone),
            timeZone: timeZone ?? 'UTC',
          },
          profile: profileOk,
          training,
          plan: { today: planNow(today), thisWeek: week },
          activityGoals: goals ? goals.slice(0, COACH_CHAT_GOALS_MAX).map(goalView) : null,
          coach,
          last7Days: recent
            ? {
                completedWorkouts: recent.length,
                workouts: recent.map((row) => {
                  const day = fromDbDate(row.date);
                  return {
                    workoutId: row.id,
                    date: day,
                    weekday: weekdayOf(day),
                    name: row.name,
                    durationMinutes: row.durationSeconds === null ? null : Math.round(row.durationSeconds / 60),
                  };
                }),
              }
            : null,
        };
      }, TOOL_UNAVAILABLE),
  });
}
