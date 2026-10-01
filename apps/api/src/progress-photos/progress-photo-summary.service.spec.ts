import { ProgressPhotoSummaryService } from './progress-photo-summary.service';

// =============================================================================
// ProgressPhotoSummaryService (E7.9, #249): counts and dates, nothing else
// =============================================================================
//
// The canary: the summary is what the coach may read, so it must never carry
// an id, a storage object id, a URL, a note or a byte. The query selects none
// of them, and the output is scanned for the seeded values anyway.
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const CANARY_OBJECT = 'cafecafe-cafe-4afe-8afe-cafecafecafe';
const CANARY_NOTE = 'CANARY-NOTE-do-not-leak';

describe('ProgressPhotoSummaryService', () => {
  function serviceWith(groups: unknown[]) {
    const prisma = { progressPhoto: { groupBy: jest.fn().mockResolvedValue(groups) } };
    return { prisma, service: new ProgressPhotoSummaryService(prisma as never) };
  }

  it('sums counts per pose and finds the latest day', async () => {
    const { prisma, service } = serviceWith([
      { pose: 'front', _count: { _all: 3 }, _max: { localDate: new Date('2026-09-20T00:00:00Z') } },
      { pose: 'side', _count: { _all: 1 }, _max: { localDate: new Date('2026-09-28T00:00:00Z') } },
      { pose: 'legacy', _count: { _all: 2 }, _max: { localDate: new Date('2026-08-01T00:00:00Z') } },
    ]);

    await expect(service.summarize(USER)).resolves.toEqual({
      count: 6,
      lastLocalDate: '2026-09-28',
      byPose: { front: 3, side: 1, back: 0, other: 2 },
    });
    expect(prisma.progressPhoto.groupBy).toHaveBeenCalledWith({
      by: ['pose'],
      where: { userId: USER },
      _count: { _all: true },
      _max: { localDate: true },
    });
  });

  it('answers zeros and a null date for a user with no photos', async () => {
    const { service } = serviceWith([]);
    await expect(service.summarize(USER)).resolves.toEqual({
      count: 0,
      lastLocalDate: null,
      byPose: { front: 0, side: 0, back: 0, other: 0 },
    });
  });

  it('never selects or returns a storage id, URL, note or image field (canary)', async () => {
    // A misbehaving client returning extra fields must not leak them either.
    const { prisma, service } = serviceWith([
      {
        pose: 'front',
        storageObjectId: CANARY_OBJECT,
        note: CANARY_NOTE,
        _count: { _all: 1 },
        _max: { localDate: new Date('2026-09-28T00:00:00Z') },
      },
    ]);

    const summary = await service.summarize(USER);
    const serialized = JSON.stringify(summary);

    expect(Object.keys(summary).sort()).toEqual(['byPose', 'count', 'lastLocalDate']);
    expect(serialized).not.toContain(CANARY_OBJECT);
    expect(serialized).not.toContain(CANARY_NOTE);
    expect(serialized).not.toMatch(/storage|url|https?:|note|thumb|base64|image/i);

    const query = JSON.stringify(prisma.progressPhoto.groupBy.mock.calls[0][0]);
    expect(query).not.toMatch(/storageObject|note|\bid\b/);
  });
});
