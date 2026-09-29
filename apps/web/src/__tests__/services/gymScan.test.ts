/**
 * `services/gymScan.ts` (E3.4): resume-or-create, the apply summary, the
 * failed-batch range, the defensive `resultMeta` read.
 */
import { describe, expect, it } from 'vitest';
import {
  applySummary,
  failedChunkRange,
  formatElapsed,
  humanizeSlug,
  scanResultMeta,
  startOrResumeGymScan,
} from '../../services/gymScan';
import { mockScanIntake, statefulIntakeApi } from '../mocks/fixtures/intakes';

const GYM = '00000000-0000-4000-8000-a00000000555';

describe('gymScan service', () => {
  it('resumes the newest unfinished scan of the gym', async () => {
    const older = mockScanIntake(GYM, { status: 'ready' });
    const newer = mockScanIntake(GYM, { status: 'draft' });
    const api = statefulIntakeApi([mockScanIntake(GYM, { status: 'applied' }), older, newer]);
    await expect(startOrResumeGymScan(GYM)).resolves.toBe(newer.id);
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('creates a scan when none is open', async () => {
    const api = statefulIntakeApi([mockScanIntake(GYM, { status: 'applied' })]);
    const id = await startOrResumeGymScan(GYM);
    expect(api.intakes.at(-1)?.id).toBe(id);
    expect(api.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/intakes',
      body: { kind: 'gym_equipment', context: { gymId: GYM }, subjectType: 'gym', subjectId: GYM },
    });
  });

  it('summarizes an apply', () => {
    expect(applySummary({ created: 3, merged: 1, photosAttached: 2 })).toBe(
      '3 added, 1 already there. Photos saved to this gym.',
    );
    expect(applySummary({ created: 0, merged: 0, photosAttached: 0 })).toBe('0 added.');
    expect(applySummary({ created: 1, merged: 0, photosAttached: 1, photosSkipped: 2 })).toBe(
      '1 added. Photos saved to this gym. 2 photos were not saved: the gym is full.',
    );
  });

  it('names the photos of a failed batch', () => {
    expect(failedChunkRange({ index: 1, code: 'X', firstPhotoIndex: 16, lastPhotoIndex: 19 }, 20)).toBe('Photos 17-20');
    expect(failedChunkRange({ index: 1, code: 'X' }, 20)).toBe('Photos 17-20');
    expect(failedChunkRange({ index: 1, code: 'X' }, 17)).toBe('Photo 17');
    expect(failedChunkRange({ index: 2, code: 'X' }, 0)).toBe('Photos 33-48');
  });

  it('reads resultMeta defensively', () => {
    expect(scanResultMeta(null)).toEqual({});
    expect(scanResultMeta({ resultMeta: null })).toEqual({});
    const meta = scanResultMeta({
      resultMeta: { chunks: 2, photoCount: 20, ignoredObjects: ['mirror', 3], failedChunks: [{ index: 1, code: 'A' }, 'bad'] },
    });
    expect(meta.chunks).toBe(2);
    expect(meta.photoCount).toBe(20);
    expect(meta.ignoredObjects).toEqual(['mirror']);
    expect(meta.failedChunks).toEqual([{ index: 1, code: 'A' }]);
  });

  it('formats elapsed time and slugs', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65_400)).toBe('1:05');
    expect(humanizeSlug('leg_curl')).toBe('Leg curl');
    expect(humanizeSlug('low-impact_cardio')).toBe('Low impact cardio');
  });
});
