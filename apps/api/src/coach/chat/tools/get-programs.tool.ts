import { z } from 'zod';

import { defineTool } from '../../../ai/core/tools';
import { fromDbDate } from '../../../check-ins/local-date';
import { trainingIntakeSchema } from '../../../training-agents/contracts/training-intake.contract';
import type { CoachChatToolDeps } from './coach-chat-tool.types';
import { TOOL_UNAVAILABLE } from './coach-chat-tool.types';
import { forCoach, safely } from './minimise';
import { dropNulls, userText } from './user-context';

/** Changes, adaptations and runs `get_plan_history` returns by default, and at most. */
export const COACH_PLAN_HISTORY_DEFAULT = 50;
export const COACH_PLAN_HISTORY_MAX = 500;

/**
 * `get_programs` (#338): EVERY training plan the caller has had (active,
 * paused, completed, archived, drafts), newest first: name, goal, status,
 * source, start date, weeks, version, autonomy and any autonomy pause, the
 * gym name, the plan rationale and notes, the intake the user filled in,
 * and how many workouts were logged against it. Scoped by `userId`.
 */
export function createGetProgramsTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_programs',
    description:
      'Every training plan the user has had, newest first (active, paused, completed, archived and drafts): name, ' +
      'goal, status, source (ai or manual), startDate, totalWeeks, current version, autonomy (and why AI changes are ' +
      'paused, if they are), gym, the plan rationale and notes, the intake the user filled in (goal in their words, ' +
      'experience, days, session length, limitations, preferences), workouts logged and when it was created and ' +
      'last changed. Use get_plan_week with the plan name to see a past plan\'s sessions, get_plan_history for ' +
      'what changed and why.',
    parameters: z.object({}),
    execute: (_args, ctx) =>
      safely(async () => {
        const programs = await deps.prisma.program.findMany({
          where: { userId: ctx.userId },
          orderBy: [{ createdAt: 'desc' }],
          select: {
            name: true,
            goal: true,
            status: true,
            source: true,
            startDate: true,
            autonomy: true,
            autonomyPausedAt: true,
            autonomyPausedReason: true,
            currentVersion: true,
            rationale: true,
            notes: true,
            intake: true,
            createdAt: true,
            updatedAt: true,
            lastEvaluatedAt: true,
            gym: { select: { name: true } },
            weeks: { where: { archivedAt: null }, select: { weekNumber: true } },
            _count: { select: { sessions: true } },
          },
        });
        return {
          count: programs.length,
          programs: programs.map((program) => {
            const parsed = trainingIntakeSchema.safeParse(program.intake);
            const weeks = program.weeks.map((week) => week.weekNumber);
            return dropNulls({
              name: program.name,
              goal: program.goal,
              status: program.status,
              source: program.source,
              startDate: program.startDate ? fromDbDate(program.startDate) : null,
              totalWeeks: weeks.length ? Math.max(...weeks) : null,
              version: program.currentVersion,
              autonomy: program.autonomy,
              autonomyPaused: program.autonomyPausedAt
                ? { since: program.autonomyPausedAt.toISOString(), reason: program.autonomyPausedReason }
                : null,
              gym: userText(program.gym?.name ?? null, 80),
              rationale: userText(program.rationale, 4000),
              notes: userText(program.notes),
              intake: parsed.success ? forCoach(parsed.data) : null,
              workoutsLogged: program._count.sessions,
              createdAt: program.createdAt.toISOString(),
              updatedAt: program.updatedAt.toISOString(),
              lastEvaluatedAt: program.lastEvaluatedAt?.toISOString() ?? null,
            });
          }),
        };
      }, TOOL_UNAVAILABLE),
  });
}

/**
 * `get_plan_history` (#338): how the caller's plans came to be and changed,
 * newest first: the plan change log (kind, who changed it, status, versions,
 * summary, rationale, operations, citations), the plan versions (origin and
 * rationale), quick workout adaptations (what the user asked for, the
 * proposal, whether and how it was applied) and AI plan runs (create,
 * revise, evaluate: trigger, status, input, result). JSON payloads lose
 * their ids and any secret or storage key (`forCoach`); never a model's key, usage or raw context.
 */
