import { Injectable } from '@nestjs/common';

import { fromDbDate, toDbDate } from '../check-ins/local-date';
import { PrismaService } from '../prisma/prisma.service';
import { PROGRESS_PHOTO_POSES, type ProgressPhotoPose } from './progress-photos.constants';

// =============================================================================
// ProgressPhotoSummaryService — counts and dates only (E7.9, #249)
// =============================================================================
//
// THE ONLY progress-photo surface the coach may read: the photo-prompt cadence
// (E7.4 reads `lastLocalDate` against `coach.photoCadence`) and the chat tool
// `get_progress_photo_summary` (E7.7). It answers with counts and calendar
// days, never an id, a storage object id, a URL, a note or a byte: the query
// does not even select them, so nothing it returns can carry them into a
// prompt, a tool result or a notification.
//
// `test/coach/coach-photo-privacy.spec.ts` holds both halves: this file's
// select stays free of photo-content fields, and the coach, AI and
// notification code import nothing else from `progress-photos/`.
// =============================================================================

export interface ProgressPhotoSummary {
  /** How many progress photos the user has. */
  count: number;
  /** The newest photo's local calendar day (`YYYY-MM-DD`), or null with none. */
  lastLocalDate: string | null;
  /** Photos per pose, every pose present (0 when none). */
  byPose: Record<ProgressPhotoPose, number>;
}

@Injectable()
export class ProgressPhotoSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async summarize(userId: string): Promise<ProgressPhotoSummary> {
    const groups = await this.prisma.progressPhoto.groupBy({
      by: ['pose'],
      where: { userId },
      _count: { _all: true },
      _max: { localDate: true },
    });

    const byPose = Object.fromEntries(PROGRESS_PHOTO_POSES.map((pose) => [pose, 0])) as Record<
      ProgressPhotoPose,
      number
    >;
    let count = 0;
    let last: Date | null = null;

    for (const group of groups) {
      const n = group._count._all;
      const pose = (PROGRESS_PHOTO_POSES as readonly string[]).includes(group.pose)
        ? (group.pose as ProgressPhotoPose)
        : 'other';
      byPose[pose] += n;
      count += n;
      const max = group._max.localDate;
      if (max && (!last || max > last)) last = max;
    }

    return { count, lastLocalDate: last ? fromDbDate(last) : null, byPose };
  }

  /**
   * How many progress photos are dated (`localDate`) from `from` to `to`
   * inclusive (`YYYY-MM-DD`): the weekly review's "photos added" (E7.10). A
   * bare count; no row is selected.
   */
  async countInRange(userId: string, from: string, to: string): Promise<number> {
    return this.prisma.progressPhoto.count({
      where: { userId, localDate: { gte: toDbDate(from), lte: toDbDate(to) } },
    });
  }
}
