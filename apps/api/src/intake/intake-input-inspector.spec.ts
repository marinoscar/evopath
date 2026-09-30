import { plainPdf, PNG_BYTES } from './testing/pdf-bytes';
import { inMemoryInputInspector } from './testing/input-inspector.stub';

// =============================================================================
// IntakeInputInspector (H2, #186): reads the STORED bytes, bounded
// =============================================================================

describe('IntakeInputInspector', () => {
  it('reads only the head of an image and reports what the bytes are', async () => {
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]);
    const { inspector, download } = inMemoryInputInspector(new Map([['img', big], ['txt', Buffer.from('hello')]]), 256);

    await expect(inspector.inspect('img', 'image')).resolves.toEqual({ detected: 'image', pages: null, oversize: false });
    await expect(inspector.inspect('txt', 'image')).resolves.toEqual({ detected: null, pages: null, oversize: false });
    expect(download).toHaveBeenCalledWith('img');
  });

  it('reads a whole PDF and counts its pages', async () => {
    const { inspector } = inMemoryInputInspector(new Map([['doc', plainPdf(4)]]), 100);

    await expect(inspector.inspect('doc', 'pdf')).resolves.toEqual({ detected: 'pdf', pages: 4, oversize: false });
  });

  it('a file declared as a PDF whose bytes are not one is reported as such, with no page count', async () => {
    const { inspector } = inMemoryInputInspector(new Map([['renamed', Buffer.from('plain text renamed to report.pdf')]]));

    await expect(inspector.inspect('renamed', 'pdf')).resolves.toEqual({ detected: null, pages: null, oversize: false });
  });

  it('stops at the 50 MiB cap when the stored file is larger than its row claimed', async () => {
    const huge = Buffer.concat([plainPdf(1), Buffer.alloc(50 * 1024 * 1024)]);
    const { inspector } = inMemoryInputInspector(new Map([['huge', huge]]), 4 * 1024 * 1024);

    await expect(inspector.inspect('huge', 'pdf')).resolves.toMatchObject({ oversize: true, pages: null });
  });

  it('lets a storage failure propagate', async () => {
    const { inspector } = inMemoryInputInspector(new Map());

    await expect(inspector.inspect('missing', 'pdf')).rejects.toThrow('no object at missing');
  });
});
