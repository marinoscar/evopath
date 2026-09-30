import { BadRequestException, Injectable } from '@nestjs/common';

import { CheckInsService } from '../../check-ins/check-ins.service';
import { addDays } from '../../check-ins/local-date';
import { PrismaService } from '../../prisma/prisma.service';
import { programNotFound } from '../programs.service';
import { daysFrom } from '../today/resolve-today';
import { aggregateSignals, weekStartOf } from './aggregate-signals';
import { compactSignals, type CompactOptions, type CompactSignals } from './compact-signals';
import {
  EVALUATOR_COMPLETE_WEEKS,
  SIGNALS_AS_OF_WINDOW_DAYS,
  SIGNALS_DEFAULT_WEEKS,
  SIGNALS_MAX_WEEKS,
  type PlanSignals,
} from './plan-signals.contract';
import { SignalsLoader, type SignalsProgram } from './signals.loader';

// =============================================================================
// TrainingSignalsService: plan signals for one user (E5.9)
// =============================================================================
//
// Compute on read: resolve the program (the caller's; another user's is a
// 404), settle the range, load a bounded row set and aggregate it. No AI and
// no queue: a fast query at personal scale.
//
//   forUser       the route: client-supplied `asOf` within 2 days of the
//                 server's today in the Health Profile zone, default range
//                 the last 8 weeks ending `asOf`.
//   forEvaluator  the agent: `asOf` is the server's today in the user's zone,
//                 the range is the last 6 complete weeks plus the current one.
// =============================================================================

/** `details.reason` values this feature answers with. */
export const SIGNALS_REASONS = {
  AS_OF_OUT_OF_RANGE: 'SIGNALS_AS_OF_OUT_OF_RANGE',
  RANGE_INVALID: 'SIGNALS_RANGE_INVALID',
} as const;

export interface SignalsRequest {
  programId?: string;
  from?: string;
  to?: string;
  asOf?: string;
}

@Injectable()
export class TrainingSignalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checkIns: CheckInsService,
    private readonly loader: SignalsLoader,
  ) {}

  /** The signals the route serves. 400 for a bad range or `asOf`; 404 for a program that is not the caller's. */
  async forUser(userId: string, request: SignalsRequest, now: Date = new Date()): Promise<PlanSignals> {
    const serverToday = await this.checkIns.today(userId, now);
    const asOf = request.asOf ?? serverToday;
    if (Math.abs(daysFrom(serverToday, asOf)) > SIGNALS_AS_OF_WINDOW_DAYS) {
      throw new BadRequestException({
        message: `asOf must be within ${SIGNALS_AS_OF_WINDOW_DAYS} days of today (${serverToday})`,
        details: { reason: SIGNALS_REASONS.AS_OF_OUT_OF_RANGE, path: 'asOf', today: serverToday },
      });
    }

    const to = request.to ?? asOf;
    const from = request.from ?? addDays(weekStartOf(to), -7 * (SIGNALS_DEFAULT_WEEKS - 1));
    assertRange(from, to);

    const program = await this.program(userId, request.programId);
    return this.compute(userId, program, { from, to, asOf });
  }

  /**
   * The evaluator's signals: the last 6 complete ISO weeks plus the current
   * one, as of the user's local today. 404 when the program is not the user's.
   */
  async forEvaluator(userId: string, programId: string, now: Date = new Date()): Promise<PlanSignals> {
    const asOf = await this.checkIns.today(userId, now);
    const from = addDays(weekStartOf(asOf), -7 * EVALUATOR_COMPLETE_WEEKS);
    const program = await this.program(userId, programId);
    return this.compute(userId, program, { from, to: asOf, asOf });
  }

  /** `forEvaluator` compacted for a prompt (`compactSignals`). */
  async compactForEvaluator(
    userId: string,
    programId: string,
    options: Partial<CompactOptions> = {},
    now: Date = new Date(),
  ): Promise<CompactSignals> {
    return compactSignals(await this.forEvaluator(userId, programId, now), options);
  }

  private async compute(
    userId: string,
    program: SignalsProgram | null,
    range: { from: string; to: string; asOf: string },
  ): Promise<PlanSignals> {
    const input = await this.loader.load(userId, { program, ...range });
    return aggregateSignals(input);
  }

  /** The caller's program by id (404 otherwise), or the active one (null when none). */
  private async program(userId: string, programId: string | undefined): Promise<SignalsProgram | null> {
    const select = { id: true, startDate: true, currentVersion: true } as const;
    if (programId) {
      const program = await this.prisma.program.findFirst({ where: { id: programId, userId }, select });
      if (!program) throw programNotFound();
      return program;
    }
    return this.prisma.program.findFirst({ where: { userId, status: 'active' }, select });
  }
}

function assertRange(from: string, to: string): void {
  const reject = (message: string) =>
    new BadRequestException({ message, details: { reason: SIGNALS_REASONS.RANGE_INVALID, path: 'from' } });
  if (from > to) throw reject('`from` must not be after `to`');
  if (daysFrom(from, to) + 1 > SIGNALS_MAX_WEEKS * 7) throw reject(`The range must be at most ${SIGNALS_MAX_WEEKS} weeks`);
}