export function createGetPlanHistoryTool(deps: CoachChatToolDeps) {
  return defineTool({
    name: 'get_plan_history',
    description:
      "The history of the user's training plans, newest first: changes (created, adapted, edited, reverted, " +
      'reviewed; by ai, user or system; applied, proposed, rejected...; from and to version; summary and rationale ' +
      'of why; the operations), versions (origin and rationale), quick workout adaptations (the user\'s request, ' +
      'the proposal, status, applied as one-off or plan change) and AI plan runs (kind, trigger, status, the ' +
      `request, the result). limit is 1 to ${COACH_PLAN_HISTORY_MAX} per list, or null for ${COACH_PLAN_HISTORY_DEFAULT}. ` +
      'Call it when the user asks why the plan changed or what was adjusted.',
    parameters: z.object({
      limit: z.number().int().nullable().default(null).describe(`Entries per list, 1 to ${COACH_PLAN_HISTORY_MAX}, or null.`),
    }),
    execute: (args, ctx) =>
      safely(async () => {
        const take = Math.min(Math.max(args.limit ?? COACH_PLAN_HISTORY_DEFAULT, 1), COACH_PLAN_HISTORY_MAX);
        const [changes, versions, adaptations, runs] = await Promise.all([
          deps.prisma.programChangeLog.findMany({
            where: { userId: ctx.userId },
            orderBy: [{ createdAt: 'desc' }],
            take,
            select: {
              kind: true,
              actor: true,
              status: true,
              fromVersion: true,
              toVersion: true,
              summary: true,
              rationale: true,
              operations: true,
              citations: true,
              createdAt: true,
              decidedAt: true,
              program: { select: { name: true } },
            },
          }),
          deps.prisma.programVersion.findMany({
            where: { program: { userId: ctx.userId } },
            orderBy: [{ createdAt: 'desc' }],
            take,
            select: { versionNumber: true, origin: true, rationale: true, createdAt: true, program: { select: { name: true } } },
          }),
          deps.prisma.workoutAdaptation.findMany({
            where: { userId: ctx.userId },
            orderBy: [{ createdAt: 'desc' }],
            take,
            select: {
              status: true,
              request: true,
              proposal: true,
              safety: true,
              appliedAs: true,
              appliedAt: true,
              errorCode: true,
              createdAt: true,
              gym: { select: { name: true } },
            },
          }),
          deps.prisma.trainingPlanRun.findMany({
            where: { userId: ctx.userId },
            orderBy: [{ createdAt: 'desc' }],
            take,
            select: { kind: true, trigger: true, status: true, input: true, result: true, errorCode: true, createdAt: true, completedAt: true },
          }),
        ]);
        return {
          changes: changes.map((row) =>
            dropNulls({
              at: row.createdAt.toISOString(),
              plan: row.program.name,
              kind: row.kind,
              by: row.actor,
              status: row.status,
              fromVersion: row.fromVersion,
              toVersion: row.toVersion,
              summary: userText(row.summary),
              rationale: userText(row.rationale, 4000),
              operations: forCoach(row.operations),
              citations: forCoach(row.citations),
              decidedAt: row.decidedAt?.toISOString() ?? null,
            }),
          ),
          versions: versions.map((row) =>
            dropNulls({
              at: row.createdAt.toISOString(),
              plan: row.program.name,
              version: row.versionNumber,
              origin: row.origin,
              rationale: userText(row.rationale, 4000),
            }),
          ),
          adaptations: adaptations.map((row) =>
            dropNulls({
              at: row.createdAt.toISOString(),
              status: row.status,
              gym: userText(row.gym?.name ?? null, 80),
              request: forCoach(row.request),
              proposal: row.proposal ? forCoach(row.proposal) : null,
              safety: forCoach(row.safety),
              appliedAs: row.appliedAs,
              appliedAt: row.appliedAt?.toISOString() ?? null,
              errorCode: row.errorCode,
            }),
          ),
          planRuns: runs.map((row) =>
            dropNulls({
              at: row.createdAt.toISOString(),
              kind: row.kind,
              trigger: row.trigger,
              status: row.status,
              request: forCoach(row.input),
              result: row.result ? forCoach(row.result) : null,
              errorCode: row.errorCode,
              completedAt: row.completedAt?.toISOString() ?? null,
            }),
          ),
        };
      }, TOOL_UNAVAILABLE),
  });
}
