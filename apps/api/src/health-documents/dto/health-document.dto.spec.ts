import {
  deleteHealthDocumentQuerySchema,
  downloadHealthDocumentQuerySchema,
  HEALTH_DOCUMENT_NAME_MAX,
  listHealthDocumentsQuerySchema,
  updateHealthDocumentSchema,
} from './health-document.dto';

// =============================================================================
// /api/health/documents request schemas (H6, #190)
// =============================================================================

describe('health document DTOs', () => {
  describe('list query', () => {
    it('defaults to newest upload first, page 1 of 20', () => {
      expect(listHealthDocumentsQuerySchema.parse({})).toEqual({
        sort: 'createdAt',
        order: 'desc',
        page: 1,
        pageSize: 20,
      });
    });

    it('accepts a kind, a documentDate sort and an order', () => {
      expect(
        listHealthDocumentsQuerySchema.parse({ kind: 'lab_report', sort: 'documentDate', order: 'asc', page: '2', pageSize: '5' }),
      ).toEqual({ kind: 'lab_report', sort: 'documentDate', order: 'asc', page: 2, pageSize: 5 });
    });

    it.each([{ kind: 'xray' }, { sort: 'name' }, { order: 'up' }, { pageSize: '101' }, { page: '0' }])(
      'refuses %o',
      (query) => {
        expect(listHealthDocumentsQuerySchema.safeParse(query).success).toBe(false);
      },
    );
  });

  it('download disposition defaults to inline and accepts attachment only otherwise', () => {
    expect(downloadHealthDocumentQuerySchema.parse({})).toEqual({ disposition: 'inline' });
    expect(downloadHealthDocumentQuerySchema.parse({ disposition: 'attachment' })).toEqual({ disposition: 'attachment' });
    expect(downloadHealthDocumentQuerySchema.safeParse({ disposition: 'form-data' }).success).toBe(false);
  });

  it('deleteValues is a strict query boolean, false by default', () => {
    expect(deleteHealthDocumentQuerySchema.parse({})).toEqual({ deleteValues: false });
    expect(deleteHealthDocumentQuerySchema.parse({ deleteValues: 'true' })).toEqual({ deleteValues: true });
    expect(deleteHealthDocumentQuerySchema.safeParse({ deleteValues: '1' }).success).toBe(false);
  });

  describe('update body', () => {
    it('sanitises the name', () => {
      expect(updateHealthDocumentSchema.parse({ originalName: '  my‮/report\n.pdf ' })).toEqual({
        originalName: 'my_report .pdf',
      });
    });

    it('refuses a name that is empty after sanitising, or too long', () => {
      expect(updateHealthDocumentSchema.safeParse({ originalName: ' \u0000 ' }).success).toBe(false);
      expect(updateHealthDocumentSchema.safeParse({ originalName: 'a'.repeat(HEALTH_DOCUMENT_NAME_MAX + 1) }).success).toBe(
        false,
      );
      expect(updateHealthDocumentSchema.safeParse({ originalName: 'a'.repeat(HEALTH_DOCUMENT_NAME_MAX) }).success).toBe(true);
    });

    it('sets or clears the document date', () => {
      expect(updateHealthDocumentSchema.parse({ documentDate: '2026-09-15' })).toEqual({ documentDate: '2026-09-15' });
      expect(updateHealthDocumentSchema.parse({ documentDate: null })).toEqual({ documentDate: null });
    });

    it.each(['2026-02-30', '15/09/2026', '1899-12-31', '2999-01-01'])('refuses documentDate %s', (documentDate) => {
      expect(updateHealthDocumentSchema.safeParse({ documentDate }).success).toBe(false);
    });

    it('refuses an empty body and unknown fields', () => {
      expect(updateHealthDocumentSchema.safeParse({}).success).toBe(false);
      expect(updateHealthDocumentSchema.safeParse({ retention: 'keep' }).success).toBe(false);
    });
  });
});
