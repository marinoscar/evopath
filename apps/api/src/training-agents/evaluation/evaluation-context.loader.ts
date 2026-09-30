import { Injectable } from '@nestjs/common';

import { fromDbDate, toDbDate } from '../../check-ins/local-date';
import { liveTreeOf } from '../../programs/plan-diff';
import { loadProgramRows } from '../../programs/program-mapper';
import {
  ProgramsService,
  type RecordReviewInput,
  type RecordReviewResult,
} from '../../programs/programs.service';
import { TrainingSignalsService } from '../../programs/signals/signals.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { EvaluationPort } from '../graph/node-context';
import { EVALUATOR_HISTORY_ENTRIES, type EvaluationSources } from './build-evaluator-context';

/** How many recent AI versions are searched for the stored evidence brief. */
const EVIDENCE_VERSIONS = 5;
/** A bound on the pain notes screened per run (the screen needs only one hit). */
const PAIN_NOTES_MAX = 500;

/**
 * The `evaluation` node port: the evaluate graph's reads (owner-scoped) and
 * its one write outside `applyChange` (a `reviewed` entry, through the
 * `ProgramsService` chokepoint). Bound per job by the run handler.
 *
 * `recentPainNotes` returns the notes' TEXT for the server-side screen only:
 * the caller (`safety_gate`) keeps nothing but the screen's rule codes.
 */
@Injectable()
export class EvaluationContextLoader implements EvaluationPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signals: TrainingSignalsService,
    private readonly programs: ProgramsService,
  ) {}

  async loadSources(userId: string, programId: string, now: Date): Promise<EvaluationSources | null> {
    const program = await this.prisma.program.findFirst({
      where: { id: programId, userId },
      select: {
        id: true,
        goal: true,
        autonomy: true,
        autonomyPausedReason: true,
        startDate: true,
        currentVersion: true,
        intake: true,
      },
    });
    if (!program) return null;

    const [rows, signals, sessions, changeLog, versions] = await Promise.all([
      loadProgramRows(this.prisma, programId),
      this.signals.forEvaluator(userId, programId, now),
      this.prisma.programSession.findMany({
        where: { programId, userId, programWorkoutId: { not: null } },
        select: { programWorkoutId: true },
      }),
      this.prisma.programChangeLog.findMany({
        where: { programId, userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: EVALUATOR_HISTORY_ENTRIES,
        select: { createdAt: true, kind: true, actor: true, status: true, summary: true, operations: true },
      }),
      this.prisma.programVersion.findMany({
        where: { programId, origin: { in: ['ai_create', 'ai_adapt'] } },
        orderBy: { versionNumber: 'desc' },
        take: EVIDENCE_VERSIONS,
        select: { evidence: true },
      }),
    ]);
    const tree = liveTreeOf(rows);

    const exerciseIds = new Set<string>([
      ...tree.blocks.flatMap((b) => b.weeks.flatMap((w) => w.workouts.flatMap((o) => o.exercises.map((e) => e.exerciseId)))),
      ...signals.pain.map((row) => row.exerciseId),
      ...signals.performance.map((row) => row.exerciseId),
    ]);
    const exercises = exerciseIds.size
      ? await this.prisma.exercise.findMany({ where: { id: { in: [...exerciseIds] } }, select: { id: true, slug: true } })
      : [];

    return {
      program: {
        id: program.id,
        goal: program.goal,
        autonomy: program.autonomy,
        autonomyPausedReason: program.autonomyPausedReason,
        startDate: program.startDate ? fromDbDate(program.startDate) : null,
        currentVersion: program.currentVersion,
        intake: program.intake,
      },
      tree,
      exercises: exercises.map((row) => ({ id: row.id, key: row.slug })),
      linkedProgramWorkoutIds: sessions.flatMap((row) => (row.programWorkoutId ? [row.programWorkoutId] : [])),
      signals,
      changeLog,
      evidence: versions.map((row) => row.evidence),
    };
  }

  async recentPainNotes(userId: string, fromDate: string, toDate: string): Promise<string[]> {
    const rows = await this.prisma.setLog.findMany({
      where: {
        painNote: { not: null },
        workoutExercise: { workout: { userId, date: { gte: toDbDate(fromDate), lte: toDbDate(toDate) } } },
      },
      select: { painNote: true },
      take: PAIN_NOTES_MAX,
    });
    return rows.flatMap((row) => (row.painNote ? [row.painNote] : []));
  }

  recordReview(input: RecordReviewInput): Promise<RecordReviewResult> {
    return this.programs.recordReview(input);
  }

  async findRunReview(userId: string, runId: string, actor: 'ai' | 'system'): Promise<{ changeLogId: string } | null> {
    const row = await this.prisma.programChangeLog.findFirst({
      where: { userId, runId, kind: 'reviewed', actor },
      select: { id: true },
    });
    return row ? { changeLogId: row.id } : null;
  }
}
