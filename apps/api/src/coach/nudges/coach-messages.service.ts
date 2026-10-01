import { Injectable, Logger, Optional } from '@nestjs/common';

import { AppMetricsService, fallbackAppMetrics } from '../../common/otel/app-metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { coachMessageNotFoundError } from '../coach-errors';
import { conversionCandidateWhere, type CoachConversionTarget } from './coach-conversion';

// =============================================================================
// Coach message engagement: opened, feedback, conversion (E7.5, #245)
// =============================================================================
//
// docs/specs/ai-coach.md §2.7 and §2.8. Every read and write is scoped to the
// caller's own messages (`userId` from the access token): an unknown id and
// another user's id are the same 404 `COACH_MESSAGE_NOT_FOUND`.
//
// Each operation is a bounded write (one or two rows), so the conversion
// listener may call `recordConversion` directly from an `@OnEvent` body.
// =============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CoachFeedbackValue = 'up' | 'down' | null;

@Injectable()
export class CoachMessagesService {
  private readonly logger = new Logger(CoachMessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly metrics: AppMetricsService = fallbackAppMetrics(),
  ) {}

  /**
   * Marks the caller's message opened: `openedAt` is set ONCE (a second call
   * keeps the first time). Any open is re-engagement: `consecutiveIgnored`
   * resets to 0 and `silencedAt` clears (spec §2.5 auto-silence).
   */
  async markOpened(userId: string, messageId: string, now: Date = new Date()): Promise<void> {
    const message = await this.owned(userId, messageId);

    if (!message.openedAt) {
      const first = await this.prisma.coachMessage.updateMany({
        where: { id: message.id, userId, openedAt: null },
        data: { openedAt: now },
      });
      if (first.count > 0) this.metrics.coachNudgeOpen(message.moment);
    }

    await this.prisma.coachState.updateMany({
      where: { userId },
      data: { consecutiveIgnored: 0, silencedAt: null },
    });
  }

  /** Stores thumbs up or down on the caller's message; `null` clears it. */
  async setFeedback(userId: string, messageId: string, feedback: CoachFeedbackValue): Promise<void> {
    const message = await this.owned(userId, messageId);
    await this.prisma.coachMessage.updateMany({ where: { id: message.id, userId }, data: { feedback } });
    this.metrics.coachFeedbackGiven(feedback);
  }

  /**
   * Attributes a target action at `at` to the latest delivered, unconverted
   * coach message inside its window (spec §2.8). Returns the converted
   * message id, or null when nothing qualifies. Two bounded queries.
   */
  async recordConversion(userId: string, target: CoachConversionTarget, at: Date = new Date()): Promise<string | null> {
    const candidate = await this.prisma.coachMessage.findFirst({
      where: conversionCandidateWhere(userId, target, at),
      orderBy: { deliveredAt: 'desc' },
      select: { id: true, moment: true },
    });
    if (!candidate) return null;

    const converted = await this.prisma.coachMessage.updateMany({
      where: { id: candidate.id, convertedAt: null },
      data: { convertedAt: at },
    });
    if (converted.count === 0) return null;

    this.metrics.coachNudgeConversion(candidate.moment, target);
    this.logger.log(`Coach message ${candidate.id} converted by ${target}`);
    return candidate.id;
  }

  private async owned(userId: string, messageId: string): Promise<{ id: string; moment: string | null; openedAt: Date | null }> {
    if (!UUID.test(messageId)) throw coachMessageNotFoundError();
    const message = await this.prisma.coachMessage.findFirst({
      where: { id: messageId, userId, role: 'coach' },
      select: { id: true, moment: true, openedAt: true },
    });
    if (!message) throw coachMessageNotFoundError();
    return message;
  }
}
