import { readHealthExportResult } from './health-export.dto';

// `progress_photos` joined the datasets in E7.9 (#249): an export finished
// before it has no such row count, and must still read as a ready result.
describe('readHealthExportResult', () => {
  const result = {
    storageObjectId: '33333333-3333-4333-8333-333333333333',
    fileName: 'app-health-2026-09-01-2026-09-30.json',
    mimeType: 'application/json',
    sizeBytes: 389,
    completedAt: '2026-09-30T12:00:00.000Z',
    expiresAt: '2026-10-07T12:00:00.000Z',
  };
  const older = { profile: 0, body: 1, vitals: 0, labs: 0, wellness: 0, documents: 0 };

  it('reads a result written before progress photos existed, counting them as 0', () => {
    expect(readHealthExportResult({ result: { ...result, rowCounts: older } })?.rowCounts).toEqual({
      ...older,
      progress_photos: 0,
      memories: 0,
    });
  });

  // `memories` joined in #325: a result written before it reads as 0.
  it('reads a result written before memories existed, and the memory count of a newer one', () => {
    const before = { ...older, progress_photos: 2 };
    expect(readHealthExportResult({ result: { ...result, rowCounts: before } })?.rowCounts.memories).toBe(0);
    expect(readHealthExportResult({ result: { ...result, rowCounts: { ...before, memories: 3 } } })?.rowCounts.memories).toBe(3);
  });

  it('reads the progress photo count of a newer result', () => {
    const rowCounts = { ...older, progress_photos: 4 };
    expect(readHealthExportResult({ result: { ...result, rowCounts } })?.rowCounts.progress_photos).toBe(4);
  });
});
