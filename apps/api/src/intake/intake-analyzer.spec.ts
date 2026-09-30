import { buildPhotoContent, chunkPhotos, intakeInputPart, isPdfInput, numberedInputParts } from './intake-analyzer';

// =============================================================================
// Analyzer content parts (H2, #186): images as `image`, PDFs as `file`
// =============================================================================

const IMG = '11111111-1111-4111-8111-111111111111';
const PDF = '22222222-2222-4222-8222-222222222222';

describe('intake analyzer parts', () => {
  it('maps an image to a high-detail image part and a PDF to a file part (no filename, no URL)', () => {
    expect(intakeInputPart({ storageObjectId: IMG, mimeType: 'image/jpeg' })).toEqual({
      type: 'image',
      storageObjectId: IMG,
      detail: 'high',
    });
    expect(intakeInputPart({ storageObjectId: PDF, mimeType: 'application/pdf' })).toEqual({
      type: 'file',
      storageObjectId: PDF,
    });
    // A bare id, or an unknown type, is an image, as before H2.
    expect(intakeInputPart(IMG)).toEqual({ type: 'image', storageObjectId: IMG, detail: 'high' });
    expect(intakeInputPart({ storageObjectId: IMG })).toMatchObject({ type: 'image' });
    expect(isPdfInput({ storageObjectId: PDF, mimeType: 'Application/PDF' })).toBe(true);
  });

  it('labels each input, numbered from the given start, and marks a PDF', () => {
    const parts = numberedInputParts(
      [
        { storageObjectId: IMG, mimeType: 'image/png' },
        { storageObjectId: PDF, mimeType: 'application/pdf' },
      ],
      1,
    );

    expect(parts).toEqual([
      { type: 'text', text: 'Photo 1:' },
      { type: 'image', storageObjectId: IMG, detail: 'high' },
      { type: 'text', text: 'Photo 2 (PDF document):' },
      { type: 'file', storageObjectId: PDF },
    ]);
  });

  it('buildPhotoContent keeps its 0-based labels and closing reminder, for ids and typed inputs alike', () => {
    expect(buildPhotoContent([IMG, { storageObjectId: PDF, mimeType: 'application/pdf' }], 'Done.')).toEqual([
      { type: 'text', text: 'Photo 0:' },
      { type: 'image', storageObjectId: IMG, detail: 'high' },
      { type: 'text', text: 'Photo 1 (PDF document):' },
      { type: 'file', storageObjectId: PDF },
      { type: 'text', text: 'Done.' },
    ]);
  });

  it('chunking counts a PDF as one input, however many pages it has', () => {
    const inputs = Array.from({ length: 17 }, (_, i) => ({ storageObjectId: `${i}`, mimeType: 'application/pdf' }));

    expect(chunkPhotos(inputs).map((chunk) => chunk.length)).toEqual([16, 1]);
  });
});
